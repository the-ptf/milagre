import { createRoom, type Room as RoomLogic } from "./room.mjs";
import {
  createHookDirectory,
  createHookRoom,
  hookIdOf,
  hookSecretOf,
  packHookRequest,
  pickHookHeaders,
  pickHookQuery,
  readHookBody,
  unpackHookRequest,
  NOT_FOUND,
  NOT_FOUND_BODY,
  type HookAnswer,
  type HookDelivery,
  type HookRoom,
  type HookStorage,
} from "./hooks.mjs";

export interface Env {
  ROOMS: DurableObjectNamespace;
  HOOKS: DurableObjectNamespace;
}
const ID = /^[A-Za-z0-9_-]{22}$/;
const HOOK_ID = /^[0-9a-f]{64}$/;
// Internal hops between the Worker and its Durable Objects; never reachable from outside (the Worker routes by path).
const INTERNAL = "https://relay.internal";

const json = (answer: HookAnswer): Response =>
  new Response(answer === NOT_FOUND ? NOT_FOUND_BODY : JSON.stringify(answer.json), {
    status: answer.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * `POST /hook/<secret>`. Every secret, well-formed or not, is hashed before anything else, so an unknown hook, a bad
 * secret and a released hook all take the same path to the same 404. Nothing here logs the secret, the URL or the body.
 */
async function hookRequest(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  const secret = hookSecretOf(url.pathname);
  const hookId = await hookIdOf(secret ?? url.pathname);
  const body = await readHookBody(request);
  if (!body) return json({ status: 413, json: { error: "payload too large" } });
  const owner = await env.HOOKS.get(env.HOOKS.idFromName(hookId)).fetch(`${INTERNAL}/room`);
  const roomId = owner.ok ? await owner.text() : "";
  if (!secret || !ID.test(roomId)) return json(NOT_FOUND);
  const packed = packHookRequest({ headers: pickHookHeaders(request.headers.entries()), query: pickHookQuery(url.search), body });
  return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(`${INTERNAL}/hook`, {
    method: "POST",
    headers: { "x-milagre-hook": hookId },
    body: packed,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname.startsWith("/hook/")) return hookRequest(request, env, url);
    const role = url.pathname === "/v1/host" ? "host" : url.pathname === "/v1/phone" ? "phone" : null;
    if (!role) return new Response("Not found", { status: 404 });
    if (!ID.test(url.searchParams.get("id") ?? "")) return new Response("Bad id", { status: 400 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const id = url.searchParams.get("id")!;
    return env.ROOMS.get(env.ROOMS.idFromName(id)).fetch(request);
  },
};

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
  private roomId = ""; // the id the room in memory checks proofs against
  private hookRoom?: HookRoom;
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // A webhook delivery from the Worker. It must not write the room id: only a Mac's own connection says which room this is.
    if (url.pathname === "/hook") return this.hookDelivery(request);
    const id = url.searchParams.get("id")!;
    const role: Role = url.pathname === "/v1/host" ? "host" : "phone";
    // A hibernation wake has no request to read the id from, and the room needs it to check a Mac's proof.
    const kv = this.state.storage.kv;
    if (kv.get("id") !== id) kv.put("id", id);
    // A room woken without its id (storage lost it) would refuse every proof until the next eviction:
    // rebuild it from the marks, exactly as after an eviction, now that the request says which Mac this is.
    if (this.room && this.roomId !== id) this.room = undefined;
    const room = this.live(); // before accepting, so a rebuild cannot mistake the new socket for one that lost its state
    const [client, server] = Object.values(new WebSocketPair());
    if (!client || !server) throw new Error("WebSocketPair did not yield two sockets");
    // A phone turned away at the door never becomes hibernatable: the runtime takes about 10 s to finish
    // closing a hibernatable socket that has not sent anything yet, and the phone would wait that long for its 4404.
    const refusal = role === "phone" ? room.phoneRefusal() : null;
    if (refusal) {
      server.accept();
      server.close(refusal.code, refusal.reason);
      return new Response(null, { status: 101, webSocket: client });
    }
    // Hibernatable sockets hand binary over as an ArrayBuffer, which the room reads with its brand check.
    this.state.acceptWebSocket(server, [role]);
    if (role === "host") room.hostOpened(server);
    else room.phoneOpened(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const room = this.live();
    if (this.roleOf(ws) === "host") await room.hostMessage(ws, message);
    else room.phoneMessage(ws, message);
  }

  /** Expired deliveries go; the alarm moves to the next one to expire. */
  async alarm(): Promise<void> {
    const next = this.hooks().expire(Date.now());
    if (next !== null) await this.state.storage.setAlarm(next);
  }

  private async hookDelivery(request: Request): Promise<Response> {
    const hookId = request.headers.get("x-milagre-hook") ?? "";
    if (!HOOK_ID.test(hookId)) return json(NOT_FOUND);
    let delivery;
    try {
      delivery = unpackHookRequest(new Uint8Array(await request.arrayBuffer()));
    } catch {
      return json(NOT_FOUND);
    }
    this.live(); // so a connected Mac gets the delivery now
    const answer = this.hooks().receive(hookId, delivery);
    if (answer.status === 202 && (await this.state.storage.getAlarm()) === null) {
      const next = this.hooks().expire(Date.now());
      if (next !== null) await this.state.storage.setAlarm(next);
    }
    return json(answer);
  }

  /** The room's hooks over its own SQLite tables, the hook directory and its live Mac socket. */
  private hooks(): HookRoom {
    if (this.hookRoom) return this.hookRoom;
    const sql = this.state.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS hooks (id TEXT PRIMARY KEY)");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, hook TEXT NOT NULL, received_at INTEGER NOT NULL, size INTEGER NOT NULL, headers TEXT NOT NULL, query TEXT NOT NULL, body BLOB NOT NULL)",
    );
    type Row = { id: string; hook: string; received_at: number; size: number; headers: string; query: string; body: ArrayBuffer };
    const storage: HookStorage = {
      hooks: {
        has: (id) => sql.exec("SELECT 1 FROM hooks WHERE id = ?", id).toArray().length > 0,
        add: (id) => sql.exec("INSERT OR IGNORE INTO hooks (id) VALUES (?)", id),
        delete: (id) => sql.exec("DELETE FROM hooks WHERE id = ?", id),
        [Symbol.iterator]: () => {
          const ids = sql
            .exec<{ id: string }>("SELECT id FROM hooks")
            .toArray()
            .map((row) => row.id);
          return ids[Symbol.iterator]();
        },
      },
      deliveries: {
        put: (d: HookDelivery) =>
          sql.exec(
            "INSERT OR REPLACE INTO deliveries (id, hook, received_at, size, headers, query, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
            d.id,
            d.hook,
            d.receivedAt,
            d.size,
            JSON.stringify(d.headers),
            JSON.stringify(d.query),
            d.body,
          ),
        get: (id) => {
          const row = sql.exec<Row>("SELECT * FROM deliveries WHERE id = ?", id).toArray()[0];
          if (!row) return null;
          return {
            id: row.id,
            hook: row.hook,
            receivedAt: row.received_at,
            size: row.size,
            headers: JSON.parse(row.headers),
            query: JSON.parse(row.query),
            body: new Uint8Array(row.body),
          };
        },
        delete: (id) => void sql.exec("DELETE FROM deliveries WHERE id = ?", id),
        list: () =>
          sql
            .exec<{ id: string; hook: string; received_at: number; size: number }>(
              "SELECT id, hook, received_at, size FROM deliveries ORDER BY received_at, rowid",
            )
            .toArray()
            .map((row) => ({ id: row.id, hook: row.hook, receivedAt: row.received_at, size: row.size })),
        size: () => sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries").one().n,
        bytes: () => sql.exec<{ n: number }>("SELECT COALESCE(SUM(size), 0) AS n FROM deliveries").one().n,
      },
    };
    const directory = {
      claim: async (hookId: string, roomId: string) => {
        if (!ID.test(roomId)) return false;
        const response = await this.env.HOOKS.get(this.env.HOOKS.idFromName(hookId)).fetch(`${INTERNAL}/claim`, { method: "POST", body: roomId });
        return response.ok;
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

  webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
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
    this.closed(ws);
    try {
      ws.close(1011, "error");
    } catch {
      /* already closed */
    }
  }

  /** A socket can end with an error, a close, or both; the room ignores a socket it already forgot. */
  private closed(ws: WebSocket): void {
    const room = this.live(ws);
    if (this.roleOf(ws) === "host") room.hostClosed(ws);
    else room.phoneClosed(ws);
  }

  /**
   * The room in memory, rebuilt after an eviction from the sockets the runtime still holds.
   * `ending` is a socket whose close woke the object: it may no longer be listed, but the room still
   * has to hear about it (a phone's close becomes a CLOSE frame for the Mac). It goes first, so a
   * listed socket wins any tie.
   */
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

  /** The room's mark on a socket, if it agrees with the socket's role tag. */
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

/**
 * One hook's directory entry, named by the hook id: which room owns the hook. Rooms claim and release through it; the
 * Worker only reads it. The first claim wins and only the owner releases, so a Mac cannot take another Mac's hook.
 */
export class HookDirectory implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const directory = createHookDirectory({ storage: this.state.storage.kv });
    const path = new URL(request.url).pathname;
    if (path === "/room") {
      const room = directory.room();
      return room ? new Response(room) : new Response("", { status: 404 });
    }
    const roomId = request.method === "POST" ? await request.text() : "";
    if (!ID.test(roomId)) return new Response("", { status: 400 });
    if (path === "/claim") return new Response("", { status: directory.claim(roomId) ? 200 : 409 });
    if (path === "/release") {
      directory.release(roomId);
      return new Response("", { status: 204 });
    }
    return new Response("", { status: 404 });
  }
}
