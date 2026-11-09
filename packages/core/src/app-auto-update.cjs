const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { backgroundWork } = require("@milagre/shared/chat-activity");

// Auto update: the desktop installs an update it downloaded by itself once nothing runs on this computer, for a Mac
// nobody watches (a server). The host keeps the switch, so the Mac's Settings, the phone and a paired desktop all flip
// the same one, and says what runs, so the desktop knows when a restart stops nothing (desktop app-updates.cjs).

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The switch, saved in `file`. A change goes out as `app-update:auto` so the desktop's updater follows it at once. */
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
 * What a restart would stop: Chats with a turn going (or about to start, `busy`), or with background work the sidebar
 * still shows as working (a background subagent, command or advisor), and Routine Runs under way. Archived Chats count
 * only through `busy`, as the inbox leaves them out.
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
