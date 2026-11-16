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

const NONE = Object.freeze(new Set());
const tags = new WeakMap();
const fromDisk = new WeakSet();
const stores = new Map();

function storeOf(directory) {
  let store = stores.get(directory);
  if (!store) stores.set(directory, (store = { saved: null, rest: new Map(), restUsedAt: 0, wholes: new WeakMap() }));
  return store;
}

const messagesOf = (value) => (Array.isArray(value) ? value : value?.messages);

function unloadedChats(value) {
  const messages = messagesOf(value);
  return (messages && tags.get(messages)?.unloaded) ?? NONE;
}

function readableUnloaded(state) {
  const unloaded = unloadedChats(state);
  if (!unloaded.size || !state?.sessions) return unloaded;
  const live = new Set([...unloaded].filter((chat) => Object.hasOwn(state.sessions, String(chat))));
  return live.size === unloaded.size ? unloaded : live;
}

const isLoaded = (state, chatId) => !unloadedChats(state).has(Number(chatId));

function tag(messages, directory, unloaded) {
  if (unloaded.size) tags.set(messages, { directory, unloaded });
  else tags.delete(messages);
  return messages;
}

const isFromDisk = (message) => fromDisk.has(message);

const savedRows = (directory) => stores.get(directory)?.saved ?? null;

function setSavedRows(directory, saved) {
  storeOf(directory).saved = saved;
}

function resetStore(directory) {
  stores.delete(directory);
}

function forgetStore(directory) {
  if (!stores.get(directory)?.unloaded) stores.delete(directory);
}

const positionOf = (saved, message) => saved?.get(message.id)?.position ?? Infinity;

function positionsOf(directory, state) {
  const saved = storeOf(directory).saved;
  const missing = state.messages.filter((message) => !saved?.has(message.id)).map((message) => message.id);
  if (!missing.length) return saved;
  const read = readPositions(directory, missing);
  if (!saved) return read;
  return { get: (id) => saved.get(id) ?? read.get(id) };
}

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

function loadChats(directory, state, chats) {
  const unloaded = unloadedChats(state);
  const live = readableUnloaded(state);
  const wanted = new Set([...chats].map(Number).filter((chat) => live.has(chat)));
  if (!wanted.size) return state;
  const store = storeOf(directory);
  const rows = rowsOf(directory, wanted);
  for (const chat of wanted) store.rest.delete(chat);
  const saved = store.saved;
  const present = new Set(state.messages.map((message) => message.id));
  const fresh = rows.filter((row) => !present.has(row.message.id));
  const positions = positionsOf(directory, state);
  if (saved) for (const row of fresh) saved.set(row.message.id, row);
  const messages = mergeRows(state.messages, fresh, positions);
  const remaining = new Set([...unloaded].filter((chat) => !wanted.has(chat)));
  if (!remaining.size) store.unloaded = false;
  return { ...state, messages: tag(messages === state.messages ? [...messages] : messages, directory, remaining) };
}

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
      fromDisk.add(row.message);
    }
    if (keepRest) store.rest.set(chat, list);
  }
  return { ...state, messages: tag(messages, directory, new Set([...unloadedChats(state), ...going])) };
}

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

const REST_TTL_MS = 60 * 1000;

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

function forgetRest(directory, { chats, all = false, now = Date.now() } = {}) {
  const store = stores.get(directory);
  if (!store) return;
  const expire = () => {
    store.rest.clear();
    store.wholes = new WeakMap();
  };
  if (all) store.rest.clear();
  else if (chats) for (const chat of chats) store.rest.delete(Number(chat));
  else if (now - store.restUsedAt >= REST_TTL_MS) expire();
}

function retag(from, messages) {
  if (from === messages || !Array.isArray(messages)) return messages;
  const known = tags.get(from);
  if (known) tags.set(messages, known);
  return messages;
}

function allMessages(directory, state) {
  const unloaded = readableUnloaded(state);
  if (!unloaded.size) return state.messages;
  return mergeRows(state.messages, rowsOf(directory, unloaded), positionsOf(directory, state));
}

function chatMessages(directory, state, chats) {
  const wanted = new Set([...chats].map(Number));
  const loaded = state.messages.filter((message) => wanted.has(Number(message.session_id)));
  const unloaded = [...readableUnloaded(state)].filter((chat) => wanted.has(chat));
  if (!unloaded.length) return loaded;
  return mergeRows(loaded, rowsOf(directory, unloaded), positionsOf(directory, state));
}

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

function messagesContaining(directory, state, needles) {
  const unloaded = readableUnloaded(state);
  if (!unloaded.size) return state.messages;
  const rows = readChatRowsContaining(directory, unloaded, needles);
  for (const row of rows) fromDisk.add(row.message);
  return mergeRows(state.messages, rows, positionsOf(directory, state));
}

const mark = ({ id, session_id, role, outcome, clientMessageId }) => ({ id, session_id, role, outcome, clientMessageId });

function messageMarks(directory, state) {
  const loaded = state.messages.map(mark);
  const unloaded = readableUnloaded(state);
  if (!unloaded.size) return loaded;
  const saved = positionsOf(directory, state);
  const keyed = state.messages.map((message, index) => ({ mark: loaded[index], position: positionOf(saved, message) }));
  const rows = readChatMarks(directory, unloaded);
  const merged = [];
  let next = 0;
  for (const item of keyed) {
    while (next < rows.length && rows[next].position < item.position) merged.push(rows[next++].message);
    merged.push(item.mark);
  }
  while (next < rows.length) merged.push(rows[next++].message);
  return merged;
}

function searchableMessages(directory, state, chats) {
  const wanted = chats ? new Set([...chats].map(Number)) : null;
  const loaded = state.messages.filter((message) => !wanted || wanted.has(Number(message.session_id)));
  const unloaded = [...readableUnloaded(state)].filter((chat) => !wanted || wanted.has(chat));
  if (!unloaded.length) return loaded;
  return mergeRows(loaded, readChatBodies(directory, unloaded), positionsOf(directory, state));
}

function findMessage(directory, state, field, value) {
  const found = state.messages.find((message) => message[field] === value);
  const unloaded = readableUnloaded(state);
  if (!unloaded.size || value === undefined || value === null) return found;
  const row = findRow(directory, unloaded, field, value);
  if (!row) return found;
  if (!found || row.position < positionOf(positionsOf(directory, state), found)) return row.message;
  return found;
}

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
