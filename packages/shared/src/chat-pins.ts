// Pins belong to the device that made them, like the Chat order and the filters: each Mac and each phone keeps its own
// in its local preferences, and pinning a Chat on one never pins it on another. Chats still carry the `pinned` and
// `pin_order` every device used to share (AgentSession); a scope this device hasn't pinned in yet shows those, so
// nobody loses the pins they had, and its first pin or unpin copies them here and leaves them behind for good.

/** One scope's pins on this device: session id to pin order, lowest first. */
export type ScopePins = Readonly<Record<string, number>>;
/** Every scope's pins on this device, by scope key (a Project path, `<computer>|<path>`, a Link's key). */
export type DevicePins = Readonly<Record<string, ScopePins>>;

type Pinnable = { id: number; pinned?: boolean; pin_order?: number };

/**
 * Whether pinning `session` should tell its host the user took it over (SessionPatch `kept`): only a Run Chat its host
 * may still hide, as the host's keepRunChat decides. Any other pin stays on this device alone, and an older host that
 * doesn't know `kept` never sees one for an ordinary Chat.
 */
export function keepsOnPin(session: { routine?: { hidden?: boolean } } | undefined): boolean {
  return !!session?.routine && session.routine.hidden !== false;
}

const NO_PINS: ScopePins = Object.freeze({});

/** The pins `scope` shows here: this device's own, or the shared ones its Chats carry until this device changes one. */
export function scopePins(saved: DevicePins, scope: string, sessions: Iterable<Pinnable>): ScopePins {
  const own = Object.hasOwn(saved, scope) ? saved[scope] : undefined;
  if (own) return own;
  let shared: Record<string, number> | undefined;
  for (const session of sessions) if (session.pinned) (shared ??= {})[String(session.id)] = session.pin_order ?? 0;
  return shared ?? NO_PINS;
}

/** `session` with this device's pin. The same object when nothing changes, so memoized rows keep their identity. */
export function withPin<T extends Pinnable>(session: T, pins: ScopePins): T {
  const order = Object.hasOwn(pins, String(session.id)) ? pins[String(session.id)] : undefined;
  const pinned = order !== undefined;
  if (Boolean(session.pinned) === pinned && (!pinned || (session.pin_order ?? 0) === order)) return session;
  return { ...session, pinned, pin_order: order };
}

/** A scope's `sessions` (by id) with this device's pins in place of the ones they carry. The same object when nothing differs. */
export function sessionsWithPins<T extends Pinnable>(sessions: Readonly<Record<string, T>>, scope: string, saved: DevicePins): Readonly<Record<string, T>> {
  const pins = scopePins(saved, scope, Object.values(sessions));
  let next: Record<string, T> | undefined;
  for (const [id, session] of Object.entries(sessions)) {
    const pinned = withPin(session, pins);
    if (pinned !== session) (next ??= { ...sessions })[id] = pinned;
  }
  return next ?? sessions;
}

/**
 * `saved` with Chat `id` of `scope` pinned at `order`, or unpinned for null. The scope's pins become this device's own:
 * the shared ones it showed are copied first, and pins of Chats no longer in `sessions` (deleted ones) drop out.
 */
export function setPin(saved: DevicePins, scope: string, sessions: Iterable<Pinnable>, id: number, order: number | null): DevicePins {
  const list = [...sessions];
  const live = new Set(list.map((session) => String(session.id)));
  const next: Record<string, number> = {};
  for (const [key, value] of Object.entries(scopePins(saved, scope, list))) if (live.has(key)) next[key] = value;
  if (order === null || !Number.isFinite(order)) delete next[String(id)];
  else next[String(id)] = order;
  return { ...saved, [scope]: next };
}

/** Saved pins read back: anything that isn't scope to id to a finite order is dropped. */
export function parseDevicePins(raw: unknown): DevicePins {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, ScopePins> = {};
  for (const [scope, pins] of Object.entries(raw)) {
    if (!pins || typeof pins !== "object" || Array.isArray(pins)) continue;
    const kept: Record<string, number> = {};
    for (const [id, order] of Object.entries(pins)) if (/^\d+$/.test(id) && typeof order === "number" && Number.isFinite(order)) kept[id] = order;
    result[scope] = kept;
  }
  return result;
}
