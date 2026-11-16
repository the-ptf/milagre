const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { backgroundWork } = require("@milagre/shared/chat-activity");

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function createAutoUpdate({ file, emit = () => {} }) {
  const enabled = () => read(file)?.autoUpdate === true;
  function setEnabled(value) {
    const autoUpdate = value === true;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ ...read(file), autoUpdate }));
    fs.renameSync(temp, file);
    emit("app-update:auto", { autoUpdate });
    return { autoUpdate };
  }
  return { read: () => ({ autoUpdate: enabled() }), save: setEnabled };
}

/**
 * @param {{ busy: Iterable<string>, scopes: Array<{ key: string, state?: { sessions?: Record<string, any> } }>, routines: number }} input
 */
function hostActivity({ busy, scopes, routines }) {
  const chats = new Set(busy);
  for (const { key, state } of scopes) {
    for (const session of Object.values(state?.sessions ?? {})) {
      if (!session.archived && backgroundWork(session).length > 0) chats.add(`${key}#${session.id}`);
    }
  }
  return { chats: chats.size, routines };
}

module.exports = { createAutoUpdate, hostActivity };
