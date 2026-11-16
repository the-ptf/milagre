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
const stateFile = (projectPath) => path.join(projectPath, ".milagre", "coordination.json");
let counter = 0;

const MAX_PROJECTS = 50;
const settled = new Map();
const SWEEP_MIN_AGE_MS = 60_000;
const swept = new Set();

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

async function saveProjectState(projectPath, state, { sweepMinAgeMs = SWEEP_MIN_AGE_MS, durable = false } = {}) {
  const tracker = { known: settled.get(projectPath), next: new Map(), wrote: false };
  const details = { wrote: false };
  const compacted = await compactDetails(projectPath, await migrateImages(projectPath, state), { tracker: details });
  const persisted = withoutSuggestions(await compactSubagents(projectPath, compacted, tracker));
  const unloaded = unloadedChats(state);
  const keep = new Set([...unloaded].filter((chat) => Object.hasOwn(persisted.sessions ?? {}, String(chat))));
  const drop = new Set([...unloaded].filter((chat) => !keep.has(chat)));
  let rows;
  const written = { written: 0, removed: 0, renumbered: false };
  if (Array.isArray(persisted.messages)) {
    if (!savedRows(projectPath))
      await fs.copyFile(stateFile(projectPath), `${stateFile(projectPath)}.before-chats-db`, fs.constants.COPYFILE_EXCL).catch(() => {});
    rows = await writeMessages(projectPath, persisted.messages, savedRows(projectPath), {
      durable,
      keep,
      drop,
      stats: written,
      commit: (saved, { renumbered }) => {
        setSavedRows(projectPath, saved);
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
  if (tracker.wrote || details.wrote || !swept.has(projectPath)) {
    swept.add(projectPath);
    await sweepSubagentContent(projectPath, referencedSidecars(persisted), { minAgeMs: sweepMinAgeMs });
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
async function compactProjectDetails(projectPath, next, previous) {
  if (next.messages === previous?.messages) return next;
  const compacted = await compactDetails(projectPath, next, { previous: previous?.messages });
  retag(next.messages, compacted.messages);
  return compacted;
}
async function compactProjectState(projectPath, next, previous) {
  return withChatSummaries(await compactProjectDetails(projectPath, next, previous), previous);
}
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
