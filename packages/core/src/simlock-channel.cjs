const { packet } = require("./simulators-helper.cjs");

// A Simlock lease's screen is serve-sim's AVCC envelopes, `[len u32 BE][tag u8][payload]` with `len` counting the tag,
// and its input is serve-sim's tagged messages on a WebSocket. Both take the agent token, which stays on the host.

const TAG = { description: 0x01, keyframe: 0x02, delta: 0x03, seed: 0x04, meta: 0x05, alive: 0x06, ended: 0x07 };
const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;
// A group of pictures past this is dropped until the next keyframe; a viewer then restarts from that keyframe.
const MAX_GROUP_BYTES = 6 * 1024 * 1024;
// A relayed batch must stay under the receiver's 2 MiB of base64 per frame request.
const MAX_BATCH_BYTES = 1_500_000;
const ENDED = { explicit: "The device was returned to the Simlock pool.", expired: "The Simlock lease expired.", "device-lost": "Simlock lost the device." };

/** Splits a byte stream into envelopes; a malformed length ends the stream rather than decoding blind. */
function createEnvelopeReader() {
  let buffer = Buffer.alloc(0);
  return function push(chunk) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
    const envelopes = [];
    while (buffer.length >= 5) {
      const length = buffer.readUInt32BE(0);
      if (length < 1 || length > MAX_ENVELOPE_BYTES) throw new Error("The Simlock stream is not a frame envelope stream.");
      if (buffer.length < 4 + length) break;
      envelopes.push({ tag: buffer[4], bytes: buffer.subarray(0, 4 + length), payload: buffer.subarray(5, 4 + length) });
      buffer = buffer.subarray(4 + length);
    }
    // Detach retained bytes from the chunk they came in.
    buffer = Buffer.from(buffer);
    return envelopes;
  };
}

/**
 * Keeps the decoder configuration and the current group of pictures, numbered. A viewer that is current gets the
 * envelopes after its last one; a viewer that fell behind a keyframe gets the configuration and the whole group again.
 */
function createAvccRelay() {
  let description = null,
    group = [],
    groupBytes = 0,
    sequence = 0,
    waiters = new Set();
  const wake = () => {
    for (const waiter of waiters) waiter();
    waiters = new Set();
  };
  return {
    push(tag, bytes) {
      const copy = Buffer.from(bytes);
      if (tag === TAG.description) {
        description = { sequence: ++sequence, bytes: copy };
        group = [];
        groupBytes = 0;
      } else if (tag === TAG.keyframe) {
        group = [{ sequence: ++sequence, bytes: copy }];
        groupBytes = copy.length;
      } else if (tag === TAG.delta) {
        if (!group.length) return;
        if (groupBytes + copy.length > MAX_GROUP_BYTES) {
          group = [];
          groupBytes = 0;
          return;
        }
        group.push({ sequence: ++sequence, bytes: copy });
        groupBytes += copy.length;
      } else return;
      wake();
    },
    /** Envelopes for a viewer whose last relayed sequence is `after`, or null when there is nothing new to decode. */
    read(after) {
      if (!description || !group.length) return null;
      const current = after >= group[0].sequence && after >= description.sequence;
      const items = current ? group.filter((item) => item.sequence > after) : [description, ...group];
      if (!items.length) return null;
      let bytes = 0,
        count = 0;
      for (const item of items) {
        // A reset batch always carries the configuration and the keyframe, so a decoder can start from it.
        if (count >= (current ? 1 : 2) && bytes + item.bytes.length > MAX_BATCH_BYTES) break;
        bytes += item.bytes.length;
        count++;
      }
      const sent = items.slice(0, count);
      return { sequence: sent.at(-1).sequence, reset: !current, data: Buffer.concat(sent.map((item) => item.bytes)).toString("base64") };
    },
    wait(signal) {
      return new Promise((resolve) => {
        const done = () => {
          waiters.delete(done);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        waiters.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    },
    close: wake,
  };
}

/** One lease's screen and input, as a simulator channel. `upstream` holds the URLs and the token header. */
function createSimlockChannel(upstream, { fetch: fetchImpl = globalThis.fetch, WebSocket = require("ws"), frameWaitMs = 20000 } = {}) {
  const abort = new AbortController();
  const relay = createAvccRelay();
  const state = { width: 0, height: 0, orientation: "portrait", admitted: false, error: null, keyboardUnavailable: false };
  let socket = null,
    closed = false;

  const fail = (message) => {
    if (closed || state.error) return;
    state.error = message;
    relay.close();
  };

  void (async () => {
    try {
      const response = await fetchImpl(upstream.stream, { headers: upstream.headers, signal: abort.signal });
      if (!response.ok || !response.body) {
        let reason = `The Simlock stream answered HTTP ${response.status}.`;
        try {
          const body = await response.json();
          if (typeof body?.error?.message === "string") reason = `Simlock could not stream this device: ${body.error.message.slice(0, 300)}`;
        } catch {}
        return fail(reason);
      }
      const push = createEnvelopeReader();
      for await (const chunk of response.body) {
        for (const envelope of push(Buffer.from(chunk))) {
          if (envelope.tag === TAG.meta) {
            try {
              const meta = JSON.parse(envelope.payload.toString("utf8"));
              if (meta?.codec !== "h264") return fail(`Milagre cannot show Simlock's ${String(meta?.codec).slice(0, 20)} stream.`);
              // The input socket's configuration names the device's real size; the picture's size is only a fallback.
              if (!state.width && Number.isInteger(meta.width) && Number.isInteger(meta.height))
                Object.assign(state, { width: meta.width, height: meta.height });
            } catch {
              return fail("The Simlock stream sent an unreadable description.");
            }
          } else if (envelope.tag === TAG.ended) {
            let reason = "";
            try {
              reason = JSON.parse(envelope.payload.toString("utf8"))?.reason;
            } catch {}
            return fail(ENDED[reason] ?? "The Simlock lease ended.");
          } else relay.push(envelope.tag, envelope.bytes);
        }
      }
      fail("The Simlock stream stopped. Retry to reconnect.");
    } catch (error) {
      if (!abort.signal.aborted) fail(error?.message?.startsWith("The Simlock") ? error.message : "The Simlock stream stopped. Retry to reconnect.");
    }
  })();

  try {
    socket = new WebSocket(upstream.input, { headers: upstream.headers, handshakeTimeout: 15000, maxPayload: 1_048_576 });
    socket.binaryType = "nodebuffer";
    socket.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const bytes = Buffer.from(data);
      if (bytes[0] === 0x83) state.admitted = true;
      else if (bytes[0] === 0x82) {
        try {
          const config = JSON.parse(bytes.subarray(1).toString("utf8"));
          if (Number.isInteger(config.width) && config.width > 0 && Number.isInteger(config.height) && config.height > 0)
            Object.assign(state, { width: config.width, height: config.height });
          if (typeof config.orientation === "string") state.orientation = config.orientation.replaceAll("_", "-");
          state.keyboardUnavailable = config.keyboardUnavailable === true;
        } catch {}
      }
    });
    socket.on("unexpected-response", (_request, response) => {
      fail(
        response.statusCode === 404
          ? "Simlock does not take input for this lease. Turn on capabilities.input.enabled on the gateway and its workers."
          : `Simlock refused input (HTTP ${response.statusCode}).`,
      );
      response.resume();
    });
    socket.on("error", () => fail("The Simlock input connection failed. Retry to reconnect."));
    socket.on("close", () => {
      if (!closed) fail("The Simlock input connection closed. Retry to reconnect.");
    });
  } catch {
    fail("The Simlock input connection failed. Retry to reconnect.");
  }

  return {
    async frame(after, signal) {
      const deadline = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(frameWaitMs)].filter(Boolean));
      for (;;) {
        if (state.error) throw new Error(state.error);
        const batch = relay.read(after);
        if (batch) return { sequence: batch.sequence, mimeType: "video/avcc", data: batch.data, ...(batch.reset ? { reset: true } : {}) };
        if (deadline.aborted) return null;
        await relay.wait(deadline);
      }
    },
    status() {
      const orientation = ["portrait", "portrait-upside-down", "landscape-left", "landscape-right"].includes(state.orientation)
        ? state.orientation
        : "portrait";
      return {
        width: state.width || 1,
        height: state.height || 1,
        orientation,
        ready: state.admitted && state.width > 0 && !state.error,
        ...(state.error ? { error: state.error } : {}),
      };
    },
    send(event) {
      if (state.error) throw new Error(state.error);
      if (!socket || socket.readyState !== 1 || socket.bufferedAmount > 16384) throw new Error("Simlock input is not connected.");
      if (event.kind === "pose" || event.kind === "hinge") throw new Error("Simlock devices do not take hinge controls.");
      const [tag, payload] = packet(event);
      socket.send(Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(payload))]));
    },
    async close() {
      closed = true;
      abort.abort();
      relay.close();
      try {
        socket?.close();
      } catch {}
    },
  };
}

/** Adds leased devices to another simulator adapter; ids under `simlock:` go to the lease, the rest to `local`. */
function withSimlock(local, host, channelOptions) {
  return {
    iceServers: local.iceServers,
    async list() {
      const leased = host.leases().map((lease) => ({ id: lease.deviceId, name: `${lease.name} (Simlock)`, platform: lease.platform, version: lease.version }));
      try {
        return [...(await local.list()), ...leased];
      } catch (error) {
        if (leased.length) return leased;
        throw error;
      }
    },
    async connect(id) {
      if (!host.isDevice(id)) return local.connect(id);
      const upstream = host.upstream(id);
      if (!upstream) throw new Error("That Simlock lease has ended.");
      return createSimlockChannel(upstream, channelOptions);
    },
    async offer(id, ...args) {
      if (host.isDevice(id)) throw new Error("Simlock devices stream through Milagre only.");
      return local.offer(id, ...args);
    },
    async closeViewer(id, ...args) {
      if (!host.isDevice(id)) return local.closeViewer(id, ...args);
    },
    async repairInput(id) {
      if (host.isDevice(id)) throw new Error("Input repair is not available for Simlock devices. Return the device and lease another.");
      return local.repairInput(id);
    },
    async stop() {
      await Promise.all([local.stop(), host.stop()]);
    },
  };
}

module.exports = { createSimlockChannel, createAvccRelay, createEnvelopeReader, withSimlock, TAG };
