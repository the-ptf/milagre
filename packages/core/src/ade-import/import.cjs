const fs = require("node:fs");
const path = require("node:path");
const { summarizeChat } = require("@milagre/shared/chat-summary");

const values = (items) => (Array.isArray(items) ? items : Object.values(items ?? {}));
const nativeIds = (session) => [session.native_session_id, ...Object.values(session.native_sessions ?? {})].filter(Boolean);

function realPath(folder) {
  try {
    return fs.realpathSync(folder);
  } catch {
    return path.resolve(folder);
  }
}

function worktreeFor(state, cwd) {
  if (!cwd) return null;
  const target = realPath(cwd);
  let best = null;
  for (const worktree of values(state.worktrees)) {
    if (!worktree?.path || worktree.sharedChat) continue;
    const root = realPath(worktree.path);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    if (!best || root.length > best.root.length) best = { worktree, root };
  }
  return best?.worktree ?? null;
}

function importedIds(state) {
  const ids = new Set();
  for (const session of values(state.sessions)) {
    if (session.importedFrom?.id) ids.add(session.importedFrom.id);
    for (const id of nativeIds(session)) ids.add(`native:${id}`);
  }
  return ids;
}

function addImportedChats(state, chats) {
  const known = importedIds(state);
  let nextId = Number(state.next_id) || 1;
  const sessions = { ...state.sessions };
  const messages = [...values(state.messages)];
  const added = [];
  const skipped = [];
  for (const chat of chats) {
    if (known.has(chat.id) || (chat.nativeId && known.has(`native:${chat.nativeId}`))) {
      skipped.push({ id: chat.id, reason: "already-imported" });
      continue;
    }
    if (chat.missing) {
      skipped.push({ id: chat.id, reason: "no-transcript" });
      continue;
    }
    const worktree = state.worktrees?.[chat.worktreeId];
    if (!worktree) {
      skipped.push({ id: chat.id, reason: "no-worktree" });
      continue;
    }
    const sessionId = nextId++;
    const list = (chat.messages ?? []).map((message) => {
      const { createdAt: _createdAt, ...rest } = message;
      return { ...rest, id: nextId++, session_id: sessionId };
    });
    const summary = summarizeChat(list);
    if (list.length) {
      if (chat.updatedAt) summary.lastAt = chat.updatedAt;
      if (chat.createdAt ?? chat.updatedAt) summary.firstAt = chat.createdAt ?? chat.updatedAt;
    }
    sessions[sessionId] = {
      id: sessionId,
      worktree_id: worktree.id,
      agent_name: worktree.name,
      status: list.length ? "Stopped" : "Created",
      title: chat.title,
      importedFrom: { source: chat.source, id: chat.id },
      ...(chat.provider ? { provider: chat.provider } : {}),
      ...(chat.nativeId ? { native_session_id: chat.nativeId } : {}),
      ...(chat.archived ? { archived: true } : {}),
      summary,
    };
    messages.push(...list);
    known.add(chat.id);
    if (chat.nativeId) known.add(`native:${chat.nativeId}`);
    added.push({ id: chat.id, sessionId });
  }
  if (!added.length) return { state, added, skipped };
  return { state: { ...state, next_id: nextId, sessions, messages }, added, skipped };
}

module.exports = { addImportedChats, worktreeFor, importedIds };
