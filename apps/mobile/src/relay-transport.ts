import { fromB64url, phoneFinish, phoneHello, type Channel, type KeyPair } from "@milagre/shared/relay-crypto";
import { createAssembler, splitBody, type RelayMessage, type RelayRequest } from "@milagre/shared/relay-rpc";

export type RelaySocket = {
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data?: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
};
export type RelayTimers = { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (id: unknown) => void };
export type RelayResponse = { status: number; headers: Record<string, string>; body: Uint8Array };
type RelayLiveHandle = { close(): void };
export type RelayTransport = {
  request(method: "GET" | "POST", path: string, headers: Record<string, string>, body?: Uint8Array | string): Promise<RelayResponse>;
  /** Streams the bridge's live socket at `path`. `onStatus(true)` once subscribed, `onStatus(false)` when lost; it resubscribes by itself. */
  live(path: string, onData: (data: string) => void, onStatus: (up: boolean) => void): RelayLiveHandle;
  /** Opens the socket and finishes the hello now, instead of on the first request. */
  ready(): Promise<void>;
  /** Closes the socket, fails what is pending and forgets a refused pairing. The transport reconnects on its next use. */
  close(): void;
};
export type RelayTransportOptions = {
  /** The relay's WebSocket base, e.g. wss://relay.milagre.cloud. */
  relay: string;
  hostId: string;
  /** The Mac's box public key from the pairing code, base64url. Replies are accepted from this key only. */
  key: string;
  token: string;
  identity: KeyPair;
  /** What this phone calls itself; the Mac shows it in Settings › Devices. */
  name?: string | null;
  create?: (url: string) => RelaySocket;
  random?: (n: number) => Uint8Array;
  timers?: RelayTimers;
  /** A number in [0, 1) for the backoff jitter. */
  jitter?: () => number;
  /** An open socket was lost (dropped, silent, refused mid-session). Not called when close() ends it. */
  onLost?: () => void;
};

export type RelayErrorCode = "host-offline" | "bad-token" | "host-reset" | "unknown-phone" | "bad-host" | "lost";
export class RelayTransportError extends Error {
  code: RelayErrorCode;
  constructor(code: RelayErrorCode, message: string) {
    super(message);
    this.name = "RelayTransportError";
    this.code = code;
  }
}
const COPY: Record<RelayErrorCode, string> = {
  "host-offline": "Your Mac isn't reachable. Open Milagre on it and check Settings → Devices.",
  "bad-token": "This phone was paired with an older code. Scan the new one in Settings → Devices.",
  "host-reset": "This Mac was reset. Scan its new pairing code in Settings → Devices.",
  "unknown-phone": "Pairing is closed on your Mac. Open Settings → Devices on it and scan the code again.",
  "bad-host": "This isn't the Mac this phone was paired with. Scan the code again in Settings → Devices.",
  lost: "Connection lost. Reconnect to your computer. Check the Chat before sending again.",
};
const fail = (code: RelayErrorCode) => new RelayTransportError(code, COPY[code]);

const ACCEPT = 0x02,
  REFUSED = 0x04;
const CLOSE_HOST_OFFLINE = 4404;
const BACKOFF = [1000, 2000, 5000, 10000, 30000];
// Keepalive: the Mac answers a ping with a pong. Nothing heard for 45 s means the socket is dead (a network change leaves no close).
const PING = 20_000;
const SILENCE = 45_000;
const HANDSHAKE = 15_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const defaultTimers: RelayTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) };
const nativeSocket = (url: string) => new WebSocket(url) as unknown as RelaySocket;
const platformRandom = (n: number) => {
  if (!globalThis.crypto?.getRandomValues) throw new Error("No source of randomness for the relay handshake.");
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
};

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null; // a text frame: the relay only sends binary
}

type Pending = { resolve: (response: RelayResponse) => void; reject: (error: Error) => void };
type LiveState = {
  path: string;
  onData: (data: string) => void;
  onStatus: (up: boolean) => void;
  up: boolean;
  closed: boolean;
  failures: number;
  retry: unknown;
  conn: Conn | null;
  id: number;
};
/** An open, handshaken socket and what rides on it. */
type Conn = {
  socket: RelaySocket;
  channel: Channel;
  nextId: number;
  pending: Map<number, Pending>;
  lives: Map<number, LiveState>;
  assembler: ReturnType<typeof createAssembler>;
  ping: unknown;
  silence: unknown;
  end: (error: RelayTransportError, refused?: boolean) => void;
  over: boolean;
};

/**
 * One relay socket per paired Mac, opened on first use. Requests and live streams ride it as sealed frames;
 * a drop fails the requests in flight, and live streams resubscribe themselves after a backoff.
 */
export function createRelayTransport(options: RelayTransportOptions): RelayTransport {
  const { relay, hostId, token, identity, create = nativeSocket, random = platformRandom, timers = defaultTimers, jitter = Math.random } = options;
  const url = `${relay.replace(/\/+$/, "")}/v1/phone?id=${encodeURIComponent(hostId)}`;
  const lives = new Set<LiveState>();
  let conn: Conn | null = null;
  let connecting: Promise<Conn> | null = null;
  let abortConnect: ((error: RelayTransportError) => void) | null = null;
  /** Set when the Mac refused this phone for good; nothing reconnects until close(). */
  let refused: RelayTransportError | null = null;
  /** True while close() ends the socket, so that is not reported as a loss. */
  let closing = false;

  function teardown(c: Conn, error: RelayTransportError) {
    if (conn === c) conn = null;
    timers.clearTimeout(c.ping);
    timers.clearTimeout(c.silence);
    const pending = [...c.pending.values()];
    c.pending.clear();
    // A copy: down notifies subscribers that may close or open live streams.
    for (const live of Array.from(c.lives.values())) down(live, c, true);
    for (const request of pending) request.reject(error);
  }

  function send(c: Conn, message: RelayMessage) {
    if (c.over) return;
    try {
      c.socket.send(c.channel.seal(message));
    } catch {
      c.end(fail("lost"));
    }
  }

  const heard = (c: Conn) => {
    timers.clearTimeout(c.silence);
    c.silence = timers.setTimeout(() => c.end(fail("lost")), SILENCE);
  };

  function dispatch(c: Conn, message: RelayMessage) {
    switch (message?.t) {
      case "res": {
        const request = c.pending.get(message.id);
        if (!request) return;
        try {
          const done = c.assembler.add(message);
          if (!done.done) return;
          c.pending.delete(message.id);
          request.resolve({ status: done.status, headers: done.headers, body: done.body });
        } catch (error) {
          c.pending.delete(message.id);
          request.reject(error as Error);
        }
        return;
      }
      case "live": {
        const live = c.lives.get(message.id);
        if (!live || typeof message.data !== "string") return;
        live.failures = 0;
        live.onData(message.data);
        return;
      }
      case "live-close": {
        const live = c.lives.get(message.id);
        if (live) down(live, c, false);
        return;
      }
      case "ping":
        send(c, { t: "pong" });
        return;
      default:
        return; // pong, and anything newer than this app
    }
  }

  /** Opens the socket and runs the handshake; resolves once the Mac's accept is verified against the pinned key. */
  function open(): Promise<Conn> {
    return new Promise<Conn>((resolve, reject) => {
      let socket: RelaySocket;
      let hello: ReturnType<typeof phoneHello>;
      const host = fromB64url(options.key);
      try {
        socket = create(url);
        socket.binaryType = "arraybuffer";
        hello = phoneHello({ phone: identity, host, token, random, name: options.name ?? undefined });
      } catch {
        return reject(fail("lost"));
      }
      let c: Conn | null = null;
      let over = false;
      let handshake: unknown;
      const end = (error: RelayTransportError, refusal = false) => {
        if (over) return;
        over = true;
        timers.clearTimeout(handshake);
        abortConnect = abortConnect === end ? null : abortConnect;
        try {
          socket.close();
        } catch {
          /* already closed */
        }
        if (refusal) refused = error;
        if (c) {
          c.over = true;
          if (!closing) {
            try {
              options.onLost?.();
            } catch {
              /* the owner's bug must not leave the pending requests hanging */
            }
          }
          teardown(c, error);
        } else reject(error);
      };
      abortConnect = end;
      handshake = timers.setTimeout(() => end(fail("lost")), HANDSHAKE);
      socket.onopen = () => {
        if (!over) {
          try {
            socket.send(hello.message);
          } catch {
            end(fail("lost"));
          }
        }
      };
      // A failed socket always closes afterwards, with the code that says why.
      socket.onerror = () => {};
      socket.onclose = (event) => end(fail(event?.code === CLOSE_HOST_OFFLINE ? "host-offline" : "lost"));
      socket.onmessage = (event) => {
        if (over) return;
        const bytes = toBytes(event.data);
        if (!bytes || !bytes.length) return end(fail("lost"));
        if (c) {
          heard(c);
          try {
            dispatch(c, c.channel.open(bytes) as RelayMessage);
          } catch {
            end(fail("lost"));
          }
          return;
        }
        timers.clearTimeout(handshake);
        if (bytes[0] === REFUSED) {
          let refusal: { code?: unknown; reason?: unknown } | null = null;
          try {
            refusal = JSON.parse(decoder.decode(bytes.subarray(1)));
          } catch {
            /* a bad hello is treated as a drop */
          }
          // A Mac that was reset keeps its old room for a while only to say so; it sends `reason` with its bad-token.
          const code = refusal?.code === "bad-token" && refusal.reason === "reset" ? "host-reset" : refusal?.code;
          const final = code === "bad-token" || code === "host-reset" || code === "unknown-phone";
          return end(final ? fail(code) : fail("lost"), final);
        }
        if (bytes[0] !== ACCEPT) return end(fail("lost"));
        let channel: Channel;
        try {
          channel = phoneFinish({ ephemeral: hello.ephemeral, phone: identity, host, reply: bytes });
        } catch {
          return end(fail("bad-host"), true);
        }
        const next: Conn = {
          socket,
          channel,
          nextId: 1,
          pending: new Map(),
          lives: new Map(),
          assembler: createAssembler(),
          ping: undefined,
          silence: undefined,
          end,
          over: false,
        };
        c = next;
        conn = next;
        abortConnect = abortConnect === end ? null : abortConnect;
        heard(next);
        const tick = () => {
          if (next.over) return;
          send(next, { t: "ping" });
          next.ping = timers.setTimeout(tick, PING);
        };
        next.ping = timers.setTimeout(tick, PING);
        resolve(next);
      };
    });
  }

  function connect(): Promise<Conn> {
    if (refused) return Promise.reject(refused);
    if (conn) return Promise.resolve(conn);
    if (!connecting) {
      const attempt = open();
      connecting = attempt;
      const clear = () => {
        if (connecting === attempt) connecting = null;
      };
      attempt.then(clear, clear);
    }
    return connecting;
  }

  function subscribe(live: LiveState) {
    live.retry = undefined;
    if (live.closed) return;
    connect().then(
      (c) => {
        if (live.closed) return;
        if (c.over) return retryLater(live);
        live.id = c.nextId++;
        live.conn = c;
        c.lives.set(live.id, live);
        live.up = true;
        live.onStatus(true);
        send(c, { t: "live-open", id: live.id, path: live.path });
      },
      () => retryLater(live),
    );
  }

  function retryLater(live: LiveState) {
    // A refused phone has nothing to gain from asking again.
    if (live.closed || refused) return;
    const wait = (BACKOFF[Math.min(live.failures, BACKOFF.length - 1)] ?? 30000) * (0.8 + 0.4 * jitter());
    live.failures++;
    live.retry = timers.setTimeout(() => subscribe(live), wait);
  }

  /** A live stream lost its subscription: its socket went (`socketLost`) or the Mac closed just this stream. */
  function down(live: LiveState, c: Conn, socketLost: boolean) {
    c.lives.delete(live.id);
    live.conn = null;
    // A stream that was up when its socket dropped starts the backoff over; one the Mac keeps refusing does not.
    if (live.up && socketLost) live.failures = 0;
    if (live.up) {
      live.up = false;
      live.onStatus(false);
    }
    retryLater(live);
  }

  function request(method: "GET" | "POST", path: string, headers: Record<string, string>, body?: Uint8Array | string): Promise<RelayResponse> {
    const bytes = body === undefined ? new Uint8Array() : typeof body === "string" ? encoder.encode(body) : body;
    return connect().then(
      (c) =>
        new Promise<RelayResponse>((resolve, reject) => {
          if (c.over) return reject(fail("lost"));
          const id = c.nextId++;
          c.pending.set(id, { resolve, reject });
          const chunks = splitBody(bytes);
          chunks.forEach((chunk, index) => {
            const part: RelayRequest = { t: "req", id, method, path, headers, chunk, more: index < chunks.length - 1 };
            send(c, part);
          });
        }),
    );
  }

  return {
    request,
    ready: () => connect().then(() => undefined),
    live(path, onData, onStatus) {
      const live: LiveState = { path, onData, onStatus, up: false, closed: false, failures: 0, retry: undefined, conn: null, id: 0 };
      lives.add(live);
      subscribe(live);
      return {
        close() {
          if (live.closed) return;
          live.closed = true;
          lives.delete(live);
          timers.clearTimeout(live.retry);
          const c = live.conn;
          if (c) {
            c.lives.delete(live.id);
            live.conn = null;
            send(c, { t: "live-close", id: live.id });
          }
        },
      };
    },
    close() {
      closing = true;
      try {
        for (const live of lives) {
          live.closed = true;
          timers.clearTimeout(live.retry);
        }
        lives.clear();
        refused = null;
        const current = conn;
        conn = null;
        connecting = null;
        abortConnect?.(fail("lost"));
        current?.end(fail("lost"));
      } finally {
        // A consumer callback that throws during teardown must not leave later losses unreported.
        closing = false;
      }
    },
  };
}
