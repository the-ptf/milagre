const fs = require("node:fs/promises");
const path = require("node:path");
const {
  migrateImages,
  compactSubagents,
  hydrateSubagents,
  referencedSidecars,
  sweepSubagentContent,
  compactDetails,
  referencedDetails,
  sweepDetailContent,
} = require("./project-content.cjs");
const { MESSAGES_MARKER, isMarker, readRows, writeMessages } = require("./chat-db.cjs");
const { unloadedChats, savedRows, setSavedRows, resetStore, forgetStore, unloadedDetailRefs, forgetRest, retag } = require("./message-store.cjs");
const { withChatSummaries } = require("./chat-summaries.cjs");
// ProjectStates owns write ordering. This adapter performs one atomic snapshot write.
const stateFile = (projectPath) => path.join(projectPath, ".milagre", "coordination.json");
let counter = 0;

// Per project, session/agent -> digest of the transcript sidecar its saved state points at, so a save
// writes only the agents whose transcript changed. Updated only after the state itself is on disk.
const MAX_PROJECTS = 50;
const settled = new Map();
// Per project, the message rows chats.db holds for the Chats in memory (id -> the message object, position and Chat
// written), so a save writes only the messages that changed: savedRows in message-store.cjs. Set by a read or a save; a
// project without one reads it from chats.db on its next save and rewrites every message in memory.
// Superseded sidecars are removed once the new state is saved; a younger one may belong to a save still in flight.
const SWEEP_MIN_AGE_MS = 60_000;
const swept = new Set();

// Suggestions belong to the live provider query. Reconnects retain them, host restarts do not.
function withoutSuggestions(state) {
  if (!Object.values(state.sessions ?? {}).some((session) => session.suggestion !== undefined || session.suggestionTurnId !== undefined)) return state;
  return {
    ...state,
    sessions: Object.fromEntries(
      Object.entries(state.sessions).map(([id, session]) => {
        const { suggestion: _suggestion, suggestionTurnId: _turn, ...rest } = session;
        return [id, rest];
      }),
    ),
  };
}

// `durable` syncs the bytes and the rename to disk before returning. Only the migration of a linked worktree's old
// chats asks for it, since it renames that file next; routine saves only rename. Resolves to what the save wrote: the
// message rows written and removed, whether it wrote a sidecar, and the size of coordination.json.
async function saveProjectState(projectPath, state, { sweepMinAgeMs = SWEEP_MIN_AGE_MS, durable = false } = {}) {
  const tracker = { known: settled.get(projectPath), next: new Map(), wrote: false };
  // The state in memory is compacted already (see compactProjectDetails); this catches one that wasn't.
  const details = { wrote: false };
  const compacted = await compactDetails(projectPath, await migrateImages(projectPath, state), { tracker: details });
  const persisted = withoutSuggestions(await compactSubagents(projectPath, compacted, tracker));
  // Messages go to chats.db first; coordination.json then points at it. A state from before keeps its array until then.
  // The Chats the state holds unloaded (see message-store.cjs) keep their rows, and those whose Chat is gone lose them.
  // Read from the state given: the copies above hold the same messages, but can hold them in arrays of their own.
  const unloaded = unloadedChats(state);
  const keep = new Set([...unloaded].filter((chat) => Object.hasOwn(persisted.sessions ?? {}, String(chat))));
  const drop = new Set([...unloaded].filter((chat) => !keep.has(chat)));
  let rows;
  const written = { written: 0, removed: 0, renumbered: false };
  if (Array.isArray(persisted.messages)) {
    // The first save after the move keeps the old file once, beside it, in case anything needs it back.
    if (!savedRows(projectPath))
      await fs.copyFile(stateFile(projectPath), `${stateFile(projectPath)}.before-chats-db`, fs.constants.COPYFILE_EXCL).catch(() => {});
    rows = await writeMessages(projectPath, persisted.messages, savedRows(projectPath), {
      durable,
      keep,
      drop,
      stats: written,
      // In the same step as the commit, so a Chat loaded meanwhile is known to the next save.
      commit: (saved, { renumbered }) => {
        setSavedRows(projectPath, saved);
        // A cached copy of a Chat's rows (wholeState) stays true only while nothing writes them or their positions.
        forgetRest(projectPath, renumbered ? { all: true } : { chats: new Set([...persisted.messages.map((message) => Number(message.session_id)), ...drop]) });
      },
    });
  }
  const contents = JSON.stringify(rows ? { ...persisted, messages: MESSAGES_MARKER } : persisted);
  const directory = path.dirname(stateFile(projectPath));
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `coordination.json.${process.pid}.${++counter}.tmp`);
  try {
    if (durable) {
      const handle = await fs.open(temporary, "w");
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else await fs.writeFile(temporary, contents);
    await fs.rename(temporary, stateFile(projectPath));
    if (durable) await syncDirectory(directory);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  if (!settled.has(projectPath) && settled.size >= MAX_PROJECTS) {
    const oldest = settled.keys().next().value;
    settled.delete(oldest);
    swept.delete(oldest);
    forgetStore(oldest);
  }
  settled.set(projectPath, tracker.next);
  // A new sidecar supersedes the one before it; the first save of a run also clears older leftovers.
  if (tracker.wrote || details.wrote || !swept.has(projectPath)) {
    swept.add(projectPath);
    await sweepSubagentContent(projectPath, referencedSidecars(persisted), { minAgeMs: sweepMinAgeMs });
    // The messages of an unloaded Chat point at sidecars too, from their rows.
    const kept = referencedDetails(persisted);
    for (const name of unloadedDetailRefs(projectPath, state)) kept.add(name);
    await sweepDetailContent(projectPath, kept, { minAgeMs: sweepMinAgeMs });
  }
  return {
    rowsWritten: written.written,
    rowsRemoved: written.removed,
    sidecarsWritten: tracker.wrote || details.wrote,
    stateBytes: Buffer.byteLength(contents),
  };
}
/**
 * The saved state, with its messages read from chats.db, subagent transcripts read back and long step details (from
 * before sidecars) moved out. It holds every Chat's messages; ProjectStates unloads the idle ones later.
 */
async function readProjectState(projectPath) {
  const raw = withoutSuggestions(JSON.parse(await fs.readFile(stateFile(projectPath), "utf8")));
  resetStore(projectPath);
  if (isMarker(raw.messages)) {
    const rows = await readRows(projectPath);
    if (!rows) throw new Error(`This Project's messages are kept in ${path.join(projectPath, ".milagre", "chats.db")}, which is missing.`);
    raw.messages = rows.map((row) => row.message);
    setSavedRows(projectPath, new Map(rows.map((row) => [row.message.id, row])));
  }
  const state = await hydrateSubagents(projectPath, raw);
  return compactDetails(projectPath, state);
}
/** For ProjectStates: moves the long step details of the messages a change added into sidecars. */
async function compactProjectDetails(projectPath, next, previous) {
  if (next.messages === previous?.messages) return next;
  const compacted = await compactDetails(projectPath, next, { previous: previous?.messages });
  // The same messages, so the same Chats unloaded (see message-store.cjs).
  retag(next.messages, compacted.messages);
  return compacted;
}
/** For ProjectStates: what every change goes through before it is kept (tool output moved out, Chat summaries current). */
async function compactProjectState(projectPath, next, previous) {
  return withChatSummaries(await compactProjectDetails(projectPath, next, previous), previous);
}
/** Makes a rename in `directory` durable. Best effort: a file system that can't sync a folder still saves. */
async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
  } finally {
    await handle?.close().catch(() => {});
  }
}
module.exports = { saveProjectState, readProjectState, compactProjectDetails, compactProjectState, stateFile, syncDirectory };
