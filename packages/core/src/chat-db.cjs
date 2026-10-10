const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

// A Project's messages, one row each, in <project>/.milagre/chats.db (see ADR-0007). coordination.json keeps everything
// else, with `messages` set to MESSAGES_MARKER. The rows keep each message's place in the Project's order (`position`, a
// sort key: increasing along the Project's array, with gaps), so the array reads back in the order it had, and its global
// id, which numbers messages across Chats. The daemon holds only some Chats' messages in memory (see message-store.cjs);
// the rows of the others are the only copy, and a save leaves them as they are.

const MESSAGES_MARKER = Object.freeze({ storedIn: "chats.db", format: 2 });
const isMarker = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value) && value.storedIn === "chats.db");
const dbFile = (projectPath) => path.join(projectPath, ".milagre", "chats.db");
const NONE = Object.freeze(new Set());

let sqlite;
/** node:sqlite, loaded once without its "experimental" warning (Node 24 still marks it so; Electron 44 ships it). */
function database() {
  if (!sqlite) {
    const emit = process.emitWarning;
    process.emitWarning = (warning, ...rest) => {
      if (String(warning?.message ?? warning).includes("SQLite is an experimental feature")) return;
      return emit.call(process, warning, ...rest);
    };
    try {
      sqlite = require("node:sqlite");
    } finally {
      process.emitWarning = emit;
    }
  }
  return sqlite;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id NOT NULL UNIQUE,
    session_id INTEGER,
    position INTEGER NOT NULL,
    client_message_id TEXT,
    operation_id TEXT,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_session ON messages (session_id, position);
  CREATE INDEX IF NOT EXISTS messages_position ON messages (position);
`;

/** Opens the Project's database for one read or write and closes it after; a save is a few writes a second at most. */
async function withDatabase(projectPath, work, { create = false } = {}) {
  const file = dbFile(projectPath);
  if (create) await fs.mkdir(path.dirname(file), { recursive: true });
  else
    try {
      await fs.access(file);
    } catch {
      return work(null);
    }
  return open(file, work);
}

/** withDatabase for a read that can't wait: loading a Chat inside a change to the state, which runs to its end in one go. */
function withDatabaseSync(projectPath, work) {
  const file = dbFile(projectPath);
  if (!fsSync.existsSync(file)) return work(null);
  return open(file, work);
}

function open(file, work) {
  const db = new (database().DatabaseSync)(file);
  try {
    db.exec(SCHEMA);
    return work(db);
  } finally {
    db.close();
  }
}

/** The Project's messages in their saved order, each with its position; null when it has no database. */
function readRows(projectPath) {
  return withDatabase(projectPath, (db) =>
    db
      ? db
          .prepare("SELECT session_id, position, payload FROM messages ORDER BY position, id")
          .all()
          .map((row) => ({ message: JSON.parse(row.payload), position: row.position, chat: row.session_id }))
      : null,
  );
}

/** The Project's messages in their saved order; null when it has no database. */
async function readMessages(projectPath) {
  return (await readRows(projectPath))?.map((row) => row.message) ?? null;
}

const chatList = (chats) => JSON.stringify([...chats].map(Number));

/** The rows of the Chats `chats` (ids), in the Project's order, each { message, position, chat }. Synchronous. */
function readChatRows(projectPath, chats) {
  if (!chats.size && !chats.length) return [];
  return withDatabaseSync(projectPath, (db) =>
    db
      ? db
          .prepare("SELECT session_id, position, payload FROM messages WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY position, id")
          .all(chatList(chats))
          .map((row) => ({ message: JSON.parse(row.payload), position: row.position, chat: row.session_id }))
      : [],
  );
}

/**
 * What a search needs of the messages of the Chats `chats`, without reading them whole: { id, session_id, role, body } in the
 * Project's order, each with its position. Synchronous.
 */
function readChatBodies(projectPath, chats) {
  if (!chats.size && !chats.length) return [];
  return withDatabaseSync(projectPath, (db) =>
    db
      ? db
          .prepare(
            "SELECT id, session_id, position, json_extract(payload, '$.role') AS role, json_extract(payload, '$.body') AS body FROM messages WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY position, id",
          )
          .all(chatList(chats))
          .map((row) => ({
            message: { id: row.id, session_id: row.session_id, role: row.role, body: row.body ?? "" },
            position: row.position,
            chat: row.session_id,
          }))
      : [],
  );
}

/** At most 240 characters from the last assistant reply of each requested Chat, without reading transcripts. */
function readChatPreviews(projectPath, chats) {
  if (!chats.size && !chats.length) return [];
  return withDatabaseSync(projectPath, (db) =>
    db
      ? db
          .prepare(
            "SELECT session_id, substr(json_extract(payload, '$.body'), 1, 240) AS body FROM messages WHERE id IN (SELECT (SELECT id FROM messages WHERE session_id = value AND json_extract(payload, '$.role') = 'assistant' ORDER BY position DESC, id DESC LIMIT 1) FROM json_each(?))",
          )
          .all(chatList(chats))
          .map((row) => ({
            session_id: row.session_id,
            role: "assistant",
            body: (row.body ?? "").slice(0, 240),
          }))
      : [],
  );
}

/** { id, session_id, role, outcome, clientMessageId } of the messages of the Chats `chats`, in the Project's order. Synchronous. */
function readChatMarks(projectPath, chats) {
  if (!chats.size && !chats.length) return [];
  return withDatabaseSync(projectPath, (db) =>
    db
      ? db
          .prepare(
            "SELECT id, session_id, position, client_message_id, json_extract(payload, '$.role') AS role, json_extract(payload, '$.outcome') AS outcome FROM messages WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY position, id",
          )
          .all(chatList(chats))
          .map((row) => ({
            message: {
              id: row.id,
              session_id: row.session_id,
              role: row.role ?? undefined,
              outcome: row.outcome ?? undefined,
              clientMessageId: row.client_message_id ?? undefined,
            },
            position: row.position,
            chat: row.session_id,
          }))
      : [],
  );
}

/** The rows of the Chats `chats` whose saved JSON contains one of `needles`, in the Project's order. Synchronous. */
function readChatRowsContaining(projectPath, chats, needles) {
  if ((!chats.size && !chats.length) || !needles.length) return [];
  return withDatabaseSync(projectPath, (db) =>
    db
      ? db
          .prepare(
            `SELECT session_id, position, payload FROM messages WHERE session_id IN (SELECT value FROM json_each(?)) AND (${needles.map(() => "instr(payload, ?) > 0").join(" OR ")}) ORDER BY position, id`,
          )
          .all(chatList(chats), ...needles)
          .map((row) => ({ message: JSON.parse(row.payload), position: row.position, chat: row.session_id }))
      : [],
  );
}

/** id -> { position, chat } of the saved rows of messages `ids`. Synchronous. */
function readPositions(projectPath, ids) {
  return withDatabaseSync(projectPath, (db) =>
    db
      ? new Map(
          db
            .prepare("SELECT id, session_id, position FROM messages WHERE id IN (SELECT value FROM json_each(?))")
            .all(JSON.stringify([...ids]))
            .map((row) => [row.id, { position: row.position, chat: row.session_id }]),
        )
      : new Map(),
  );
}

const LOOKUPS = { id: "id", operationId: "operation_id", clientMessageId: "client_message_id" };
/** The first saved message (in the Project's order) of a Chat in `chats` whose `field` (id, operationId or clientMessageId) is `value`. */
function findRow(projectPath, chats, field, value) {
  const column = LOOKUPS[field];
  if (!column) throw new Error(`Messages can't be looked up by ${field}`);
  if (!chats.size && !chats.length) return null;
  return withDatabaseSync(projectPath, (db) => {
    const row = db
      ?.prepare(
        `SELECT session_id, position, payload FROM messages WHERE ${column} = ? AND session_id IN (SELECT value FROM json_each(?)) ORDER BY position LIMIT 1`,
      )
      .get(value, chatList(chats));
    return row ? { message: JSON.parse(row.payload), position: row.position, chat: row.session_id } : null;
  });
}

/** The details sidecars the saved messages of the Chats `chats` point at. */
function readDetailRefs(projectPath, chats) {
  if (!chats.size && !chats.length) return new Set();
  return withDatabaseSync(projectPath, (db) => {
    if (!db) return new Set();
    const rows = db
      .prepare(
        "SELECT DISTINCT json_extract(payload, '$.detailFile') AS name FROM messages WHERE session_id IN (SELECT value FROM json_each(?)) AND json_extract(payload, '$.detailFile') IS NOT NULL",
      )
      .all(chatList(chats));
    return new Set(rows.map((row) => row.name).filter((name) => typeof name === "string"));
  });
}

/**
 * Writes `messages`, the messages of every Chat the state holds in memory, in the Project's order. `saved` maps each
 * message id to { message, position, chat } as chats.db holds it, for those Chats: rows whose message object and
 * position are unchanged aren't written again, and rows in `saved` that `messages` no longer has are deleted. Without
 * `saved` (the first save of a run, or a Project moving from coordination.json) it is read from the database.
 *
 * `keep` lists the Chats whose messages the state doesn't hold (see message-store.cjs): their rows stay as they are,
 * whatever `saved` says. `drop` lists Chats of that kind that are gone from the state: their rows are deleted.
 *
 * A message keeps its position while that keeps the order increasing along `messages`; one that would break it (a
 * message added, or re-sent after the reply before it split) takes a position after every row. Then the positions
 * are numbered 0..n-1 again where a removal left gaps. All in one transaction. Returns the map to pass next time
 * (`saved` itself, updated, when given), also handed to `commit(map, stats)` right after the transaction, before any
 * other code runs. `stats`, when given, gets how many rows were written and removed, and whether positions were
 * numbered again (`renumbered`).
 * @param {string} projectPath
 * @param {any[]} messages
 * @param {Map<any, { message: any, position: number, chat: any }> | null | undefined} saved
 * @param {{ durable?: boolean, keep?: ReadonlySet<any>, drop?: ReadonlySet<any>, stats?: { written: number, removed: number, renumbered?: boolean }, commit?: (saved: Map<any, any>, stats: { written: number, removed: number, renumbered?: boolean }) => void }} [options]
 */
function writeMessages(
  projectPath,
  messages,
  saved,
  { durable = false, keep = NONE, drop = NONE, stats = { written: 0, removed: 0, renumbered: false }, commit } = {},
) {
  return withDatabase(
    projectPath,
    (db) => {
      db.exec(`PRAGMA synchronous = ${durable ? "FULL" : "NORMAL"}`);
      const upsert = db.prepare(
        `INSERT INTO messages (id, session_id, position, client_message_id, operation_id, payload) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET session_id = excluded.session_id, position = excluded.position,
           client_message_id = excluded.client_message_id, operation_id = excluded.operation_id, payload = excluded.payload`,
      );
      const remove = db.prepare("DELETE FROM messages WHERE id = ?");
      const removeChat = db.prepare("DELETE FROM messages WHERE session_id = ?");
      stats.written = 0;
      stats.removed = 0;
      stats.renumbered = false;
      const writes = [];
      const removals = [];
      let renumbered = null;
      db.exec("BEGIN");
      try {
        const known =
          saved ??
          new Map(
            db
              .prepare("SELECT id, session_id, position FROM messages")
              .all()
              .map((row) => [row.id, { message: undefined, position: row.position, chat: row.session_id }]),
          );
        // A message the map lacks but chats.db has (a Chat loaded while the save that made the map ran) keeps its row's
        // place instead of moving after every row.
        const unknown = saved ? messages.filter((message) => !saved.has(message.id)).map((message) => message.id) : [];
        const found = unknown.length
          ? new Map(
              db
                .prepare("SELECT id, session_id, position FROM messages WHERE id IN (SELECT value FROM json_each(?))")
                .all(JSON.stringify(unknown))
                .map((row) => [row.id, { message: undefined, position: row.position, chat: row.session_id }]),
            )
          : null;
        const lookup = (id) => known.get(id) ?? found?.get(id);
        let top = db.prepare("SELECT MAX(position) AS top FROM messages").get()?.top ?? -1;
        let previous = -Infinity;
        const ids = new Set();
        for (const message of messages) {
          const last = lookup(message.id);
          const position = last && last.position > previous ? last.position : ++top;
          previous = position;
          ids.add(message.id);
          if (!last || last.message !== message || last.position !== position) {
            upsert.run(message.id, message.session_id ?? null, position, message.clientMessageId ?? null, message.operationId ?? null, JSON.stringify(message));
            stats.written++;
          }
          writes.push([message.id, { message, position, chat: message.session_id ?? null }]);
        }
        for (const [id, row] of known)
          if (!ids.has(id) && !keep.has(row.chat)) {
            remove.run(id);
            removals.push(id);
            stats.removed++;
          }
        for (const chat of drop) stats.removed += Number(removeChat.run(chat).changes);
        // Positions go back to 0..n-1 in the Project's order, as releases before ADR-0009 wrote and expect them: one
        // of those adds a message at the array's length, which must come after every row.
        const { last, count } = db.prepare("SELECT MAX(position) AS last, COUNT(*) AS count FROM messages").get();
        if (count && last !== count - 1) {
          db.exec(`WITH ranked AS (SELECT id, ROW_NUMBER() OVER (ORDER BY position, id) - 1 AS rank FROM messages)
            UPDATE messages SET position = ranked.rank FROM ranked WHERE messages.id = ranked.id AND messages.position != ranked.rank`);
          renumbered = new Map(
            db
              .prepare("SELECT id, position FROM messages")
              .all()
              .map((row) => [row.id, row.position]),
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      // What chats.db holds now, for the Chats in memory. A map read from the database also held the kept Chats' rows,
      // so a new one is made of what was written.
      const next = saved ?? new Map();
      for (const id of removals) next.delete(id);
      for (const [id, row] of writes) next.set(id, row);
      if (renumbered) {
        stats.renumbered = true;
        for (const [id, row] of next) if (renumbered.has(id)) next.set(id, { ...row, position: renumbered.get(id) });
      }
      // Before anything else runs: a Chat loaded from here on must find its rows in the map chats.db now matches.
      commit?.(next, stats);
      return next;
    },
    { create: true },
  );
}

module.exports = {
  MESSAGES_MARKER,
  isMarker,
  dbFile,
  readRows,
  readMessages,
  readChatRows,
  readChatBodies,
  readChatPreviews,
  readChatRowsContaining,
  readChatMarks,
  readPositions,
  findRow,
  readDetailRefs,
  writeMessages,
  database,
};
