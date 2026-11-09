const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { hydrateSubagents, migrateImages, restoreDetails } = require("./project-content.cjs");
const { syncDirectory } = require("./project-store.cjs");

// Before #117, a linked worktree opened as a project kept its chats in its own .milagre/coordination.json. Since #117
// the repository's project reads only the main checkout's file, so those chats went missing from the list. This brings
// them into the main checkout's state once, then renames the old file so it is never merged again.

const values = (items) => (Array.isArray(items) ? items : Object.values(items ?? {}));
const oldChatsFile = (worktreePath) => path.join(worktreePath, ".milagre", "coordination.json");

function messagesBySession(messages) {
  const grouped = new Map();
  for (const message of values(messages)) {
    if (!grouped.has(message.session_id)) grouped.set(message.session_id, []);
    grouped.get(message.session_id).push(message);
  }
  return grouped;
}

// A chat copied by hand keeps every message as it was, even when it lost its provider id. Two chats that only start
// the same way ("/review", then different replies) are different chats.
const fingerprint = (worktreePath, messages) =>
  createHash("sha256")
    .update(JSON.stringify([worktreePath, messages.map((message) => message.body ?? "")]))
    .digest("hex");

// The id after every id in use; a loop, since spreading hundreds of thousands of ids into Math.max overflows the stack.
function firstFreeId(state) {
  let next = Number(state.next_id) || 1;
  for (const collection of [state.worktrees, state.sessions, state.messages, state.tasks]) {
    for (const item of values(collection)) {
      const id = Number(item.id);
      if (Number.isFinite(id) && id >= next) next = id + 1;
    }
  }
  return next;
}

// A provider's parked session is as much the chat's as the current one: a switched chat keeps both.
const nativeIds = (session) => [session.native_session_id, ...Object.values(session.native_sessions ?? {})].filter(Boolean);

/**
 * The old file's chats with messages merged into the main checkout's state; neither input is changed.
 * A chat the main state already has is skipped: the same provider id, or, when either side has none, the same worktree
 * and the same message bodies. Worktrees match by path; sessions, messages, added worktrees and tasks get fresh ids from
 * next_id, and every reference moves with them. `listed`, when given, holds the worktree paths git lists now with their
 * folders present: a chat in any other worktree is left behind (`gone`), since reconciling would drop it anyway.
 * Throws on a file whose shape it can't read; the caller then leaves both files as they are.
 */
function mergeWorktreeChats(main, old, { listed } = {}) {
  const counts = { migrated: 0, duplicates: 0, empty: 0, gone: 0, messages: 0, addedWorktrees: 0 };
  const mainWorktrees = values(main.worktrees);
  let nextId = firstFreeId(main);
  const take = () => nextId++;

  const worktreePathById = new Map(mainWorktrees.map((worktree) => [worktree.id, worktree.path]));
  const knownNative = new Set(values(main.sessions).flatMap(nativeIds));
  const knownCopies = new Map();
  const remember = (key, nativeId) => knownCopies.set(key, [...(knownCopies.get(key) ?? []), nativeId]);
  const mainMessages = messagesBySession(main.messages);
  for (const session of values(main.sessions)) {
    const messages = mainMessages.get(session.id);
    if (messages?.length) remember(fingerprint(worktreePathById.get(session.worktree_id), messages), session.native_session_id);
  }

  const oldWorktrees = new Map(values(old.worktrees).map((worktree) => [worktree.id, worktree]));
  const oldMessages = messagesBySession(old.messages);
  const chosen = [];
  for (const session of values(old.sessions)) {
    const messages = oldMessages.get(session.id);
    if (!messages?.length) {
      counts.empty++;
      continue;
    }
    const worktree = oldWorktrees.get(session.worktree_id);
    if (!worktree || (listed && !listed.has(worktree.path))) {
      counts.gone++;
      continue;
    }
    const key = fingerprint(worktree.path, messages);
    const nativeId = session.native_session_id;
    if (nativeIds(session).some((id) => knownNative.has(id)) || (knownCopies.get(key) ?? []).some((other) => !other || !nativeId)) {
      counts.duplicates++;
      continue;
    }
    for (const id of nativeIds(session)) knownNative.add(id);
    remember(key, nativeId);
    chosen.push({ session, worktree, messages });
  }
  if (!chosen.length) return { state: main, ...counts };

  const projectId = values(main.projects)[0]?.id ?? 1;
  const worktrees = { ...main.worktrees };
  const mainByPath = new Map(mainWorktrees.map((worktree) => [worktree.path, worktree.id]));
  const worktreeIds = new Map();
  for (const { worktree } of chosen) {
    if (worktreeIds.has(worktree.id)) continue;
    let id = mainByPath.get(worktree.path);
    if (id === undefined) {
      id = take();
      worktrees[id] = { ...worktree, id, project_id: projectId };
      mainByPath.set(worktree.path, id);
      counts.addedWorktrees++;
    }
    worktreeIds.set(worktree.id, id);
  }

  const sessionIds = new Map(chosen.map(({ session }) => [session.id, take()]));
  const sessions = { ...main.sessions };
  for (const { session } of chosen) {
    const id = sessionIds.get(session.id);
    const copy = { ...session, id, worktree_id: worktreeIds.get(session.worktree_id) };
    // A handover link survives only when the chat at its other end came along too.
    for (const link of ["handedOverTo", "handedOverFrom"]) {
      if (sessionIds.has(copy[link])) copy[link] = sessionIds.get(copy[link]);
      else delete copy[link];
    }
    sessions[id] = copy;
  }

  const messages = [...values(main.messages)];
  for (const { session, messages: own } of chosen) {
    for (const message of own) messages.push({ ...message, id: take(), session_id: sessionIds.get(session.id) });
    counts.messages += own.length;
  }

  // Tasks follow the worktrees the chats came from; one the main state already lists there is not added twice.
  const tasks = { ...main.tasks };
  const knownTasks = new Set(values(main.tasks).map((task) => JSON.stringify([task.worktree_id, task.title])));
  for (const task of values(old.tasks)) {
    const worktreeId = worktreeIds.get(task.worktree_id);
    if (worktreeId === undefined || knownTasks.has(JSON.stringify([worktreeId, task.title]))) continue;
    const id = take();
    tasks[id] = { ...task, id, worktree_id: worktreeId };
  }

  counts.migrated = chosen.length;
  // Only CoordinatorState keys come across; the old file's legacy keys stay behind.
  return { state: { ...main, next_id: nextId, worktrees, sessions, messages, tasks }, ...counts };
}

/** Parses a linked worktree's old file, with any subagent transcript sidecars it points at; null when there is none. */
async function readOldChats(worktreePath) {
  let text;
  try {
    text = await fs.readFile(oldChatsFile(worktreePath), "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
  const state = JSON.parse(text);
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("not a coordination state");
  // Its messages move to the main checkout's file, so their details come back inline from this folder's sidecars.
  return restoreDetails(worktreePath, await hydrateSubagents(worktreePath, state));
}

/**
 * Brings the chats of each linked worktree's old file into the main checkout's state. `state` is the main checkout's
 * stored state (or one to start from when it has none). The caller holds the project's runtime owner, so no other
 * load merges at the same time. One save covers every file, through the app's own atomic save (synced to disk); only
 * then is each merged file renamed to coordination.json.migrated-<ISO time, with dashes for colons>. A file that can't be read, parsed or
 * merged, or a save that fails, leaves the files as they are and logs one line; the project still opens with the state
 * it had. Chats left behind because their worktree is gone are counted in a log line, and stay in the renamed file.
 * Returns the state to use and, per worktree, how many chats came back.
 */
async function migrateWorktreeChats({ projectPath, state, linkedWorktrees, listed, save, now = () => new Date(), warn = console.warn }) {
  let merged = state;
  const done = [];
  const restored = [];
  for (const worktree of linkedWorktrees) {
    const file = oldChatsFile(worktree.path);
    try {
      const old = await readOldChats(worktree.path);
      if (!old) continue;
      const result = mergeWorktreeChats(merged, old, { listed });
      merged = result.state;
      done.push({ file, gone: result.gone });
      if (result.migrated) restored.push({ worktree: worktree.name, count: result.migrated });
    } catch (error) {
      warn(`Milagre couldn't bring back the chats saved in ${file}; it is left as it is: ${error.message}`);
    }
  }
  if (restored.length) {
    try {
      merged = await migrateImages(projectPath, merged);
      // Synced to disk: the old files are renamed next, so the main file must already hold their chats.
      await save(projectPath, merged, { durable: true });
    } catch (error) {
      warn(`Milagre couldn't bring back the chats saved in ${done.map((item) => item.file).join(", ")}: ${error.message}`);
      return { state, restored: [] };
    }
  }
  // Windows refuses a file name with a colon, and then the old file stays and is read on every open.
  const stamp = now().toISOString().replaceAll(":", "-");
  for (const { file, gone } of done) {
    const renamed = `${file}.migrated-${stamp}`;
    try {
      await fs.rename(file, renamed);
      await syncDirectory(path.dirname(file));
      if (gone)
        warn(
          `Milagre left ${gone} ${gone === 1 ? "chat" : "chats"} in ${renamed}: ${gone === 1 ? "its worktree is" : "their worktrees are"} no longer listed by git, or the folder is missing.`,
        );
    } catch (error) {
      // The file is read again on the next open; the duplicate check then skips what this merge already saved.
      warn(`Milagre brought back the chats in ${file} but couldn't rename it: ${error.message}`);
    }
  }
  return { state: restored.length ? merged : state, restored };
}

module.exports = { mergeWorktreeChats, migrateWorktreeChats, readOldChats, oldChatsFile };
