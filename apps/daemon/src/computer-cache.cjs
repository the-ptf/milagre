const fs = require("node:fs");
const path = require("node:path");
const { hash } = require("node:crypto");
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
 * It is a copy, so it is written write-ahead without waiting for the disk (a crash may lose the last writes, never the
 * file), and a copy the same as the last one written is not written again.
 * @param {{ dir: string; now?: () => number }} options
 */
function createComputerCaches({ dir, now = Date.now }) {
  /** @type {Map<string, any>} */
  const open = new Map();
  // Per computer, a digest of what each (kind, key) last wrote. Every read of a list (project:recent, link:list, Routines)
  // and every open of a Project (a 1.3 MB state) put its copy again, most of them unchanged; those write nothing now.
  /** @type {Map<string, Map<string, string>>} */
  const written = new Map();
  let closed = false;
  function db(computerId) {
    const id = checked(computerId);
    let handle = open.get(id);
    if (!handle) {
      fs.mkdirSync(path.join(dir, id), { recursive: true, mode: 0o700 });
      const raw = new (database().DatabaseSync)(path.join(dir, id, "cache.sqlite"));
      try {
        // A rollback journal with full syncs wrote a 1.3 MB state into its journal and the file, waiting on the disk for both.
        raw.exec("PRAGMA journal_mode = WAL");
        raw.exec("PRAGMA synchronous = NORMAL");
        raw.exec(SCHEMA);
        handle = {
          handle: raw,
          upsert: raw.prepare(
            "INSERT INTO entries (kind, key, payload, at) VALUES (?, ?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET payload = excluded.payload, at = excluded.at",
          ),
          trim: raw.prepare("DELETE FROM entries WHERE kind = 'chat' AND key NOT IN (SELECT key FROM entries WHERE kind = 'chat' ORDER BY at DESC LIMIT ?)"),
          touch: raw.prepare("UPDATE entries SET at = ? WHERE kind = ? AND key = ?"),
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
    written.delete(id);
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
        const { upsert, trim, touch } = db(id);
        const payload = text ?? JSON.stringify(value);
        const digest = hash("sha256", payload, "base64");
        const slot = `${kind}\n${key}`;
        let kept = written.get(id);
        if (kept?.get(slot) === digest) {
          // The same copy: a chat still counts as opened now, for the MAX_CHATS kept.
          if (kind === "chat") touch.run(now(), kind, key);
          return;
        }
        upsert.run(kind, key, payload, now());
        if (!kept) written.set(id, (kept = new Map()));
        // Chats past MAX_CHATS are deleted: what they last wrote no longer stands for a row.
        if (kind === "chat" && Number(trim.run(MAX_CHATS).changes) > 0) for (const other of kept.keys()) if (other.startsWith("chat\n")) kept.delete(other);
        kept.set(slot, digest);
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
      written.delete(id);
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
      written.clear();
    },
  };
}

module.exports = { createComputerCaches };
