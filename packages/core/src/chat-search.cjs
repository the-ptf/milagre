const fs = require("node:fs/promises");
const { searchMessages } = require("@milagre/shared/message-search");
const { chatTitle } = require("@milagre/shared/chats");
const { dbFile, isMarker, readChatBodies } = require("./chat-db.cjs");
const { stateFile } = require("./project-store.cjs");

const IDLE_MS = 60_000;
const PER_PROJECT = 200;
const MAX_LIMIT = 500;

const searchable = (message) => ({ id: message.id, session_id: message.session_id, role: message.role, body: message.body ?? "" });
const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

async function stamp(file) {
  try {
    const stat = await fs.stat(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** A Project no window or phone has open, read from its saved files without opening it. Null when it has no Chats. */
async function readSaved(projectPath) {
  const [stateStamp, dbStamp] = await Promise.all([stamp(stateFile(projectPath)), stamp(dbFile(projectPath))]);
  if (!stateStamp) return null;
  return {
    stamp: `${stateStamp}|${dbStamp}`,
    read: async () => {
      const raw = JSON.parse(await fs.readFile(stateFile(projectPath), "utf8"));
      const sessions = raw.sessions ?? {};
      if (!isMarker(raw.messages)) return { sessions, worktrees: raw.worktrees ?? {}, messages: (raw.messages ?? []).map(searchable) };
      if (!dbStamp) throw new Error("Its messages file (.milagre/chats.db) is missing.");
      const rows = readChatBodies(projectPath, Object.keys(sessions).map(Number).filter(Number.isSafeInteger));
      return { sessions, worktrees: raw.worktrees ?? {}, messages: rows.map((row) => row.message) };
    },
  };
}

/**
 * Message search over one scope or every Project on this computer, archived Chats on request. Open scopes are read
 * through scopeStates (unloaded Chats included); others from their saved files without opening them. The word index of
 * each scope is kept while searches keep coming and dropped `IDLE_MS` after the last one.
 */
function createChatSearch({ scopeStates, knownProjects, nameOf, readUnopened = readSaved, idleMs = IDLE_MS }) {
  const held = new Map();
  let idle = null;
  const keep = () => {
    clearTimeout(idle);
    idle = setTimeout(() => held.clear(), idleMs);
    idle.unref?.();
  };

  async function readScope(projectPath, archived) {
    const slot = archived ? "withArchived" : "active";
    const open = scopeStates.has(projectPath);
    const state = open ? await scopeStates.get(projectPath) : null;
    const saved = open ? null : await readUnopened(projectPath);
    if (!open && !saved) return null;
    let entry = held.get(projectPath);
    if (entry?.key !== (open ? state : saved.stamp)) {
      entry = open ? { key: state, sessions: state.sessions ?? {}, worktrees: state.worktrees ?? {} } : { key: saved.stamp, ...(await saved.read()) };
      held.set(projectPath, entry);
    }
    if (!entry[slot]) {
      const wanted = (session) => session && (archived || !session.archived);
      entry[slot] = open
        ? (
            await scopeStates.searchableMessages(
              projectPath,
              Object.values(entry.sessions)
                .filter(wanted)
                .map((session) => session.id),
            )
          ).map(searchable)
        : entry.messages.filter((message) => wanted(entry.sessions[message.session_id]));
    }
    return { sessions: entry.sessions, worktrees: entry.worktrees, messages: entry[slot] };
  }

  function matchesOf(projectPath, projectName, scope, query, perChat) {
    const counts = new Map();
    const found = [];
    for (const match of searchMessages(scope.messages, query, PER_PROJECT)) {
      const chatId = Number(match.message.session_id);
      const session = scope.sessions[chatId];
      if (!session) continue;
      const count = counts.get(chatId) ?? 0;
      if (perChat && count >= perChat) continue;
      counts.set(chatId, count + 1);
      found.push({ projectPath, projectName, session, match });
    }
    return found;
  }

  function describe({ projectPath, projectName, session, match }, scope) {
    const own = session.summary ? [] : scope.messages.filter((message) => message.session_id === session.id);
    const worktree = scope.worktrees[session.worktree_id];
    return {
      projectPath,
      projectName,
      chat: {
        id: session.id,
        title: chatTitle(session, own),
        archived: Boolean(session.archived),
        ...(session.summary?.lastAt ? { lastAt: session.summary.lastAt } : {}),
        ...(worktree?.name ? { branch: worktree.name } : {}),
      },
      message: { id: match.message.id, session_id: match.message.session_id },
      score: match.score,
      snippet: match.snippet,
      highlight: match.highlight,
      term: match.term,
    };
  }

  /**
   * `{ matches, failed, searched }`: matches best first (ties go to the Chat active last), at most `perChat` per Chat;
   * `failed` names each Project that couldn't be read, so "no matches" and "couldn't search" stay apart.
   */
  async function search(query, { scope, archived = false, limit = 100, perChat = 3 } = {}) {
    keep();
    const text = String(query ?? "");
    const bounded = Math.min(Math.max(1, Number(limit) || 100), MAX_LIMIT);
    const projects = scope ? [scope] : await knownProjects();
    const found = [];
    const failed = [];
    let searched = 0;
    for (const projectPath of projects) {
      const projectName = await nameOf(projectPath);
      try {
        const read = await readScope(projectPath, archived === true);
        if (read) {
          searched++;
          for (const item of matchesOf(projectPath, projectName, read, text, perChat)) found.push({ item, read });
        }
      } catch (error) {
        if (scope) throw error;
        failed.push({ projectPath, projectName, error: error instanceof Error ? error.message : String(error) });
      }
      if (!scope) await yieldTurn();
    }
    found.sort(
      (a, b) =>
        b.item.match.score - a.item.match.score ||
        (b.item.session.summary?.lastAt ?? 0) - (a.item.session.summary?.lastAt ?? 0) ||
        b.item.match.message.id - a.item.match.message.id,
    );
    return { matches: found.slice(0, bounded).map(({ item, read }) => describe(item, read)), failed, searched };
  }

  return { search, forget: (projectPath) => held.delete(projectPath) };
}

module.exports = { createChatSearch, readSaved };
