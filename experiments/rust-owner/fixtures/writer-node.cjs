#!/usr/bin/env node
// The Node side of the writer conformance tests (tests/writer.rs, tests/locks.rs). Runs the real Node writers.
//
//   node writer-node.cjs run <scenarios.json> <name> <project-dir>    # scenario steps, one JSON result line per step
//   node writer-node.cjs snapshot <project-dir>                       # what a step left on disk, as JSON
//   node writer-node.cjs crash-mid-transaction <project-dir>          # SIGKILL inside a chats.db transaction
//   node writer-node.cjs try-lock <lock-dir>                          # acquireOwnership once, release, report
//   node writer-node.cjs hold-lock <lock-dir>                         # acquireOwnership, print "held", release on stdin end
//
// Only ever pointed at temporary folders the tests create.

const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const repo = path.resolve(__dirname, "../../..");
// oxlint-disable-next-line no-underscore-dangle -- the one hook that maps a workspace package without node_modules
const resolve = Module._resolveFilename;
// oxlint-disable-next-line no-underscore-dangle
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@milagre/shared/")) return path.join(repo, "packages/shared/src", `${request.slice("@milagre/shared/".length)}.mjs`);
  return resolve.call(this, request, ...rest);
};
const source = (name) => path.join(repo, "packages/core/src", name);
const STORAGE = ["project-store.cjs", "message-store.cjs", "chat-db.cjs", "project-content.cjs"].map(source);

/** The storage modules, fresh: a restart drops their per-process state (saved rows, settled digests, sweeps). */
function load({ fresh = false } = {}) {
  if (fresh) for (const file of STORAGE) delete require.cache[require.resolve(file)];
  return {
    store: require(source("project-store.cjs")),
    messages: require(source("message-store.cjs")),
    db: require(source("chat-db.cjs")),
  };
}

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function placeholders(dir) {
  const real = fs.realpathSync(dir);
  return (text) =>
    text
      .split(real)
      .join("<project>")
      .split(dir)
      .join("<project>")
      .replace(/coordination\.json\.\d+\.\d+\.tmp/g, "coordination.json.<tmp>");
}

/** Files (mode and content hash; JSON text with the folder's path replaced), rows, and Node's read of a copy. */
async function snapshot(dir) {
  const clean = placeholders(dir);
  const files = [];
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(folder, entry.name);
      const rel = path.relative(dir, full);
      if (rel === path.join(".milagre", "runtime.lock") || rel === path.join(".milagre", "chats.db")) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(full);
        const content = entry.name.includes(".json") ? Buffer.from(clean(bytes.toString("utf8"))) : bytes;
        // A crash's rollback journal holds raw database pages (with the SQLite version that wrote them): only whether
        // it is there is comparable. What it rolls back to is compared through the rows after recovery.
        const journal = /-(journal|wal)$/.test(entry.name);
        files.push([rel, (fs.statSync(full).mode & 0o777).toString(8), journal ? "present" : sha(content)]);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  const file = path.join(dir, ".milagre", "chats.db");
  let rows = null;
  if (fs.existsSync(`${file}-journal`) && fs.statSync(`${file}-journal`).size > 0) rows = "hot journal";
  else if (fs.existsSync(file)) {
    const { DatabaseSync } = load().db.database();
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      rows = db
        .prepare(
          "SELECT id, typeof(id) AS tid, session_id, typeof(session_id) AS tsession, position, typeof(position) AS tposition, client_message_id, hex(client_message_id) AS hclient, operation_id, payload FROM messages ORDER BY position, id",
        )
        .all()
        .map((row) => [
          row.id,
          row.tid,
          row.session_id,
          row.tsession,
          row.position,
          row.tposition,
          row.client_message_id,
          row.hclient,
          row.operation_id,
          clean(row.payload),
        ]);
    } finally {
      db.close();
    }
  }
  // How Node reads what is there now (on a throwaway copy: the read may write).
  let read = null;
  if (fs.existsSync(path.join(dir, ".milagre", "coordination.json")) && rows !== "hot journal") {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "owner-read-"));
    fs.cpSync(dir, copy, { recursive: true, filter: (from) => !from.includes(`${path.sep}runtime.lock`) });
    try {
      const { store } = load({ fresh: true });
      const state = await store.readProjectState(copy);
      // Stored image paths name the original folder, the read copy names its own: both become <project>.
      read = sha(clean(placeholders(copy)(JSON.stringify(state))));
    } catch (error) {
      read = `error: ${placeholders(copy)(error.message)}`;
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
      load({ fresh: true });
    }
  }
  return { files, rows, read };
}

// ---- scenarios ---------------------------------------------------------------------------------------------------

/** Applies a state step (shared with tests/writer.rs, which applies the same JSON in Rust). */
function apply(state, step) {
  switch (step.op) {
    case "set":
      return structuredClone(step.state);
    case "append":
      return { ...state, messages: [...state.messages, ...structuredClone(step.messages)] };
    case "remove":
      return { ...state, messages: state.messages.filter((message) => !step.ids.includes(message.id)) };
    case "update":
      return { ...state, messages: state.messages.map((message) => (message.id === step.id ? { ...message, ...structuredClone(step.patch) } : message)) };
    case "move": {
      const moving = state.messages.find((message) => message.id === step.id);
      const rest = state.messages.filter((message) => message !== moving);
      rest.splice(step.to, 0, moving);
      return { ...state, messages: rest };
    }
    case "session": {
      const sessions = { ...state.sessions };
      if (step.value === null) delete sessions[step.id];
      else sessions[step.id] = structuredClone(step.value);
      return { ...state, sessions };
    }
    case "patch":
      return { ...state, [step.key]: structuredClone(step.value) };
    default:
      return null;
  }
}

async function run(scenarios, name, dir) {
  const scenario = JSON.parse(fs.readFileSync(scenarios, "utf8")).find((item) => item.name === name);
  if (!scenario) throw new Error(`no scenario ${name}`);
  const clean = placeholders(dir);
  let modules = load({ fresh: true });
  let state = null;
  const lines = [];
  const out = (step, result) => lines.push({ op: step.op, result: JSON.stringify(result ?? null) });
  const save = async (step, given) => {
    const options = { sweepMinAgeMs: 0, durable: Boolean(step.durable) };
    let saving = given;
    if (step.unloaded?.length) {
      const unloaded = new Set(step.unloaded);
      const messages = given.messages.filter((message) => !unloaded.has(Number(message.session_id)));
      saving = { ...given, messages: modules.messages.tag(messages, dir, unloaded) };
    }
    return modules.store.saveProjectState(dir, saving, options);
  };
  // After a save the daemon keeps the compacted messages it saved: carry them forward, so an unchanged message is the
  // same object next time (Node's writeMessages compares objects; Rust compares values).
  const settle = () => {
    const saved = modules.messages.savedRows(dir);
    if (saved && Array.isArray(state?.messages)) state = { ...state, messages: state.messages.map((message) => saved.get(message.id)?.message ?? message) };
  };
  for (const step of scenario.steps) {
    const next = apply(state, step);
    const file = path.join(dir, ".milagre", "coordination.json");
    if (next) {
      state = next;
      out(step, null);
    } else
      switch (step.op) {
        case "save":
          out(step, await save(step, state));
          settle();
          break;
        case "saveExpectFail":
          try {
            await save(step, state);
            out(step, { unexpected: "saved" });
          } catch (error) {
            out(step, { error: clean(error.message) });
          }
          break;
        case "saveCrashBeforeRename": {
          // The process dies after chats.db committed and before the rename: the old coordination.json stays, the new
          // one is left in its temporary file.
          const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
          out(step, await save(step, state));
          const written = fs.readFileSync(file);
          if (before) fs.writeFileSync(file, before);
          else fs.rmSync(file);
          fs.writeFileSync(path.join(dir, ".milagre", "coordination.json.99999.1.tmp"), written);
          break;
        }
        case "read":
          state = await modules.store.readProjectState(dir);
          out(step, null);
          break;
        case "restart":
          modules = load({ fresh: true });
          out(step, null);
          break;
        case "blockState":
          fs.renameSync(file, `${file}.blocked`);
          fs.mkdirSync(file);
          out(step, null);
          break;
        case "unblockState":
          fs.rmdirSync(file);
          fs.renameSync(`${file}.blocked`, file);
          out(step, null);
          break;
        case "sendStatus": {
          // ChatHost.sendStatus with nothing in flight: the saved message, else the queued entry.
          const copy = fs.mkdtempSync(path.join(os.tmpdir(), "owner-status-"));
          fs.cpSync(dir, copy, { recursive: true });
          try {
            const read = await load({ fresh: true }).store.readProjectState(copy);
            const message = read.messages.find((item) => item.clientMessageId === step.clientMessageId);
            const queued = Object.values(read.sessions).find((session) => session.queued?.some((entry) => entry.clientMessageId === step.clientMessageId));
            out(step, message ? { sessionId: message.session_id } : queued ? { sessionId: queued.id } : null);
          } finally {
            fs.rmSync(copy, { recursive: true, force: true });
          }
          break;
        }
        case "hotJournal":
          crashMidTransaction(dir);
          out(step, null);
          break;
        default:
          throw new Error(`unknown step ${step.op}`);
      }
    // What the step left on disk. Snapshots load their own module instances; this run keeps using its own.
    const line = lines.at(-1);
    line.snapshot = JSON.stringify(await snapshot(dir));
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }
}

/** Leaves chats.db torn: a transaction whose pages already reached the file, killed before COMMIT. */
function crashMidTransaction(dir) {
  const { spawnSync } = require("node:child_process");
  const result = spawnSync(process.execPath, [__filename, "crash-child", dir], { encoding: "utf8" });
  if (result.signal !== "SIGKILL") throw new Error(`crash child ended with ${result.status}: ${result.stderr}`);
  if (!fs.existsSync(path.join(dir, ".milagre", "chats.db-journal"))) throw new Error("no hot journal left");
}

function crashChild(dir) {
  const { DatabaseSync } = load().db.database();
  const db = new DatabaseSync(path.join(dir, ".milagre", "chats.db"));
  db.exec("PRAGMA cache_size = 1");
  db.exec("BEGIN");
  db.exec(`UPDATE messages SET payload = payload || '${"x".repeat(8000)}'`);
  db.exec(`DELETE FROM messages WHERE rowid % 2 = 0`);
  process.kill(process.pid, "SIGKILL");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "run") return run(...args);
  if (command === "snapshot") return process.stdout.write(JSON.stringify(await snapshot(args[0])));
  if (command === "crash-mid-transaction") return crashMidTransaction(args[0]);
  if (command === "crash-child") return crashChild(args[0]);
  const { acquireOwnership } = require(source("ownership.cjs"));
  if (command === "try-lock") {
    try {
      acquireOwnership(args[0]).release();
      return process.stdout.write(JSON.stringify({ ok: true }));
    } catch (error) {
      return process.stdout.write(JSON.stringify({ error: error.message }));
    }
  }
  if (command === "hold-lock") {
    const owner = acquireOwnership(args[0]);
    process.stdout.write("held\n");
    process.stdin.resume();
    process.stdin.on("end", () => {
      owner.release();
      process.stdout.write("released\n");
    });
    return;
  }
  throw new Error(`unknown command ${command}`);
}

module.exports = { snapshot, load, placeholders };

if (require.main === module)
  main().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
