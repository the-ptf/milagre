const fs = require("node:fs");
const path = require("node:path");
const { database } = require("@milagre/core/chat-db");

// Spec "Offline cache": the transcripts of a computer's last 20 opened chats.
const MAX_CHATS = 20;
const ID = /^[A-Za-z0-9-]{1,64}$/;
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS entries (
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    payload TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (kind, key)
  );
  CREATE INDEX IF NOT EXISTS entries_at ON entries (kind, at);
`;
const checked = (computerId) => {
  if (typeof computerId !== "string" || !ID.test(computerId)) throw new Error("That isn't a computer's id.");
  return computerId;
};

/**
 * Each paired computer's last copy (spec "Offline cache"), in `<dir>/<computerId>/cache.sqlite`, keyed as the computer
 * itself names things (no window qualifier): its Project, Link and registry lists (kinds "recent", "links", "registry",
 * key ""), each scope's last whole state ("scope", by scope key: { name, state }), and its last 20 chat windows ("chat",
 * by chat key: { messages, hasMore, total }). node:sqlite, as ADR-0007; one handle per computer, closed by remove/close.
 * @param {{ dir: string; now?: () => number }} options
 */
function createComputerCaches({ dir, now = Date.now }) {
  /** @type {Map<string, any>} */
  const open = new Map();
  let closed = false;
  function db(computerId) {
    const id = checked(computerId);
    let handle = open.get(id);
    if (!handle) {
      fs.mkdirSync(path.join(dir, id), { recursive: true, mode: 0o700 });
      const raw = new (database().DatabaseSync)(path.join(dir, id, "cache.sqlite"));
      try {
        raw.exec(SCHEMA);
        handle = {
          handle: raw,
          upsert: raw.prepare(
            "INSERT INTO entries (kind, key, payload, at) VALUES (?, ?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET payload = excluded.payload, at = excluded.at",
          ),
          trim: raw.prepare("DELETE FROM entries WHERE kind = 'chat' AND key NOT IN (SELECT key FROM entries WHERE kind = 'chat' ORDER BY at DESC LIMIT ?)"),
          read: raw.prepare("SELECT payload FROM entries WHERE kind = ? AND key = ?"),
        };
      } catch (error) {
        // A garbage file fails here, before the handle is kept: close it so the caller's reset can delete the folder.
        try {
          raw.close();
        } catch {
          /* already unusable */
        }
        throw error;
      }
      open.set(id, handle);
    }
    return handle;
  }
  const CORRUPT = /^(SQLITE_CORRUPT|SQLITE_NOTADB)/;
  const isCorrupt = (error) =>
    error instanceof SyntaxError || CORRUPT.test(String(error?.code ?? error?.errstr ?? "")) || /malformed|not a database/i.test(String(error?.message));
  /** A damaged copy is closed and deleted so it rebuilds; the error still goes on to the caller. */
  function reset(id) {
    try {
      open.get(id)?.handle.close();
    } catch {
      /* already unusable */
    }
    open.delete(id);
    fs.rmSync(path.join(dir, id), { recursive: true, force: true, maxRetries: 5 });
  }
  /** @template T @param {string} id @param {() => T} work @returns {T} */
  function guarded(id, work) {
    try {
      return work();
    } catch (error) {
      if (isCorrupt(error)) reset(id);
      throw error;
    }
  }
  return {
    /** @param {string} computerId @param {string} kind @param {string} key @param {unknown} value @param {string} [text] `value` already serialized */
    put(computerId, kind, key, value, text) {
      const id = checked(computerId);
      if (closed) return;
      guarded(id, () => {
        const { upsert, trim } = db(id);
        upsert.run(kind, key, text ?? JSON.stringify(value), now());
        if (kind === "chat") trim.run(MAX_CHATS);
      });
    },
    /** @param {string} computerId @param {string} kind @param {string} key */
    get(computerId, kind, key) {
      const id = checked(computerId);
      if (closed) return null;
      if (!fs.existsSync(path.join(dir, id, "cache.sqlite"))) return null;
      return guarded(id, () => {
        const row = db(id).read.get(kind, key);
        return row ? JSON.parse(String(row.payload)) : null;
      });
    },
    /** Removing a computer deletes its folder. @param {string} computerId */
    async remove(computerId) {
      const id = checked(computerId);
      open.get(id)?.handle.close();
      open.delete(id);
      await fs.promises.rm(path.join(dir, id), { recursive: true, force: true, maxRetries: 5 });
    },
    close() {
      closed = true;
      for (const { handle } of open.values()) {
        try {
          handle.close();
        } catch {
          /* already closed */
        }
      }
      open.clear();
    },
  };
}

module.exports = { createComputerCaches };
