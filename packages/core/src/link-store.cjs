const fs = require("node:fs/promises");
const path = require("node:path");
const { validLinkId } = require("@milagre/shared/chat-scopes");
const { ProjectStates } = require("./project-states.cjs");
const { readProjectState, saveProjectState, compactProjectState } = require("./project-store.cjs");

/** `active(id, chatId)` says whether a shared Chat's turn is busy, so its messages stay in memory (see ProjectStates). */
function createLinkStore({ dataDir, active = () => true, lazyMessages = {}, persistenceChanged }) {
  const root = path.join(dataDir, "links");
  const directory = (id) => {
    if (!validLinkId(id)) throw new Error("Invalid Link ID");
    return path.join(root, id);
  };
  const states = new ProjectStates({
    persistenceChanged,
    read: async (id) => {
      try {
        return await readProjectState(directory(id));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return { next_id: 1, sessions: {}, messages: [], preparations: {} };
      }
    },
    save: (id, state) => saveProjectState(directory(id), state, { durable: true }),
    compact: (id, next, previous) => compactProjectState(directory(id), next, previous),
    messages: { directory, active, ...lazyMessages },
  });
  const checked =
    (read) =>
    (id, ...rest) => {
      directory(id);
      return read(id, ...rest);
    };
  return {
    directory,
    withPersistence: (id, state) => states.withPersistence(id, state),
    cached: (id) => states.states.get(id),
    has: (id) => states.has(id),
    ids: () => states.projects(),
    get: checked((id) => states.get(id)),
    update: checked((id, change, options) => states.update(id, change, options)),
    load: checked((id, chats) => states.load(id, chats)),
    allMessages: checked((id, options) => states.allMessages(id, options)),
    chatMessages: checked((id, chats) => states.chatMessages(id, chats)),
    inboxState: checked((id) => states.inboxState(id)),
    messageMarks: checked((id, options) => states.messageMarks(id, options)),
    messagesContaining: checked((id, needles) => states.messagesContaining(id, needles)),
    searchableMessages: checked((id, chats) => states.searchableMessages(id, chats)),
    findMessage: checked((id, field, value) => states.findMessage(id, field, value)),
    unloadIdle: () => states.unloadIdle(),
    retry: checked((id) => states.retry(id)),
    flush: (id) => states.flush(id),
    close: () => states.close(),
    async ownedWorktrees() {
      const ids = new Set(states.projects());
      try {
        for (const name of await fs.readdir(root)) if (validLinkId(name)) ids.add(name);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const owned = new Map();
      for (const id of ids) {
        const state = await states.get(id);
        for (const session of Object.values(state.sessions))
          for (const member of session.worktrees ?? []) owned.set(member.worktreePath, { linkId: id, sessionId: session.id });
        for (const prep of Object.values(state.preparations))
          for (const member of prep.members) owned.set(member.worktreePath, { linkId: id, sessionId: prep.chatId });
      }
      return owned;
    },
  };
}
module.exports = { createLinkStore };
