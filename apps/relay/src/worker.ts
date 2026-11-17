import { createRoom, type Room as RoomLogic } from "./room.mjs";
import { createHookDirectory, createHookRoom, handleHookRequest, hookResponse, sqlHookStorage, unpackHookRequest, NOT_FOUND, type HookRoom } from "./hooks.mjs";

export interface Env {
  ROOMS: DurableObjectNamespace;
  HOOKS: DurableObjectNamespace;
  DIAG?: AnalyticsEngineDataset;
}
const ID = /^[A-Za-z0-9_-]{22}$/;
const HOOK_ID = /^[0-9a-f]{64}$/;
const INTERNAL = "https://relay.internal";
// Bumping the generation moves every Mac into a fresh object; its hooks re-register on the next HOOK_SET.
const ROOM_GENERATION = "r2";
const roomOf = (env: Env, id: string) => env.ROOMS.get(env.ROOMS.idFromName(`${ROOM_GENERATION}:${id}`));

async function lookupRoom(env: Env, hookId: string): Promise<string | null> {
  const owner = await env.HOOKS.get(env.HOOKS.idFromName(hookId)).fetch(`${INTERNAL}/room`);
  const roomId = owner.ok ? await owner.text() : "";
  return ID.test(roomId) ? roomId : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname.startsWith("/hook/"))
      return handleHookRequest(request, {
        lookupRoom: (hookId) => lookupRoom(env, hookId),
        forwardToRoom: (roomId, hookId, packed) =>
          roomOf(env, roomId).fetch(`${INTERNAL}/hook`, { method: "POST", headers: { "x-milagre-hook": hookId }, body: packed }),
      });
    const role = url.pathname === "/v1/host" ? "host" : url.pathname === "/v1/phone" ? "phone" : null;
    if (!role) return new Response("Not found", { status: 404 });
    if (!ID.test(url.searchParams.get("id") ?? "")) return new Response("Bad id", { status: 400 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const id = url.searchParams.get("id")!;
    const answer = await roomOf(env, id).fetch(request);
    const refusal = answer.status === 101 ? null : parseRefusal(answer.headers.get(REFUSAL_HEADER));
    return refusal ? closedSocket(refusal) : answer;
  },
};

// A room turns a phone away with a plain HTTP answer naming the close code, and the Worker closes its own socket with
// it. A socket the room accepted itself, even only to close it, keeps the room in memory until the close completes:
// a paired desktop redialing a sleeping Mac every 30 s kept that Mac's room awake all day (2026-11-10, the daily
// duration limit). The phone still sees the same 4404/4429 close as before.
const REFUSAL_HEADER = "x-milagre-refusal";

type Refusal = { code: number; reason: string };

function parseRefusal(value: string | null): Refusal | null {
  const match = /^(4\d{3}) ([a-z-]{1,40})$/.exec(value ?? "");
  return match ? { code: Number(match[1]), reason: match[2]! } : null;
}

function refusalAnswer({ code, reason }: Refusal): Response {
  return new Response(null, { status: 409, headers: { [REFUSAL_HEADER]: `${code} ${reason}` } });
}

function closedSocket({ code, reason }: Refusal): Response {
  const [client, server] = Object.values(new WebSocketPair());
  if (!client || !server) throw new Error("WebSocketPair did not yield two sockets");
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

type Role = "host" | "phone";

/**
 * One Mac's room, on the WebSocket Hibernation API: while nobody sends anything the runtime may
 * evict the object and keep the sockets open, so an idle Mac costs no duration. The Mac's
 * keepalive is protocol-level ping frames, which the runtime answers without waking the object;
 * there is deliberately no setWebSocketAutoResponse.
 *
 * Nothing lives only in memory: each socket carries its role as a tag and the room's mark for it
 * as its attachment, and the room id sits in storage. Every entry point goes through `live()`,
 * which rebuilds the room from those after an eviction.
 */
export class Room implements DurableObject {
  private room?: RoomLogic;
  private roomId = "";
  private hookRoom?: HookRoom;
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.diag("construct", "");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/hook") return this.hookDelivery(request);
    const id = url.searchParams.get("id")!;
    const role: Role = url.pathname === "/v1/host" ? "host" : "phone";
    const woke = !this.room;
    const kv = this.state.storage.kv;
    if (kv.get("id") !== id) kv.put("id", id);
    if (this.room && this.roomId !== id) this.room = undefined;
    const room = this.live();
    const refusal = role === "phone" ? room.phoneRefusal() : null;
    this.diag(refusal ? "refuse" : "open", role, { woke });
    if (refusal) return refusalAnswer(refusal);
    const [client, server] = Object.values(new WebSocketPair());
    if (!client || !server) throw new Error("WebSocketPair did not yield two sockets");
    // Hibernatable sockets hand binary over as an ArrayBuffer, which the room reads with its brand check.
    this.state.acceptWebSocket(server, [role]);
    if (role === "host") room.hostOpened(server);
    else room.phoneOpened(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const woke = !this.room;
    const started = Date.now();
    const room = this.live();
    const role = this.roleOf(ws);
    if (role === "host") await room.hostMessage(ws, message);
    else room.phoneMessage(ws, message);
    this.diag("message", `${role}:${frameKind(message)}`, {
      woke,
      ms: Date.now() - started,
      size: typeof message === "string" ? message.length : message.byteLength,
    });
  }

  async alarm(): Promise<void> {
    this.diag("alarm", "");
    const next = this.hooks().expire(Date.now());
    if (next !== null) await this.state.storage.setAlarm(next);
  }

  private async hookDelivery(request: Request): Promise<Response> {
    const hookId = request.headers.get("x-milagre-hook") ?? "";
    if (!HOOK_ID.test(hookId)) return hookResponse(NOT_FOUND);
    let delivery;
    try {
      delivery = unpackHookRequest(new Uint8Array(await request.arrayBuffer()));
    } catch {
      return hookResponse(NOT_FOUND);
    }
    this.diag("hook", "", { woke: !this.room });
    this.live();
    const answer = this.hooks().receive(hookId, delivery);
    if (answer.status === 202 && (await this.state.storage.getAlarm()) === null) {
      const next = this.hooks().expire(Date.now());
      if (next !== null) await this.state.storage.setAlarm(next);
    }
    return hookResponse(answer);
  }

  private hooks(): HookRoom {
    if (this.hookRoom) return this.hookRoom;
    const storage = sqlHookStorage(this.state.storage.sql);
    const directory = {
      claim: async (hookId: string, roomId: string, ownerKey?: string) => {
        if (!ID.test(roomId)) return false;
        const response = await this.env.HOOKS.get(this.env.HOOKS.idFromName(hookId)).fetch(`${INTERNAL}/claim`, {
          method: "POST",
          body: JSON.stringify({ roomId, ...(ownerKey ? { ownerKey } : {}) }),
        });
        if (response.status === 409) return false;
        if (!response.ok) throw new Error(`Hook directory answered ${response.status}`);
        return true;
      },
      release: async (hookId: string, roomId: string) => {
        await this.env.HOOKS.get(this.env.HOOKS.idFromName(hookId)).fetch(`${INTERNAL}/release`, { method: "POST", body: roomId });
      },
    };
    return (this.hookRoom = createHookRoom({
      storage,
      directory,
      roomId: () => this.state.storage.kv.get<string>("id") ?? "",
      send: (bytes) => this.room?.sendHost(bytes) ?? false,
    }));
  }

  webSocketClose(ws: WebSocket, code: number, _reason: string, wasClean: boolean): void {
    this.diag("close", `${this.roleOf(ws)}:${code}:${wasClean ? "clean" : "unclean"}`, { woke: !this.room });
    this.closed(ws);
    // The compatibility date turns on web_socket_auto_reply_to_close, so the runtime has already answered
    // the peer's Close frame; closing back is only a fallback and throws if the socket is already closed.
    if (ws.readyState !== WebSocket.READY_STATE_CLOSED) {
      try {
        ws.close(1000, "closed");
      } catch {
        /* already closed */
      }
    }
  }

  webSocketError(ws: WebSocket, _error: unknown): void {
    this.diag("error", `${this.roleOf(ws)}`, { woke: !this.room });
    this.closed(ws);
    try {
      ws.close(1011, "error");
    } catch {
      /* already closed */
    }
  }

  private readonly born = Date.now();
  private lastMessageDiag = 0;

  /**
   * One Analytics Engine point per room event (no payloads, URLs or room ids: only this object's id prefix, the event
   * kind and timings), to see what keeps a hibernatable room in memory. Plain message frames are sampled once per 10 s
   * per room so a busy relay stays within the free tier's daily points.
   */
  private diag(kind: string, detail: string, { woke = false, ms = 0, size = 0 } = {}): void {
    const dataset = this.env.DIAG;
    if (!dataset) return;
    const now = Date.now();
    if (kind === "message" && !woke && ms === 0 && !detail.endsWith(":text") && !detail.includes(":c0-") && now - this.lastMessageDiag < 10_000) return;
    if (kind === "message") this.lastMessageDiag = now;
    try {
      const sockets = this.state.getWebSockets();
      let hosts = 0;
      for (const socket of sockets) if (this.roleOf(socket) === "host") hosts++;
      const object = this.state.id.toString().slice(0, 8);
      dataset.writeDataPoint({ indexes: [object], blobs: [object, kind, detail], doubles: [woke ? 1 : 0, ms, sockets.length, hosts, size, now - this.born] });
    } catch {
      /* diagnostics never break a room */
    }
  }

  private closed(ws: WebSocket): void {
    const room = this.live(ws);
    if (this.roleOf(ws) === "host") room.hostClosed(ws);
    else room.phoneClosed(ws);
  }

  private live(ending?: WebSocket): RoomLogic {
    if (this.room) return this.room;
    const id = this.state.storage.kv.get<string>("id") ?? "";
    const room = createRoom({
      id,
      mark: (socket, state) => (socket as WebSocket).serializeAttachment(state),
      onHostReady: () => this.hooks().onHostReady(),
      onHostFrame: (type, payload) => this.hooks().onFrame(type, payload),
    });
    const sockets = this.state.getWebSockets();
    if (ending && !sockets.includes(ending)) sockets.unshift(ending);
    room.restore(sockets.map((ws) => ({ socket: ws, state: this.stateOf(ws) })));
    this.roomId = id;
    return (this.room = room);
  }

  private stateOf(ws: WebSocket): unknown {
    const state: unknown = ws.deserializeAttachment();
    const role = state && typeof state === "object" ? (state as { role?: unknown }).role : undefined;
    const tag: Role | null = role === "host" || role === "pending" ? "host" : role === "phone" ? "phone" : null;
    return tag && tag === this.roleOf(ws) ? state : null;
  }

  private roleOf(ws: WebSocket): Role | null {
    let tags: string[];
    try {
      tags = this.state.getTags(ws);
    } catch {
      return null;
    }
    return tags.includes("host") ? "host" : tags.includes("phone") ? "phone" : null;
  }
}

export class HookDirectory implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const directory = createHookDirectory({ storage: this.state.storage.kv });
    const path = new URL(request.url).pathname;
    if (path === "/room") {
      const room = directory.room();
      return room ? new Response(room) : new Response("", { status: 404 });
    }
    if (path === "/claim") {
      let body: { roomId?: unknown; ownerKey?: unknown } = {};
      try {
        body = request.method === "POST" ? await request.json() : {};
      } catch {
        return new Response("", { status: 400 });
      }
      const roomId = typeof body.roomId === "string" ? body.roomId : "";
      if (!ID.test(roomId)) return new Response("", { status: 400 });
      const proof = typeof body.ownerKey === "string" ? { ownerKey: body.ownerKey } : undefined;
      return new Response("", { status: (await directory.claim(roomId, proof)) ? 200 : 409 });
    }
    const roomId = request.method === "POST" ? await request.text() : "";
    if (!ID.test(roomId)) return new Response("", { status: 400 });
    if (path === "/release") {
      directory.release(roomId);
      return new Response("", { status: 204 });
    }
    return new Response("", { status: 404 });
  }
}

function frameKind(message: string | ArrayBuffer): string {
  if (typeof message === "string") return "text";
  const bytes = new Uint8Array(message);
  if (bytes.byteLength < 9) return "short";
  const conn0 = bytes.subarray(1, 9).every((byte) => byte === 0);
  return `${conn0 ? "c0-" : ""}${bytes[0]}`;
}
