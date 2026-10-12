const {
  readChatRows,
  readChatBodies,
  readChatPreviews,
  readChatRowsContaining,
  readChatMarks,
  readPositions,
  findRow,
  readDetailRefs,
} = require("./chat-db.cjs");

// Which Chats' messages a state holds in memory (#321). A Project's state used to hold every message of every Chat; now
// a Chat nobody has touched for a while is unloaded: its messages leave `state.messages`, and its rows in chats.db
// (ADR-0007) are the only copy until something needs them again. A Chat is either loaded, with all its messages in the
// state, or unloaded, with none.
//
// The set of unloaded Chats travels with each state, tagged on its messages array (states are replaced, never changed
// in place, so an array keeps its tag; ProjectStates tags each new one). Everything that could read an unloaded Chat's
// absence as its messages being gone asks for it:
// - a save keeps the rows of unloaded Chats (writeMessages `keep`), so nothing on disk is lost;
// - a change that names its Chats has them loaded first (ProjectStates.update `chats`), and one that touches an
//   unloaded Chat without naming it gets the Chat's rows merged back in (settle);
// - a client never hears an unloaded Chat's messages as removed, nor a loaded one's as new (the daemon's messageChanges);
// - a client that takes whole states gets them with every message (wholeState).

const NONE = Object.freeze(new Set());
// messages array -> { directory, unloaded: Set of Chat ids }
const tags = new WeakMap();
// Message objects read back from chats.db: what a client already has, not something new.
const fromDisk = new WeakSet();
// directory -> { saved: Map(id -> { message, position, chat }) as chats.db holds the Chats in memory, rest: whole-state cache }
const stores = new Map();

function storeOf(directory) {
  let store = stores.get(directory);
  if (!store) stores.set(directory, (store = { saved: null, rest: new Map(), restUsedAt: 0, wholes: new WeakMap() }));
  return store;
}

const messagesOf = (value) => (Array.isArray(value) ? value : value?.messages);

/** The Chats a state (or its messages array) doesn't hold in memory; an empty set when it holds them all. */
function unloadedChats(value) {
  const messages = messagesOf(value);
  return (messages && tags.get(messages)?.unloaded) ?? NONE;
}

/**
 * The unloaded Chats of a state that it still has: a Chat removed while unloaded keeps its tag until the next save
 * deletes its rows, and nothing reads them back meanwhile.
 */
function readableUnloaded(state) {
  const unloaded = unloadedChats(state);
  if (!unloaded.size || !state?.sessions) return unloaded;
  const live = new Set([...unloaded].filter((chat) => Object.hasOwn(state.sessions, String(chat))));
  return live.size === unloaded.size ? unloaded : live;
}

/** Whether `chatId`'s messages are in `state`. */
const isLoaded = (state, chatId) => !unloadedChats(state).has(Number(chatId));

/** Marks `messages` as missing the Chats `unloaded`, read from `directory`'s chats.db. Returns `messages`. */
function tag(messages, directory, unloaded) {
  if (unloaded.size) tags.set(messages, { directory, unloaded });
  else tags.delete(messages);
  return messages;
}

const isFromDisk = (message) => fromDisk.has(message);

/** What chats.db holds for the Chats in memory (see writeMessages), or null when nothing says yet. */
const savedRows = (directory) => stores.get(directory)?.saved ?? null;

/** Sets what chats.db holds for the Chats in memory: after a read (every row) and after each save. */
function setSavedRows(directory, saved) {
  storeOf(directory).saved = saved;
}

/** Forgets what a directory's store knows, e.g. when its state is read again from disk. */
function resetStore(directory) {
  stores.delete(directory);
}

/**
 * Forgets a directory's store to save memory (project-store keeps the last 50 Projects it saved), unless its state may
 * hold unloaded Chats: their loads and saves rely on the saved rows the store keeps.
 */
function forgetStore(directory) {
  if (!stores.get(directory)?.unloaded) stores.delete(directory);
}

const positionOf = (saved, message) => saved?.get(message.id)?.position ?? Infinity;

/**
 * Where the messages of `state` sit in chats.db, for merging rows in among them: what the store knows, or, when it has
 * forgotten (project-store keeps it for the 50 Projects saved last), read from chats.db again.
 */
function positionsOf(directory, state) {
  const saved = storeOf(directory).saved;
  // A record the store lacks is read too: a map can miss messages (a Chat loaded while the save that made it ran).
  const missing = state.messages.filter((message) => !saved?.has(message.id)).map((message) => message.id);
  if (!missing.length) return saved;
  const read = readPositions(directory, missing);
  if (!saved) return read;
  return { get: (id) => saved.get(id) ?? read.get(id) };
}

/**
 * `messages` with `rows` (each { message, position }, in position order) merged in: each row goes before the first
 * message whose saved position is after its own (a message not saved yet counts as after every row).
 */
function mergeRows(messages, rows, saved) {
  if (!rows.length) return messages;
  const merged = [];
  let next = 0;
  for (const message of messages) {
    const at = positionOf(saved, message);
    while (next < rows.length && rows[next].position < at) merged.push(rows[next++].message);
    merged.push(message);
  }
  while (next < rows.length) merged.push(rows[next++].message);
  return merged;
}

/** The rows of the Chats `chats`, from the whole-state cache where it has them, else from chats.db. */
function rowsOf(directory, chats, { cache = false } = {}) {
  const store = storeOf(directory);
  const missing = [...chats].filter((chat) => !store.rest.has(chat));
  if (missing.length) {
    const read = readChatRows(directory, missing);
    for (const row of read) fromDisk.add(row.message);
    if (cache) {
      for (const chat of missing) store.rest.set(chat, []);
      for (const row of read) store.rest.get(Number(row.chat)).push(row);
    } else {
      const byChat = new Map(missing.map((chat) => [chat, []]));
      for (const row of read) byChat.get(Number(row.chat)).push(row);
      return [...chats].flatMap((chat) => store.rest.get(chat) ?? byChat.get(chat)).toSorted((a, b) => a.position - b.position);
    }
  }
  return [...chats].flatMap((chat) => store.rest.get(chat)).toSorted((a, b) => a.position - b.position);
}

/**
 * `state` with the Chats `chats` (unloaded ones; others are skipped) read back from chats.db into its messages, in
 * their place in the Project's order. Their rows join what the store knows chats.db holds.
 */
function loadChats(directory, state, chats) {
  const unloaded = unloadedChats(state);
  // A Chat removed while unloaded stays out: the next save deletes its rows.
  const live = readableUnloaded(state);
  const wanted = new Set([...chats].map(Number).filter((chat) => live.has(chat)));
  if (!wanted.size) return state;
  const store = storeOf(directory);
  const rows = rowsOf(directory, wanted);
  for (const chat of wanted) store.rest.delete(chat);
  const saved = store.saved;
  const present = new Set(state.messages.map((message) => message.id));
  // A message the state already has (a change that touched the Chat without asking for it) wins over its saved row.
  const fresh = rows.filter((row) => !present.has(row.message.id));
  const positions = positionsOf(directory, state);
  if (saved) for (const row of fresh) saved.set(row.message.id, row);
  const messages = mergeRows(state.messages, fresh, positions);
  const remaining = new Set([...unloaded].filter((chat) => !wanted.has(chat)));
  // Every Chat back in memory: the store may be forgotten again like any other (see forgetStore). A save of an older
  // state that still had unloaded Chats reads what it needs from chats.db.
  if (!remaining.size) store.unloaded = false;
  return { ...state, messages: tag(messages === state.messages ? [...messages] : messages, directory, remaining) };
}

/**
 * `state` without the messages of those of `chats` that chats.db holds exactly as the state does (every message saved,
 * none removed since). Returns `state` itself when none can go.
 */
function unloadChats(directory, state, chats) {
  const store = storeOf(directory);
  const saved = store.saved;
  if (!saved) return state;
  const candidates = new Set([...chats].map(Number));
  const counts = new Map();
  for (const message of state.messages) {
    const chat = Number(message.session_id);
    if (!candidates.has(chat)) continue;
    if (saved.get(message.id)?.message !== message) candidates.delete(chat);
    else counts.set(chat, (counts.get(chat) ?? 0) + 1);
  }
  // A row the state no longer has (a message taken back, not saved yet) would come back with the Chat.
  const rows = new Map();
  for (const row of saved.values()) if (candidates.has(Number(row.chat))) rows.set(Number(row.chat), (rows.get(Number(row.chat)) ?? 0) + 1);
  const going = new Set([...candidates].filter((chat) => counts.has(chat) && rows.get(chat) === counts.get(chat)));
  if (!going.size) return state;
  store.unloaded = true;
  const keepRest = Date.now() - store.restUsedAt < REST_TTL_MS;
  const evicted = new Map([...going].map((chat) => [chat, []]));
  const messages = [];
  for (const message of state.messages) {
    const chat = Number(message.session_id);
    if (going.has(chat)) evicted.get(chat).push(saved.get(message.id));
    else messages.push(message);
  }
  for (const [chat, list] of evicted) {
    for (const row of list) {
      saved.delete(row.message.id);
      // Saved as it is: when it comes back, a client already has it (see the daemon's messageChanges).
      fromDisk.add(row.message);
    }
    // A client that takes whole states read lately keeps getting these same objects (see wholeState).
    if (keepRest) store.rest.set(chat, list);
  }
  return { ...state, messages: tag(messages, directory, new Set([...unloadedChats(state), ...going])) };
}

/**
 * The state a change produced, made safe to keep. A change that added or changed messages of a Chat that `previous`
 * held unloaded (one that didn't name its Chats; see ProjectStates.update) gets that Chat's saved rows merged back, so
 * the Chat is whole again. Tags the result with the Chats still unloaded. Returns { state, touched }: `touched` lists
 * the Chats whose messages changed.
 */
function settle(directory, previous, next) {
  if (!Array.isArray(next?.messages)) return { state: next, touched: NONE };
  if (next.messages === previous?.messages) return { state: next, touched: NONE };
  const unloaded = unloadedChats(previous);
  const before = new Set(previous?.messages ?? []);
  const touched = new Set();
  const after = new Set(next.messages);
  for (const message of next.messages) if (!before.has(message)) touched.add(Number(message.session_id));
  for (const message of previous?.messages ?? []) if (!after.has(message)) touched.add(Number(message.session_id));
  const reached = [...touched].filter((chat) => unloaded.has(chat));
  if (reached.length) return { state: loadChats(directory, { ...next, messages: tag(next.messages, directory, unloaded) }, reached), touched };
  tag(next.messages, directory, unloaded);
  return { state: next, touched };
}

// A whole-state client (an older desktop) makes the unloaded Chats' rows stay cached this long after its last read, so
// each state it gets shares their objects with the one before and a patch between them stays small. A client that only
// briefly took whole states (a desktop before it asks for patches) leaves them cached no longer than this.
const REST_TTL_MS = 60 * 1000;

/**
 * `state` with every message, for a client that takes whole states: the unloaded Chats' messages read back from
 * chats.db (and kept for REST_TTL_MS) and merged in. The same object for the same state; `state` itself when it holds
 * every message.
 */
function wholeState(state) {
  const unloaded = readableUnloaded(state);
  if (!unloaded.size) return state;
  const { directory } = tags.get(state.messages);
  const store = storeOf(directory);
  let whole = store.wholes.get(state);
  if (!whole) {
    store.restUsedAt = Date.now();
    whole = { ...state, messages: mergeRows(state.messages, rowsOf(directory, unloaded, { cache: true }), positionsOf(directory, state)) };
    store.wholes.set(state, whole);
  }
  return whole;
}

/**
 * Drops cached rows (wholeState) from a directory's store: those of the Chats `chats`, whose rows a save may have
 * changed; all of them with `all` (a save numbered the positions again); or all of them when no whole state was asked
 * for in REST_TTL_MS.
 */
function forgetRest(directory, { chats, all = false, now = Date.now() } = {}) {
  const store = stores.get(directory);
  if (!store) return;
  // The whole states made from them go too: a state outlives its whole copy in the daemon and the runtime.
  const expire = () => {
    store.rest.clear();
    store.wholes = new WeakMap();
  };
  if (all) store.rest.clear();
  else if (chats) for (const chat of chats) store.rest.delete(Number(chat));
  else if (now - store.restUsedAt >= REST_TTL_MS) expire();
}

/** Gives `messages` the tag of `from` (a copy of the same messages, made by a step that maps them one to one). */
function retag(from, messages) {
  if (from === messages || !Array.isArray(messages)) return messages;
  const known = tags.get(from);
  if (known) tags.set(messages, known);
  return messages;
}

/** Every message of `state`, unloaded Chats' read from chats.db for this call only, in the Project's order. */
function allMessages(directory, state) {
  const unloaded = readableUnloaded(state);
  if (!unloaded.size) return state.messages;
  return mergeRows(state.messages, rowsOf(directory, unloaded), positionsOf(directory, state));
}

/** The messages of the Chats `chats`, in the Project's order: an unloaded one's read from chats.db for this call only. */
function chatMessages(directory, state, chats) {
  const wanted = new Set([...chats].map(Number));
  const loaded = state.messages.filter((message) => wanted.has(Number(message.session_id)));
  const unloaded = [...readableUnloaded(state)].filter((chat) => wanted.has(chat));
  if (!unloaded.length) return loaded;
  return mergeRows(loaded, rowsOf(directory, unloaded), positionsOf(directory, state));
}

/** A projection for the inbox, with bounded assistant previews for unread outcomes, including unloaded Chats. */
function inboxState(directory, state) {
  const chats = Object.values(state.sessions)
    .filter((session) => !session.archived && session.unread && ["completed", "failed"].includes(session.summary?.lastOutcome))
    .map((session) => session.id);
  const unloaded = readableUnloaded(state);
  const messages = chats
    .filter((chat) => !unloaded.has(chat))
    .map((chat) => state.messages.findLast((message) => message.session_id === chat && message.role === "assistant"))
    .filter(Boolean)
    .map(({ session_id, body }) => ({
      session_id,
      role: "assistant",
      body: body?.slice(0, 240) ?? "",
    }));
  if (directory)
    messages.push(
      ...readChatPreviews(
        directory,
        chats.filter((chat) => unloaded.has(chat)),
      ),
    );
  return { ...state, messages };
}

/**
 * Every message in memory, and those of unloaded Chats whose saved JSON contains one of `needles` (read for this call
 * only), in the Project's order: what a lookup that matches on some text has to look at.
 */
function messagesContaining(directory, state, needles) {
  const unloaded = readableUnloaded(state);
  if (!unloaded.size) return state.messages;
  const rows = readChatRowsContaining(directory, unloaded, needles);
  for (const row of rows) fromDisk.add(row.message);
  return mergeRows(state.messages, rows, positionsOf(directory, state));
}

const mark = ({ id, session_id, role, outcome, clientMessageId }) => ({ id, session_id, role, outcome, clientMessageId });

/**
 * { id, session_id, role, outcome, clientMessageId } of every message, in the Project's order: what a chat list reads
 * of them. An unloaded Chat's come from chats.db without reading its messages whole.
 */
function messageMarks(directory, state) {
  const loaded = state.messages.map(mark);
  const unloaded = readableUnloaded(state);
  if (!unloaded.size) return loaded;
  const saved = positionsOf(directory, state);
  const keyed = state.messages.map((message, index) => ({ mark: loaded[index], position: positionOf(saved, message) }));
  const rows = readChatMarks(directory, unloaded);
  // mergeRows by the saved positions of the messages in memory, applied to their marks.
  const merged = [];
  let next = 0;
  for (const item of keyed) {
    while (next < rows.length && rows[next].position < item.position) merged.push(rows[next++].message);
    merged.push(item.mark);
  }
  while (next < rows.length) merged.push(rows[next++].message);
  return merged;
}

/** { id, session_id, body } of every message of the Chats `chats` (all when not given), for a search. */
function searchableMessages(directory, state, chats) {
  const wanted = chats ? new Set([...chats].map(Number)) : null;
  const loaded = state.messages.filter((message) => !wanted || wanted.has(Number(message.session_id)));
  const unloaded = [...readableUnloaded(state)].filter((chat) => !wanted || wanted.has(chat));
  if (!unloaded.length) return loaded;
  return mergeRows(loaded, readChatBodies(directory, unloaded), positionsOf(directory, state));
}

/**
 * The first message of `state` (in the Project's order) whose `field` (id, operationId or clientMessageId) is `value`,
 * looked up in chats.db for the unloaded Chats; undefined when there is none.
 */
function findMessage(directory, state, field, value) {
  const found = state.messages.find((message) => message[field] === value);
  const unloaded = readableUnloaded(state);
  if (!unloaded.size || value === undefined || value === null) return found;
  const row = findRow(directory, unloaded, field, value);
  if (!row) return found;
  if (!found || row.position < positionOf(positionsOf(directory, state), found)) return row.message;
  return found;
}

/** The details sidecars the unloaded Chats of `state` point at, which a sweep must keep. */
const unloadedDetailRefs = (directory, state) => readDetailRefs(directory, readableUnloaded(state));

module.exports = {
  unloadedChats,
  isLoaded,
  isFromDisk,
  tag,
  retag,
  savedRows,
  setSavedRows,
  resetStore,
  forgetStore,
  loadChats,
  unloadChats,
  settle,
  wholeState,
  forgetRest,
  allMessages,
  chatMessages,
  inboxState,
  messagesContaining,
  messageMarks,
  searchableMessages,
  findMessage,
  unloadedDetailRefs,
  REST_TTL_MS,
};
