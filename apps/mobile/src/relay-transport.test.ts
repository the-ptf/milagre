import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { boxKeyPair, hostAccept, b64url, RelayAuthError, type Channel } from "@milagre/shared/relay-crypto";
import { createAssembler, splitBody, type RelayMessage } from "@milagre/shared/relay-rpc";
import { createRelayTransport, type RelaySocket, type RelayTimers } from "./relay-transport.ts";

const random = (n: number) => new Uint8Array(randomBytes(n));
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TOKEN = "a".repeat(64);
const OLDER_CODE = "This phone was paired with an older code. Scan the new one in Settings → Devices.";
const RESET = "This Mac was reset. Scan its new pairing code in Settings → Devices.";
const CLOSED_PAIRING = "Pairing is closed on your Mac. Open Settings → Devices on it and scan the code again.";
const OFFLINE = "Your Mac isn't reachable. Open Milagre on it and check Settings → Devices.";
const LOST = "Connection lost. Reconnect to your computer. Check the Chat before sending again.";
/** Everything queued as microtasks has run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

// Timers that only run when the test says so, recording each wait.
function clock() {
  const queue: { fn: () => void; ms: number }[] = [];
  const timers: RelayTimers = {
    setTimeout: (fn, ms) => {
      const timer = { fn, ms };
      queue.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      const index = queue.indexOf(timer as never);
      if (index !== -1) queue.splice(index, 1);
    },
  };
  const run = (ms: number) => {
    const index = queue.findIndex((timer) => timer.ms === ms);
    assert.ok(index !== -1, `No timer waiting ${ms}ms; waiting: ${queue.map((timer) => timer.ms).join(", ")}`);
    const [timer] = queue.splice(index, 1);
    assert.ok(timer !== undefined);
    timer.fn();
  };
  return { timers, run, queue };
}

type Answer = { status?: number; headers?: Record<string, string>; body?: Uint8Array | string } | "never";
type Seen = { method: string; path: string; headers: Record<string, string>; body: Uint8Array };
type Mode = "host" | "offline" | "bad-token" | "reset" | "unknown-phone" | "impostor";

/** A relay with a Mac behind it: each socket the phone opens gets its own hostAccept, as the daemon does per connection. */
function relay(answer: (seen: Seen) => Answer = () => ({ body: '{"v":1,"result":"pong"}' })) {
  const host = boxKeyPair(random);
  const sockets: FakeSocket[] = [];
  const seen: Seen[] = [];
  const sent: Uint8Array[] = [];
  const state = { mode: "host" as Mode, ping: 0, names: [] as (string | null)[] };
  class FakeSocket implements RelaySocket {
    binaryType = "blob";
    target = new EventTarget();
    addEventListener = this.target.addEventListener.bind(this.target) as RelaySocket["addEventListener"];
    emit(type: string, event = {}) {
      this.target.dispatchEvent(Object.assign(new Event(type), event));
    }
    open = true;
    closedByPhone?: number;
    channel?: Channel;
    lives = new Map<number, string>();
    uploads = createAssembler();
    parts = new Map<number, { method: string; path: string; headers: Record<string, string> }>();
    constructor() {
      queueMicrotask(() => {
        if (state.mode === "offline") return this.drop(4404);
        this.emit("open");
      });
    }
    // Frames leaving the phone.
    send(data: Uint8Array) {
      assert.ok(this.open, "the phone wrote to a closed socket");
      assert.ok(data.length <= 1024 * 1024, "a frame over the relay's 1 MiB limit");
      const bytes = new Uint8Array(data);
      sent.push(bytes);
      queueMicrotask(() => this.receive(bytes));
    }
    close(code?: number) {
      if (!this.open) return;
      this.closedByPhone = code ?? 1005;
      this.drop(code ?? 1005);
    }
    /** The relay (or the network) ends the socket. */
    drop(code: number) {
      if (!this.open) return;
      this.open = false;
      queueMicrotask(() => this.emit("close", { code }));
    }
    toPhone(bytes: Uint8Array) {
      if (!this.open) return;
      const copy = bytes.slice().buffer; // React Native hands the app an ArrayBuffer
      queueMicrotask(() => this.emit("message", { data: copy }));
    }
    say(message: RelayMessage) {
      this.toPhone(this.channel!.seal(message));
    }
    receive(bytes: Uint8Array) {
      if (!this.channel) {
        if (state.mode === "bad-token" || state.mode === "unknown-phone" || state.mode === "reset") {
          // A reset Mac's old room answers what the daemon's retired host sends.
          const refusal = state.mode === "reset" ? { t: "error", code: "bad-token", reason: "reset" } : { t: "error", code: state.mode };
          this.toPhone(new Uint8Array([0x04, ...encoder.encode(JSON.stringify(refusal))]));
          return void queueMicrotask(() => this.drop(1005));
        }
        try {
          const accepted = hostAccept({ host, hello: bytes, isKnown: () => true, token: TOKEN, random });
          state.names.push(accepted.name);
          this.channel = accepted.channel;
          // An impostor cannot read the hello, so the closest thing is a reply that was not sealed for this phone and host.
          if (state.mode === "impostor") {
            const last = accepted.reply.length - 1;
            const byte = accepted.reply[last];
            assert.ok(byte !== undefined);
            accepted.reply[last] = byte ^ 1;
          }
          this.toPhone(accepted.reply);
        } catch (error) {
          assert.ok(error instanceof RelayAuthError);
          this.drop(1005);
        }
        return;
      }
      const message = this.channel.open(bytes) as RelayMessage;
      if (message.t === "ping") {
        state.ping++;
        return this.say({ t: "pong" });
      }
      if (message.t === "live-open") {
        this.lives.set(message.id, message.path);
        return;
      }
      if (message.t === "live-close") {
        this.lives.delete(message.id);
        return;
      }
      if (message.t !== "req") return;
      if (!this.parts.has(message.id)) this.parts.set(message.id, { method: message.method, path: message.path, headers: message.headers });
      // The upload assembler is the response one with a different name: it concatenates chunks by id.
      const joined = this.uploads.add({ t: "res", id: message.id, status: 0, headers: {}, chunk: message.chunk, more: message.more });
      if (!joined.done) return;
      const meta = this.parts.get(message.id)!;
      this.parts.delete(message.id);
      const request: Seen = { ...meta, body: joined.body };
      seen.push(request);
      const reply = answer(request);
      if (reply === "never") return;
      const body = typeof reply.body === "string" ? encoder.encode(reply.body) : (reply.body ?? new Uint8Array());
      const chunks = splitBody(body);
      chunks.forEach((chunk, index) =>
        this.say({
          t: "res",
          id: message.id,
          status: reply.status ?? 200,
          headers: reply.headers ?? { "content-type": "application/json" },
          chunk,
          more: index < chunks.length - 1,
        }),
      );
    }
  }
  const create = (url: string) => {
    const socket = new FakeSocket();
    (socket as FakeSocket & { url?: string }).url = url;
    sockets.push(socket);
    return socket;
  };
  return { host, sockets, seen, sent, state, create };
}

function transportFor(fake: ReturnType<typeof relay>, extra: Partial<Parameters<typeof createRelayTransport>[0]> = {}) {
  const phone = boxKeyPair(random);
  const time = clock();
  const transport = createRelayTransport({
    relay: "wss://relay.milagre.cloud",
    hostId: "host-1",
    key: b64url(fake.host.publicKey),
    token: TOKEN,
    identity: phone,
    create: fake.create,
    random,
    timers: time.timers,
    jitter: () => 0.5,
    ...extra,
  });
  return { transport, phone, ...time };
}

const GET = (transport: ReturnType<typeof transportFor>["transport"], path = "/rpc/ping") => transport.request("GET", path, { Accept: "application/json" });

test("request round trip over the relay", async () => {
  const fake = relay();
  const { transport } = transportFor(fake);
  const response = await GET(transport);
  assert.equal(response.status, 200);
  assert.equal(decoder.decode(response.body), '{"v":1,"result":"pong"}');
  assert.deepEqual(response.headers, { "content-type": "application/json" });
  assert.equal(fake.sockets.length, 1);
  assert.equal((fake.sockets[0] as unknown as { url: string }).url, "wss://relay.milagre.cloud/v1/phone?id=host-1");
  assert.ok(fake.sockets[0] !== undefined);
  assert.equal(fake.sockets[0].binaryType, "arraybuffer");
  assert.deepEqual(
    fake.seen.map((request) => [request.method, request.path, request.headers, request.body.length]),
    [["GET", "/rpc/ping", { Accept: "application/json" }, 0]],
  );
  transport.close();
});

test("a JSON body travels as UTF-8 bytes", async () => {
  const fake = relay();
  const { transport } = transportFor(fake);
  await transport.request("POST", "/rpc/echo", { "Content-Type": "application/json" }, JSON.stringify({ text: "olá ✓" }));
  assert.ok(fake.seen[0] !== undefined);
  assert.equal(decoder.decode(fake.seen[0].body), '{"text":"olá ✓"}');
  assert.equal(fake.seen[0].method, "POST");
  transport.close();
});

test("host gone rejects pending requests, and the next request reconnects", async () => {
  const fake = relay((request) => (request.path === "/slow" ? "never" : { body: '"again"' }));
  const { transport } = transportFor(fake);
  const slow = GET(transport, "/slow");
  const failure = assert.rejects(slow, { message: LOST });
  await settle();
  assert.equal(fake.seen.length, 1, "the request reached the Mac");
  assert.ok(fake.sockets[0] !== undefined);
  fake.sockets[0].drop(4410);
  await failure;
  const response = await GET(transport, "/fast");
  assert.equal(decoder.decode(response.body), '"again"');
  assert.equal(fake.sockets.length, 2);
  transport.close();
});

test("a stale pairing says to scan again, and does not reconnect", async () => {
  const fake = relay();
  fake.state.mode = "bad-token";
  const { transport, queue } = transportFor(fake);
  await assert.rejects(GET(transport), { message: OLDER_CODE });
  await settle();
  assert.equal(queue.length, 0, "no retry timer");
  await assert.rejects(GET(transport), { message: OLDER_CODE });
  assert.equal(fake.sockets.length, 1, "later requests fail fast without a socket");
  // close() ends the repair state; a fixed Mac is reachable again.
  transport.close();
  fake.state.mode = "host";
  assert.equal((await GET(transport)).status, 200);
  assert.equal(fake.sockets.length, 2);
  transport.close();
});

test("a Mac that was reset says to scan its new code, and does not reconnect", async () => {
  const fake = relay();
  fake.state.mode = "reset";
  const { transport, queue } = transportFor(fake);
  await assert.rejects(GET(transport), { name: "RelayTransportError", code: "host-reset", message: RESET });
  await settle();
  assert.equal(queue.length, 0, "no retry timer");
  await assert.rejects(GET(transport), { message: RESET });
  assert.equal(fake.sockets.length, 1, "later requests fail fast without a socket");
  transport.close();
});

test("a phone the Mac does not know says pairing is closed", async () => {
  const fake = relay();
  fake.state.mode = "unknown-phone";
  const { transport } = transportFor(fake);
  await assert.rejects(GET(transport), { message: CLOSED_PAIRING });
  await assert.rejects(GET(transport), { message: CLOSED_PAIRING });
  assert.equal(fake.sockets.length, 1);
  transport.close();
});

test("host offline says to open Milagre", async () => {
  const fake = relay();
  fake.state.mode = "offline";
  const { transport } = transportFor(fake);
  await assert.rejects(GET(transport), { message: OFFLINE });
  fake.state.mode = "host";
  assert.equal((await GET(transport)).status, 200, "the next request tries again");
  assert.equal(fake.sockets.length, 2);
  transport.close();
});

test("a reply that is not from the pinned Mac is refused for good", async () => {
  const fake = relay();
  fake.state.mode = "impostor";
  const { transport } = transportFor(fake);
  await assert.rejects(GET(transport), /Scan the code again/);
  await assert.rejects(GET(transport), /Scan the code again/);
  assert.equal(fake.sockets.length, 1);
  transport.close();
});

test("one socket serves concurrent requests and a live stream", async () => {
  const fake = relay((request) => ({ body: JSON.stringify({ path: request.path }) }));
  const { transport } = transportFor(fake);
  const data: string[] = [];
  const status: boolean[] = [];
  const live = transport.live(
    "/live",
    (value) => data.push(value),
    (up) => status.push(up),
  );
  const [a, b, c] = await Promise.all([GET(transport, "/a"), GET(transport, "/b"), GET(transport, "/c")]);
  assert.deepEqual(
    [a, b, c].map((response) => JSON.parse(decoder.decode(response.body)).path),
    ["/a", "/b", "/c"],
  );
  assert.equal(fake.sockets.length, 1);
  assert.ok(fake.sockets[0] !== undefined);
  assert.deepEqual([...fake.sockets[0].lives.values()], ["/live"]);
  assert.deepEqual(status, [true]);
  const [id] = [...fake.sockets[0].lives.keys()];
  assert.ok(id !== undefined);
  fake.sockets[0].say({ t: "live", id, data: "runs" });
  fake.sockets[0].say({ t: "live", id: id + 99, data: "ignored" });
  await settle();
  assert.deepEqual(data, ["runs"]);
  live.close();
  await settle();
  assert.equal(fake.sockets[0].lives.size, 0, "the Mac is told to close the live");
  fake.sockets[0].say({ t: "live", id, data: "late" });
  await settle();
  assert.deepEqual(data, ["runs"]);
  transport.close();
});

test("an upload over several frames arrives whole", async () => {
  const fake = relay((request) => ({ body: JSON.stringify({ size: request.body.length }) }));
  const { transport } = transportFor(fake);
  const upload = random(3 * 1024 * 1024);
  const response = await transport.request("POST", "/rpc/upload", { "Content-Type": "application/octet-stream" }, upload);
  assert.equal(JSON.parse(decoder.decode(response.body)).size, upload.length);
  assert.ok(fake.seen[0] !== undefined);
  assert.deepEqual(fake.seen[0].body, upload);
  // hello + 12 chunks of 256 KiB, each under the relay's limit (the fake socket asserts it).
  assert.equal(fake.sent.length, 1 + 12);
  transport.close();
});

test("a refused upload is the Mac's answer, not an exception", async () => {
  const fake = relay(() => ({ status: 413, body: '{"v":1,"error":{"message":"Upload too large"}}' }));
  const { transport } = transportFor(fake);
  const response = await transport.request("POST", "/rpc/upload", {}, "x");
  assert.equal(response.status, 413);
  transport.close();
});

test("a response over several frames is assembled", async () => {
  const big = random(600 * 1024);
  const fake = relay(() => ({ body: big, headers: { "content-type": "application/octet-stream", etag: '"v1"' } }));
  const { transport } = transportFor(fake);
  const response = await GET(transport, "/big");
  assert.deepEqual(response.body, big);
  assert.equal(response.headers.etag, '"v1"');
  transport.close();
});

test("a live stream resubscribes after the socket drops, with backoff", async () => {
  const fake = relay();
  const { transport, run } = transportFor(fake);
  const data: string[] = [];
  const status: boolean[] = [];
  transport.live(
    "/live",
    (value) => data.push(value),
    (up) => status.push(up),
  );
  await settle();
  assert.deepEqual(status, [true]);
  assert.ok(fake.sockets[0] !== undefined);
  fake.sockets[0].drop(1006);
  await settle();
  assert.deepEqual(status, [true, false]);
  assert.equal(fake.sockets.length, 1, "waits for the backoff");
  run(1000); // jitter 0.5 is the exact wait
  await settle();
  assert.equal(fake.sockets.length, 2);
  assert.deepEqual(status, [true, false, true]);
  assert.ok(fake.sockets[1] !== undefined);
  const [id] = [...fake.sockets[1].lives.keys()];
  assert.ok(id !== undefined);
  fake.sockets[1].say({ t: "live", id, data: "project" });
  await settle();
  assert.deepEqual(data, ["project"]);
  // A Mac that stays offline is asked less and less often.
  fake.state.mode = "offline";
  fake.sockets[1].drop(4410);
  await settle();
  for (const wait of [1000, 2000, 5000, 10000, 30000, 30000]) {
    run(wait);
    await settle();
  }
  assert.equal(fake.sockets.length, 2 + 6);
  transport.close();
});

test("a refused live (too many on one connection) retries later", async () => {
  const fake = relay();
  const { transport, run } = transportFor(fake);
  const status: boolean[] = [];
  transport.live(
    "/live",
    () => {},
    (up) => status.push(up),
  );
  await settle();
  assert.ok(fake.sockets[0] !== undefined);
  const [id] = [...fake.sockets[0].lives.keys()];
  assert.ok(id !== undefined);
  fake.sockets[0].say({ t: "live-close", id, code: 1013 });
  await settle();
  assert.deepEqual(status, [true, false]);
  run(1000);
  await settle();
  assert.deepEqual(status, [true, false, true]);
  assert.equal(fake.sockets.length, 1, "same socket");
  transport.close();
});

test("a pairing refused while a live is open stops the live from retrying", async () => {
  const fake = relay();
  const { transport, queue } = transportFor(fake);
  const status: boolean[] = [];
  transport.live(
    "/live",
    () => {},
    (up) => status.push(up),
  );
  await settle();
  fake.state.mode = "unknown-phone";
  assert.ok(fake.sockets[0] !== undefined);
  fake.sockets[0].drop(1006);
  await settle();
  const retry = queue.find((timer) => timer.ms === 1000);
  assert.ok(retry);
  retry.fn();
  await settle();
  assert.equal(
    queue.some((timer) => timer.ms === 2000),
    false,
    "no further retries after a refusal",
  );
  assert.deepEqual(status, [true, false]);
  transport.close();
});

test("pings go out every 20 s and a socket silent for 45 s is dropped", async () => {
  const fake = relay();
  const { transport, run, queue } = transportFor(fake);
  await GET(transport);
  run(20000);
  await settle();
  assert.equal(fake.state.ping, 1);
  assert.ok(
    queue.some((timer) => timer.ms === 20000),
    "the next ping is scheduled",
  );
  // The pong restarted the silence timer, so the socket is still alive.
  assert.ok(fake.sockets[0] !== undefined);
  assert.equal(fake.sockets[0].open, true);
  // A Mac that never answers: the silence timer fires, the request fails and the socket is closed.
  const silent = relay(() => "never");
  const quiet = transportFor(silent);
  const hang = quiet.transport.request("GET", "/x", {});
  await settle();
  quiet.run(45000);
  await assert.rejects(hang, { message: LOST });
  assert.ok(silent.sockets[0] !== undefined);
  assert.equal(silent.sockets[0].open, false);
  assert.equal(quiet.queue.length, 0, "a dead socket leaves no timers");
  transport.close();
});

test("a ping timer that fires after its socket ended schedules nothing", async () => {
  const fake = relay();
  const { transport, queue } = transportFor(fake);
  await GET(transport);
  const ping = queue.find((timer) => timer.ms === 20000);
  assert.ok(ping, "a ping is scheduled");
  transport.close();
  assert.equal(queue.length, 0);
  // The timer was already on its way out when the socket ended.
  ping.fn();
  assert.equal(queue.length, 0, "a dead connection keeps no ping timer");
});

test("close() rejects what is pending and leaves nothing running", async () => {
  const fake = relay(() => "never");
  const { transport, queue } = transportFor(fake);
  const hang = transport.request("GET", "/x", {});
  await settle();
  transport.close();
  await assert.rejects(hang, { message: LOST });
  assert.ok(fake.sockets[0] !== undefined);
  assert.equal(fake.sockets[0].closedByPhone !== undefined, true);
  assert.equal(queue.length, 0);
});

test("the hello is for the pinned Mac and names this phone", async () => {
  const fake = relay();
  const { transport, phone } = transportFor(fake);
  await GET(transport);
  assert.ok(fake.sent[0] !== undefined);
  assert.equal(fake.sent[0][0], 0x01);
  assert.deepEqual(fake.sent[0].slice(33, 65), phone.publicKey);
  transport.close();
});

test("ready() handshakes once; onLost fires when the socket drops, not on close()", async () => {
  const fake = relay();
  let lost = 0;
  const { transport } = transportFor(fake, { onLost: () => lost++ });
  const hellos = () => fake.sent.filter((frame) => frame[0] === 0x01).length;
  await transport.ready();
  assert.equal(hellos(), 1);
  await transport.ready();
  assert.equal(hellos(), 1);
  assert.equal(lost, 0);
  assert.ok(fake.sockets[0] !== undefined);
  fake.sockets[0].drop(1006);
  await settle();
  assert.equal(lost, 1);
  await transport.ready();
  assert.equal(hellos(), 2);
  transport.close();
  await settle();
  assert.equal(lost, 1, "close() is not a loss");
});

test("onLost is not called for a failed handshake", async () => {
  const fake = relay();
  fake.state.mode = "bad-token";
  let lost = 0;
  const { transport } = transportFor(fake, { onLost: () => lost++ });
  await assert.rejects(transport.ready(), { message: OLDER_CODE });
  await settle();
  assert.equal(lost, 0);
  transport.close();
});

test("a throwing consumer during close() does not leave the transport unable to report a later loss", async () => {
  const fake = relay();
  let lost = 0;
  const { transport } = transportFor(fake, { onLost: () => lost++ });
  transport.live(
    "/live",
    () => {},
    (up) => {
      if (!up) throw new Error("consumer bug");
    },
  );
  await settle();
  assert.throws(() => transport.close(), /consumer bug/);
  await transport.ready();
  fake.sockets.at(-1)!.drop(1006);
  await settle();
  assert.equal(lost, 1, "the closing flag must not stay set after a throwing close()");
  transport.close();
});

test("an onLost that throws cannot skip the teardown: what was pending still fails", async () => {
  const fake = relay(() => "never");
  const { transport } = transportFor(fake, {
    onLost: () => {
      throw new Error("supervisor bug");
    },
  });
  const pending = GET(transport);
  await settle();
  assert.ok(fake.sockets[0] !== undefined);
  fake.sockets[0].drop(1006);
  await assert.rejects(pending, { message: LOST });
  transport.close();
});

test("the hello carries the phone's name when it has one", async () => {
  const fake = relay();
  const named = transportFor(fake, { name: "Victor's iPhone" });
  await named.transport.ready();
  named.transport.close();
  const unnamed = transportFor(fake);
  await unnamed.transport.ready();
  unnamed.transport.close();
  assert.deepEqual(fake.state.names, ["Victor's iPhone", null]);
});
