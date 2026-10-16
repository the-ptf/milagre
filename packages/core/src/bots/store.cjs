const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { database } = require("../chat-db.cjs");

// <dataDir>/angelo.db: what a bot keeps that is not a Chat (types in @milagre/shared/bots). Records are JSON; the
// columns the store looks things up by sit beside them. One connection stays open for the daemon's life, so each
// call is one synchronous statement.

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, record TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS gates (
    request_id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    chat_key TEXT NOT NULL,
    record TEXT NOT NULL,
    status TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS gates_status ON gates (status, expires_at);
  CREATE TABLE IF NOT EXISTS grants (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    gate TEXT NOT NULL,
    target TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS grants_bot ON grants (bot_id, gate, target);
  CREATE TABLE IF NOT EXISTS bot_chats (chat_key TEXT PRIMARY KEY, bot_id TEXT NOT NULL, record TEXT NOT NULL, status TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS bot_chats_bot ON bot_chats (bot_id);
`;

const gateFrom = (row) => (row ? { ...JSON.parse(row.record), status: row.status } : null);
const chatFrom = (row) => (row ? { ...JSON.parse(row.record), status: row.status } : null);
const grantFrom = (row) => ({
  id: row.id,
  botId: row.bot_id,
  gate: row.gate,
  target: row.target,
  createdAt: row.created_at,
  revokedAt: row.revoked_at ?? null,
});

function createBotStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Made private before SQLite writes to it; chmod covers a file an older run left with wider bits.
  fs.closeSync(fs.openSync(file, "a", 0o600));
  fs.chmodSync(file, 0o600);
  const db = new (database().DatabaseSync)(file);
  db.exec(SCHEMA);
  const statements = new Map();
  const sql = (text) => {
    if (!statements.has(text)) statements.set(text, db.prepare(text));
    return statements.get(text);
  };

  function setting(key, fallback) {
    const row = sql("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  function getBot(id) {
    const row = sql("SELECT record FROM bots WHERE id = ?").get(id);
    return row ? JSON.parse(row.record) : null;
  }
  function gate(requestId) {
    return gateFrom(sql("SELECT record, status FROM gates WHERE request_id = ?").get(requestId));
  }

  return {
    enabled: () => setting("enabled", false) === true,
    setEnabled(value) {
      sql("INSERT INTO settings (key, value) VALUES ('enabled', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(Boolean(value)));
    },

    listBots: () =>
      sql("SELECT record FROM bots ORDER BY rowid")
        .all()
        .map((row) => JSON.parse(row.record)),
    getBot,
    insertBot(record) {
      sql("INSERT INTO bots (id, record) VALUES (?, ?)").run(record.id, JSON.stringify(record));
    },
    /** Merges the patch into the stored bot; its id never changes. */
    updateBot(id, patch) {
      const current = getBot(id);
      if (!current) throw new Error(`No bot ${id}.`);
      const next = { ...current, ...patch, id };
      sql("UPDATE bots SET record = ? WHERE id = ?").run(JSON.stringify(next), id);
      return next;
    },
    /** Removes the bot with its sign-offs and grants. Its Chat rows stay: the Chats are the user's now. */
    deleteBot(id) {
      db.exec("BEGIN");
      try {
        sql("DELETE FROM bots WHERE id = ?").run(id);
        sql("DELETE FROM gates WHERE bot_id = ?").run(id);
        sql("DELETE FROM grants WHERE bot_id = ?").run(id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    recordGate(record) {
      const { status, ...rest } = record;
      sql("INSERT OR REPLACE INTO gates (request_id, bot_id, chat_key, record, status, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        record.requestId,
        record.botId,
        record.chatKey,
        JSON.stringify(rest),
        status,
        record.meta.expiresAt,
      );
    },
    gate,
    setGateStatus(requestId, status) {
      sql("UPDATE gates SET status = ? WHERE request_id = ?").run(status, requestId);
    },
    pendingGates: () => sql("SELECT record, status FROM gates WHERE status = 'pending' ORDER BY rowid").all().map(gateFrom),
    /** Pending sign-offs, and the ones that ended (answered or expired) with an expiry after `since`: what cards show. */
    gatesSince: (since) => sql("SELECT record, status FROM gates WHERE status = 'pending' OR expires_at > ? ORDER BY rowid").all(since).map(gateFrom),
    /** Pending sign-offs whose hour is up at `now`. */
    expiredGates: (now) => sql("SELECT record, status FROM gates WHERE status = 'pending' AND expires_at <= ? ORDER BY rowid").all(now).map(gateFrom),

    addGrant({ botId, gate: kind, target, createdAt }) {
      const id = randomUUID();
      sql("INSERT INTO grants (id, bot_id, gate, target, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)").run(id, botId, kind, target, createdAt);
      return { id, botId, gate: kind, target, createdAt, revokedAt: null };
    },
    /** Grants still in force, oldest first; revoked ones are kept in the table but not listed. */
    grants: (botId) =>
      (botId === undefined
        ? sql("SELECT * FROM grants WHERE revoked_at IS NULL ORDER BY created_at, rowid").all()
        : sql("SELECT * FROM grants WHERE bot_id = ? AND revoked_at IS NULL ORDER BY created_at, rowid").all(botId)
      ).map(grantFrom),
    hasGrant: (botId, kind, target) =>
      Boolean(sql("SELECT 1 FROM grants WHERE bot_id = ? AND gate = ? AND target = ? AND revoked_at IS NULL LIMIT 1").get(botId, kind, target)),
    revokeGrant(id, now) {
      sql("UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id);
    },

    linkChat(record) {
      const { status, ...rest } = record;
      sql("INSERT OR REPLACE INTO bot_chats (chat_key, bot_id, record, status) VALUES (?, ?, ?, ?)").run(
        record.chatKey,
        record.botId,
        JSON.stringify(rest),
        status,
      );
    },
    chat: (chatKey) => chatFrom(sql("SELECT record, status FROM bot_chats WHERE chat_key = ?").get(chatKey)),
    chatsFor: (botId) => sql("SELECT record, status FROM bot_chats WHERE bot_id = ? ORDER BY rowid").all(botId).map(chatFrom),
    setChatStatus(chatKey, status) {
      sql("UPDATE bot_chats SET status = ? WHERE chat_key = ?").run(status, chatKey);
    },

    close() {
      if (db.isOpen) db.close();
    },
  };
}

module.exports = { createBotStore };
