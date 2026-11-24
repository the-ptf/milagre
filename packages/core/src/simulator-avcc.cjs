const TAG = { description: 0x01, keyframe: 0x02, delta: 0x03, seed: 0x04, meta: 0x05, alive: 0x06, ended: 0x07 };
const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;
const MAX_GROUP_BYTES = 6 * 1024 * 1024;
const MAX_BATCH_BYTES = 1_500_000;
const REPEAT_HEADER_BYTES = 5 + 16;
const PROFILES = {
  full: { h264Fps: 60, maxDimension: 1600, h264Bitrate: 6_000_000 },
  reduced: { h264Fps: 30, maxDimension: 960, h264Bitrate: 1_500_000 },
};

function envelope(tag, payload) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length + 1, 0);
  head[4] = tag;
  return Buffer.concat([head, payload]);
}

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
    buffer = Buffer.from(buffer);
    return envelopes;
  };
}

/**
 * The latest decodable group (configuration, keyframe, deltas) of a serve-sim AVCC stream, read by sequence.
 * A delta that repeats the previous one apart from its slice header (the encoders' idle floor re-sending a still
 * screen) is marked `repeat`: `read(after, { hold: true })` keeps a current viewer waiting while only repeats are new,
 * so a still screen sends nothing until the viewer's wait ends. `requestKeyframe`, when the source supports one, is
 * asked for a fresh keyframe instead of replaying a long group to a joining or lagging viewer.
 */
function createAvccRelay({ requestKeyframe = null, replayFrames = 30, maxGroupFrames = 300, keyframeWaitMs = 1000 } = {}) {
  let description = null,
    group = [],
    groupBytes = 0,
    sequence = 0,
    previous = null,
    keyframeAsked = 0,
    askedThisGroup = false,
    releasedUntil = 0,
    waiters = new Set();
  const wake = () => {
    for (const waiter of waiters) waiter();
    waiters = new Set();
  };
  const ask = () => {
    if (!requestKeyframe || (keyframeAsked && Date.now() - keyframeAsked < 5000)) return;
    keyframeAsked = Date.now();
    askedThisGroup = true;
    setTimeout(wake, keyframeWaitMs).unref?.();
    Promise.resolve()
      .then(requestKeyframe)
      .catch(() => {});
  };
  return {
    get sequence() {
      return sequence;
    },
    release(ms) {
      releasedUntil = Date.now() + ms;
      return sequence;
    },
    push(tag, bytes) {
      const copy = Buffer.from(bytes);
      if (tag === TAG.description) {
        description = { sequence: ++sequence, bytes: copy };
        group = [];
        groupBytes = 0;
        previous = null;
      } else if (tag === TAG.keyframe) {
        group = [{ sequence: ++sequence, bytes: copy }];
        groupBytes = copy.length;
        previous = null;
        keyframeAsked = 0;
        askedThisGroup = false;
      } else if (tag === TAG.delta) {
        if (!group.length) return;
        if (groupBytes + copy.length > MAX_GROUP_BYTES) {
          group = [];
          groupBytes = 0;
          previous = null;
          ask();
          return;
        }
        const repeat =
          !!previous &&
          previous.length === copy.length &&
          copy.length > REPEAT_HEADER_BYTES &&
          copy.subarray(REPEAT_HEADER_BYTES).equals(previous.subarray(REPEAT_HEADER_BYTES));
        previous = copy;
        group.push({ sequence: ++sequence, bytes: copy, repeat });
        groupBytes += copy.length;
        if (group.length > maxGroupFrames && !askedThisGroup) ask();
        if (repeat && Date.now() >= releasedUntil) return;
      } else return;
      wake();
    },
    read(after, { hold = false } = {}) {
      if (!description || !group.length) return null;
      const current = after >= group[0].sequence && after >= description.sequence;
      if (!current && group.length > replayFrames && requestKeyframe) {
        ask();
        if (Date.now() - keyframeAsked < keyframeWaitMs) return null;
      }
      const items = current ? group.filter((item) => item.sequence > after) : [description, ...group];
      if (!items.length || (current && hold && Date.now() >= releasedUntil && items.every((item) => item.repeat))) return null;
      let bytes = 0,
        count = 0;
      for (const item of items) {
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

/** Waits for the relay's next batch for a viewer, holding repeat-only batches until `signal` (the viewer's wait) ends. */
async function readAvcc(relay, after, signal, failed) {
  for (;;) {
    const failure = failed();
    if (failure) throw failure;
    const batch = relay.read(after, { hold: !signal.aborted });
    if (batch) return { sequence: batch.sequence, mimeType: "video/avcc", data: batch.data, ...(batch.reset ? { reset: true } : {}) };
    if (signal.aborted) return null;
    await relay.wait(signal);
  }
}

function splitAnnexB(data) {
  const units = [];
  let start = -1;
  for (let index = 0; index + 2 < data.length; index++) {
    if (data[index] !== 0 || data[index + 1] !== 0 || data[index + 2] !== 1) continue;
    if (start >= 0) units.push(data.subarray(start, index > start && data[index - 1] === 0 ? index - 1 : index));
    start = index + 3;
    index += 2;
  }
  if (start >= 0 && start < data.length) units.push(data.subarray(start));
  return units.filter((unit) => unit.length);
}

/** Turns serve-emu's Annex-B access units (SPS and PPS inline before each keyframe) into serve-sim AVCC envelopes. */
function createAnnexBConverter() {
  let sps = null,
    pps = null,
    described = null;
  return function convert(data) {
    const out = [],
      units = [];
    for (const unit of splitAnnexB(data)) {
      const type = unit[0] & 0x1f;
      if (type === 7) sps = Buffer.from(unit);
      else if (type === 8) pps = Buffer.from(unit);
      else if (type !== 9) units.push(unit);
    }
    const key = units.some((unit) => (unit[0] & 0x1f) === 5);
    if (key && sps && pps && sps.length >= 4) {
      const config = Buffer.concat([
        Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff]),
        sps,
        Buffer.from([1, pps.length >> 8, pps.length & 0xff]),
        pps,
      ]);
      if (!described?.equals(config)) {
        described = config;
        out.push({ tag: TAG.description, bytes: envelope(TAG.description, config) });
      }
    }
    if (!described || !units.some((unit) => [1, 5].includes(unit[0] & 0x1f))) return out;
    const payload = Buffer.concat(
      units.flatMap((unit) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(unit.length, 0);
        return [length, unit];
      }),
    );
    out.push({ tag: key ? TAG.keyframe : TAG.delta, bytes: envelope(key ? TAG.keyframe : TAG.delta, payload) });
    return out;
  };
}

/**
 * A local helper's H.264 stream for viewers. `start(sink, signal)` feeds envelopes through `sink.push(tag, bytes)`
 * and starts on the first read; a stream that ends or throws fails every reader.
 */
function createAvccFrames(start, { requestKeyframe, waitMs = 8000 } = {}) {
  const abort = new AbortController();
  const relay = createAvccRelay({ requestKeyframe });
  let failure = null,
    started = false;
  const fail = () => {
    if (failure || abort.signal.aborted) return;
    failure = new Error("Simulator video stream failed. Retry to reconnect.");
    relay.close();
  };
  return {
    discard: () => relay.release(3000),
    read(after, signal) {
      if (!started && !abort.signal.aborted) {
        started = true;
        Promise.resolve()
          .then(() => start({ push: (tag, bytes) => relay.push(tag, bytes) }, abort.signal))
          .then(fail, fail);
      }
      if (abort.signal.aborted || signal?.aborted) return Promise.resolve(null);
      const wait = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(waitMs)].filter(Boolean));
      return readAvcc(relay, after, wait, () => failure).then((frame) => (abort.signal.aborted ? null : frame));
    },
    close() {
      abort.abort();
      relay.close();
    },
  };
}

function streamAnnexB(url, token, sink, signal, opened) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, [`serve-emu.token.${token}`]);
    socket.binaryType = "arraybuffer";
    opened(socket);
    const convert = createAnnexBConverter();
    socket.addEventListener("message", ({ data }) => {
      if (data instanceof ArrayBuffer) for (const unit of convert(Buffer.from(data))) sink.push(unit.tag, unit.bytes);
    });
    socket.addEventListener("close", () => resolve());
    socket.addEventListener("error", () => reject(new Error("Android video connection failed.")));
    if (signal.aborted) socket.close(1000);
    else signal.addEventListener("abort", () => socket.close(1000), { once: true });
  });
}

/**
 * A local helper's H.264: serve-sim's stream.avcc, or serve-emu's Annex-B websocket converted to the same envelopes.
 * The encoder is one per device, so `configure` picks its profile for every viewer. serve-sim has no keyframe request:
 * changing its bitrate by one bit per second starts a new group. serve-emu takes `reset-video`.
 */
function createHelperVideo({ android, url, instance, apply, waitMs }) {
  const { token } = instance;
  let socket = null,
    profile = "full",
    nudge = 0,
    started = false;
  const frames = createAvccFrames(
    async (sink, signal) => {
      started = true;
      await apply(PROFILES[profile]).catch(() => {});
      const stop = AbortSignal.any([instance.abort.signal, signal]);
      if (stop.aborted) return;
      if (android) return streamAnnexB(url, token, sink, stop, (opened) => (socket = opened));
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: stop, redirect: "error" });
      if (!response.ok || !response.body) throw new Error("Invalid simulator stream.");
      const read = createEnvelopeReader();
      for await (const chunk of response.body) for (const unit of read(Buffer.from(chunk))) sink.push(unit.tag, unit.bytes);
    },
    {
      waitMs,
      requestKeyframe: () => {
        if (!android) return apply({ ...PROFILES[profile], h264Bitrate: PROFILES[profile].h264Bitrate + (nudge ^= 1) });
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "reset-video" }));
      },
    },
  );
  return {
    ...frames,
    configure(quality) {
      if (!Object.hasOwn(PROFILES, quality) || quality === profile) return;
      profile = quality;
      if (started) void apply(PROFILES[profile]).catch(() => {});
    },
  };
}

module.exports = { TAG, envelope, createEnvelopeReader, createAvccRelay, readAvcc, createAnnexBConverter, createAvccFrames, createHelperVideo, PROFILES };
