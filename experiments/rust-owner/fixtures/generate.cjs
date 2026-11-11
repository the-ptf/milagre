#!/usr/bin/env node
// Builds the conformance fixtures for the Rust read-only store with the current Node implementation.
//
//   node experiments/rust-owner/fixtures/generate.cjs            # (re)writes fixtures/projects + fixtures/expected
//   node experiments/rust-owner/fixtures/generate.cjs --check    # regenerates into a temp dir, compares expected/*
//
// Every Project is written by the real writers (project-store.cjs saveProjectState -> chat-db.cjs writeMessages,
// project-content.cjs sidecars) in a temporary folder, then a few rows are changed by hand with node:sqlite to reach
// states the writer only leaves behind across releases (position gaps, orphan Chats, non-string bodies). Expected
// results are produced by the Node readers on a *copy* of each Project, because some Node reads write (chat-db opens
// with CREATE TABLE IF NOT EXISTS, contentDirectory() mkdirs, readProjectState compacts details). The committed
// Project folders are never read by Node after they are copied out.
//
// Each expected value is stored as the exact string JSON.stringify produced, so the Rust tests compare bytes.

const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repo = path.resolve(__dirname, "../../..");
const shared = path.join(repo, "packages/shared/src");
// This Worktree may have no node_modules: resolve the workspace package to its sources, as its exports map does.
// oxlint-disable-next-line no-underscore-dangle -- the one hook that maps a workspace package without node_modules
const resolve = Module._resolveFilename;
// oxlint-disable-next-line no-underscore-dangle
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@milagre/shared/")) return path.join(shared, `${request.slice("@milagre/shared/".length)}.mjs`);
  return resolve.call(this, request, ...rest);
};

const core = (name) => require(path.join(repo, "packages/core/src", name));
const chatDb = core("chat-db.cjs");
const { saveProjectState, readProjectState } = core("project-store.cjs");
const { ProjectStates } = core("project-states.cjs");
const { chatPage } = core("chat-pages.cjs");
const { withDetails, hydrateSubagents, compactDetails } = core("project-content.cjs");
const messageStore = core("message-store.cjs");

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const OLD = NOW - 24 * 60 * 60 * 1000;
const RECENT = NOW - 60 * 1000;

// ---------------------------------------------------------------------------------------------------------------
// Project contents

const long = (label, size) => `${label}:` + "x".repeat(size);
const emojiBoundary = `${"a".repeat(239)}\u{1F600} tail`; // the 240th code point is a surrogate pair

function alphaMessages() {
  const m = [];
  let id = 1;
  const push = (message) => m.push({ id: id++, ...message });
  // Chat 1: three turns, a long shell step (moved to a details sidecar), a PR command kept inline, a thinking step.
  push({ session_id: 1, role: "user", body: "Fix the needle in the parser", clientMessageId: "cm-1", createdAt: "2026-11-01T10:00:00.000Z" });
  push({
    session_id: 1,
    role: "assistant",
    body: "Looking at it.",
    outcome: "completed",
    operationId: "op-1",
    steps: [
      { id: "s1", kind: "shell", title: "grep", detail: long("grep output", 3000), status: "done" },
      { id: "s2", kind: "shell", title: "pr", detail: "gh pr create --fill\n" + "y".repeat(2000), status: "done" },
      { id: "s3", kind: "thinking", title: "think", detail: long("final thought", 1500), status: "done" },
      { id: 4, kind: "shell", title: "numeric id", detail: long("numeric", 1100), status: "done" },
    ],
  });
  push({ session_id: 1, role: "user", body: "Café, naïve, 日本語, emoji \u{1F680}", clientMessageId: "cm-2" });
  push({ session_id: 1, role: "assistant", body: emojiBoundary, outcome: "completed", score: 0.1, ratio: 1e21, tiny: 1e-7, neg: -2.5 });
  push({ session_id: 1, role: "user", body: 'control chars \u0001\u001f and "quotes" and \\ backslash\n\ttab', clientMessageId: "cm-3" });
  push({ session_id: 1, role: "assistant", body: "", outcome: "failed", error: { message: "boom", code: 42 } });
  // Chat 2: queued send, operation ids.
  push({ session_id: 2, role: "user", body: "Second chat first message", clientMessageId: "cm-4", model: "opus" });
  push({ session_id: 2, role: "assistant", body: emojiBoundary + " Reply with needle inside", outcome: "completed", operationId: "op-2" });
  // Chat 10 (sorts after "2" as an integer key, before it as text).
  for (let turn = 0; turn < 14; turn++) {
    push({ session_id: 10, role: "user", body: `turn ${turn} question`, clientMessageId: `cm-10-${turn}` });
    push({ session_id: 10, role: "assistant", body: `turn ${turn} answer`, outcome: "completed" });
    if (turn % 3 === 0) push({ session_id: 10, role: "assistant", body: `turn ${turn} follow-up`, context: { kind: "reload" } });
  }
  // Chat 3: archived.
  push({ session_id: 3, role: "user", body: "Archived chat", clientMessageId: "cm-5" });
  push({ session_id: 3, role: "assistant", body: "Archived reply", outcome: "completed" });
  // Chat 7: interleaved with chat 1 later in the Project's order.
  push({ session_id: 7, role: "user", body: "Seven", clientMessageId: "cm-7" });
  push({ session_id: 1, role: "user", body: "Back in chat one", clientMessageId: "cm-8" });
  push({ session_id: 7, role: "assistant", body: "Seven reply", outcome: "completed", nested: { a: [1, { b: null }], 2: "two", 1: "one" } });
  return m;
}

function alphaState() {
  const messages = alphaMessages();
  return {
    next_id: messages.length + 1,
    worktrees: { 1: { id: 1, path: "/tmp/alpha" } },
    sessions: {
      1: {
        id: 1,
        title: "Parser",
        worktree_id: 1,
        summary: { lastAt: OLD },
        suggestion: "drop me",
        suggestionTurnId: "t-1",
        subagents: [
          {
            id: "agent-a",
            title: "helper",
            transcript: [
              { id: "e1", kind: "message", text: "hello" },
              { id: "e2", kind: "tool", text: long("tool output", 2500) },
            ],
          },
          { id: "agent-b", title: "empty helper", transcript: [] },
        ],
      },
      2: {
        id: 2,
        title: "Queue",
        summary: { lastAt: RECENT },
        queued: [{ clientMessageId: "queued-1", body: "later" }],
        unread: true,
      },
      3: { id: 3, title: "Old", archived: true, summary: { lastAt: OLD } },
      7: { id: 7, title: "Seven", summary: { lastAt: OLD }, unread: true },
      10: { id: 10, title: "Ten", summary: { lastAt: OLD }, queued: [{ clientMessageId: "queued-10", body: "q" }] },
    },
    messages,
    extra: { 10: "ten", 9: "nine", alpha: true, "01": "leading zero stays text" },
  };
}

function legacyState({ longDetail = false } = {}) {
  return {
    next_id: 5,
    sessions: { 1: { id: 1, title: "Legacy", queued: [{ clientMessageId: "legacy-queued" }] } },
    messages: [
      { id: 1, session_id: 1, role: "user", body: "legacy question", clientMessageId: "legacy-cm-1" },
      {
        id: 2,
        session_id: 1,
        role: "assistant",
        body: "legacy answer",
        outcome: "completed",
        steps: [
          { id: "l1", kind: "shell", detail: longDetail ? long("legacy", 2048) : "short", status: "done" },
          { id: "l2", kind: "shell", detail: long("running", 2048), status: "running" },
        ],
      },
      { id: 3, session_id: 1, role: "user", body: "second legacy", clientMessageId: "legacy-cm-2" },
      { id: 4, session_id: 1, role: "assistant", body: "second legacy answer", outcome: "completed" },
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Writing the Projects

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

async function buildProjects(root) {
  // alpha: real saves, then hand edits that older releases or crashes leave behind.
  const alpha = path.join(root, "alpha");
  fs.mkdirSync(alpha, { recursive: true });
  messageStore.resetStore(alpha);
  const first = alphaState();
  // A save of a state missing one message and then one with it moved: exercises writeMessages' renumbering.
  await saveProjectState(alpha, { ...first, messages: first.messages.filter((message) => message.id !== 3) }, { sweepMinAgeMs: 0 });
  await saveProjectState(alpha, first, { sweepMinAgeMs: 0 });
  const { DatabaseSync } = chatDb.database();
  let db = new DatabaseSync(chatDb.dbFile(alpha));
  // Gaps in positions (a release after ADR-0009 may leave them between saves), an orphan Chat whose session is gone,
  // a body that is not a string, a row without a role, and a NULL session.
  db.exec("UPDATE messages SET position = position * 10 + 5");
  const top = db.prepare("SELECT MAX(position) AS top FROM messages").get().top;
  const insert = db.prepare("INSERT INTO messages (id, session_id, position, client_message_id, operation_id, payload) VALUES (?, ?, ?, ?, ?, ?)");
  const manual = [
    { id: 900, session_id: 99, role: "user", body: "orphan needle", clientMessageId: "cm-orphan" },
    { id: 901, session_id: 99, role: "assistant", body: "orphan reply", outcome: "completed" },
    { id: 902, session_id: 7, role: "assistant", body: { structured: true, n: 1 }, outcome: "completed" },
    { id: 903, session_id: 7, body: "no role", operationId: "op-903" },
    { id: 904, role: "user", body: "no session" },
  ];
  manual.forEach((message, index) =>
    insert.run(
      message.id,
      message.session_id ?? null,
      top + 10 * (index + 1),
      message.clientMessageId ?? null,
      message.operationId ?? null,
      JSON.stringify(message),
    ),
  );
  db.close();

  // legacy: coordination.json from before chats.db (messages inline), nothing to compact.
  writeJson(path.join(root, "legacy/.milagre/coordination.json"), legacyState());
  // legacy-compact: the same with a long finished step detail that readProjectState would move to a sidecar.
  writeJson(path.join(root, "legacy-compact/.milagre/coordination.json"), legacyState({ longDetail: true }));
  // missing-db: points at chats.db, which is gone.
  writeJson(path.join(root, "missing-db/.milagre/coordination.json"), { next_id: 1, sessions: {}, messages: chatDb.MESSAGES_MARKER });
  // missing-sidecar: a subagent whose transcript sidecar is gone, and one whose sidecar hash is wrong.
  const missing = path.join(root, "missing-sidecar");
  fs.mkdirSync(missing, { recursive: true });
  messageStore.resetStore(missing);
  await saveProjectState(
    missing,
    {
      next_id: 3,
      sessions: {
        5: {
          id: 5,
          title: "Sidecars",
          subagents: [{ id: "lost", transcript: [{ id: "x", kind: "message", text: "kept compact" }] }],
        },
      },
      messages: [
        { id: 1, session_id: 5, role: "user", body: "hi", clientMessageId: "ms-1" },
        {
          id: 2,
          session_id: 5,
          role: "assistant",
          body: "hello",
          outcome: "completed",
          detailFile: `${"0".repeat(64)}.json`,
          steps: [{ id: "a", hasDetail: true }],
        },
      ],
    },
    { sweepMinAgeMs: 0 },
  );
  const coordination = path.join(missing, ".milagre/coordination.json");
  const saved = JSON.parse(fs.readFileSync(coordination, "utf8"));
  const lost = saved.sessions[5].subagents[0];
  fs.rmSync(path.join(missing, ".milagre/subagents", lost.transcriptFile));
  lost.transcriptFiles = [`${"f".repeat(64)}.json`, "not-a-sidecar.json"];
  fs.writeFileSync(path.join(missing, ".milagre/subagents", `${"f".repeat(64)}.json`), JSON.stringify([{ id: "y", kind: "message", text: "bad hash" }]));
  fs.writeFileSync(coordination, JSON.stringify(saved));
  // empty: a folder with no state at all.
  fs.mkdirSync(path.join(root, "empty/.milagre"), { recursive: true });
  // Content-addressed sidecars: Node's sweep keeps only referenced ones; leftovers beyond that are not part of the format.
  for (const leftover of fs.globSync("**/.milagre/**/*.tmp", { cwd: root })) fs.rmSync(path.join(root, leftover));
}

// ---------------------------------------------------------------------------------------------------------------
// Expected results, read by Node from a throwaway copy of each Project

const PROJECTS = ["alpha", "legacy", "legacy-compact", "missing-db", "missing-sidecar", "empty"];
const sorted = (set) => [...set].sort();
const errorOf = (error) => ({ error: error.message });

async function attempt(work) {
  try {
    return await work();
  } catch (error) {
    return errorOf(error);
  }
}

function copyProject(from) {
  const to = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-owner-read-"));
  fs.cpSync(from, to, { recursive: true });
  return to;
}

/** Replaces the throwaway copy's path with the placeholder the Rust tests substitute back. */
const placeholder = (text, dir) => text.split(dir).join("<project>");

async function expectedFor(source) {
  const dir = copyProject(source);
  const cases = {};
  const record = (name, value) => (cases[name] = placeholder(JSON.stringify(value === undefined ? null : value), dir));
  messageStore.resetStore(dir);

  const raw = await attempt(async () => {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, ".milagre/coordination.json"), "utf8"));
    return parsed;
  });
  // readProjectState itself (compacts details, so on yet another copy).
  const stateCopy = copyProject(source);
  messageStore.resetStore(stateCopy);
  const state = await attempt(() => readProjectState(stateCopy));
  cases.readProjectState = placeholder(JSON.stringify(state), stateCopy);
  // The same read without its compaction step: what a read-only reader can return. Mirrors readProjectState's body.
  const uncompactedCopy = copyProject(source);
  const uncompacted = await attempt(async () => {
    const parsedRaw = JSON.parse(fs.readFileSync(path.join(uncompactedCopy, ".milagre/coordination.json"), "utf8"));
    const sessions = parsedRaw.sessions ?? {};
    if (Object.values(sessions).some((session) => session.suggestion !== undefined || session.suggestionTurnId !== undefined))
      parsedRaw.sessions = Object.fromEntries(
        Object.entries(sessions).map(([id, session]) => {
          const { suggestion: _s, suggestionTurnId: _t, ...rest } = session;
          return [id, rest];
        }),
      );
    if (chatDb.isMarker(parsedRaw.messages)) {
      const rows = await chatDb.readRows(uncompactedCopy);
      if (!rows) throw new Error(`This Project's messages are kept in ${path.join(uncompactedCopy, ".milagre", "chats.db")}, which is missing.`);
      parsedRaw.messages = rows.map((row) => row.message);
    }
    const hydrated = await hydrateSubagents(uncompactedCopy, parsedRaw);
    const compacted = await compactDetails(uncompactedCopy, hydrated);
    const pending =
      compacted === hydrated ? [] : compacted.messages.filter((message, index) => message !== hydrated.messages[index]).map((message) => message.id);
    return { state: hydrated, pendingDetailCompaction: pending };
  });
  cases.readProjectStateUncompacted = placeholder(JSON.stringify(uncompacted), uncompactedCopy);
  fs.rmSync(stateCopy, { recursive: true, force: true });
  fs.rmSync(uncompactedCopy, { recursive: true, force: true });

  const hasDb = fs.existsSync(chatDb.dbFile(dir));
  const sessions = raw?.sessions ? Object.values(raw.sessions).map((session) => session.id) : [];
  const allChats = hasDb ? [...new Set((await chatDb.readRows(dir)).map((row) => row.chat).filter((chat) => chat !== null))] : [];
  const chatSets = { sessions, all: [...new Set([...sessions, ...allChats])], none: [], one: sessions.slice(0, 1), missing: [12345] };

  if (hasDb) {
    record("readRows", await chatDb.readRows(dir));
    record("readMessages", await chatDb.readMessages(dir));
    for (const [label, chats] of Object.entries(chatSets)) {
      record(`readChatRows.${label}`, chatDb.readChatRows(dir, chats));
      record(`readChatBodies.${label}`, chatDb.readChatBodies(dir, chats));
      record(`readChatPreviews.${label}`, chatDb.readChatPreviews(dir, chats));
      record(`readChatMarks.${label}`, chatDb.readChatMarks(dir, chats));
      record(`readDetailRefs.${label}`, sorted(chatDb.readDetailRefs(dir, chats)));
      for (const [needleLabel, needles] of Object.entries({ needle: ["needle"], multi: ["orphan", "Café", "\\u0001"], none: [] }))
        record(`readChatRowsContaining.${label}.${needleLabel}`, chatDb.readChatRowsContaining(dir, chats, needles));
    }
    record("readPositions", [...chatDb.readPositions(dir, [1, 2, 3, 900, 904, 5555])]);
    const lookups = [
      ["id", 2],
      ["id", 902],
      ["id", 777777],
      ["operationId", "op-2"],
      ["operationId", "op-903"],
      ["clientMessageId", "cm-8"],
      ["clientMessageId", "cm-orphan"],
      ["clientMessageId", "nope"],
    ];
    for (const [field, value] of lookups)
      for (const [label, chats] of Object.entries(chatSets)) record(`findRow.${field}.${value}.${label}`, chatDb.findRow(dir, chats, field, value));
  }

  // Daemon command results. A ProjectStates like the runtime's (ADR-0007 lazy messages), reading the copy, its clock
  // fixed so the Chats whose lastAt is old are unloaded on read (shedOld) and come from chats.db.
  if (raw && !raw.error) {
    const states = new ProjectStates({
      read: readProjectState,
      save: async () => {
        throw new Error("fixture generation never saves");
      },
      messages: { directory: (key) => key, now: () => NOW },
    });
    const load = await attempt(() => states.get(dir));
    if (!load.error) {
      record(
        "unloadedAfterRead",
        [...messageStore.unloadedChats(await states.get(dir))].map(Number).sort((a, b) => a - b),
      );
      // chat:message: findMessage, then the details sidecar read back into its steps.
      for (const id of [1, 2, 6, 902, 904, 777777]) {
        const message = await states.findMessage(dir, "id", id);
        record(`chatMessage.${id}`, message ? await withDetails(dir, message) : { error: "That message is no longer in this Project." });
      }
      // chat:send-status without a send in flight (ChatHost.sendStatus after pendingSends drains).
      for (const clientMessageId of ["cm-1", "cm-8", "cm-10-13", "cm-orphan", "queued-1", "queued-10", "legacy-cm-2", "legacy-queued", "ms-1", "missing"]) {
        const message = await states.findMessage(dir, "clientMessageId", clientMessageId);
        let receipt = null;
        if (message) receipt = { sessionId: message.session_id };
        else {
          const current = await states.get(dir);
          const queued = Object.values(current.sessions).find((session) => session.queued?.some((entry) => entry.clientMessageId === clientMessageId));
          receipt = queued ? { sessionId: queued.id } : null;
        }
        record(`sendStatus.${clientMessageId}`, receipt);
      }
      const chatIds = [...new Set([...sessions, ...allChats])];
      const pageOptions = { default: undefined, short: { turns: 1, limit: 3 }, limitOnly: { limit: 4 }, zeroTurns: { turns: 0 } };
      for (const chat of chatIds) {
        // chat:messages for a Project this host knows but hasn't opened: rows straight from chats.db.
        const rows = hasDb ? chatDb.readChatRows(dir, [chat]).map((row) => row.message) : null;
        const opened = (await states.load(dir, [chat])).messages;
        const chatMessages = opened.filter((message) => message.session_id === chat);
        const befores = [undefined, chatMessages.at(-1)?.id, chatMessages[Math.floor(chatMessages.length / 2)]?.id, 424242];
        for (const [label, options] of Object.entries(pageOptions))
          for (const before of befores) {
            const withBefore = before === undefined ? options : { ...options, before };
            const key = `chatPage.${chat}.${label}.${before ?? "end"}`;
            record(`${key}.opened`, chatPage(opened, chat, withBefore ?? {}));
            if (rows) record(`${key}.unopened`, chatPage(rows, chat, withBefore ?? {}));
          }
      }
    } else record("projectStatesLoad", load);
    await states.close().catch(() => {});
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return cases;
}

async function generate(outDir) {
  const projects = path.join(outDir, "projects");
  const expected = path.join(outDir, "expected");
  fs.rmSync(projects, { recursive: true, force: true });
  fs.rmSync(expected, { recursive: true, force: true });
  await buildProjects(projects);
  fs.mkdirSync(expected, { recursive: true });
  for (const project of PROJECTS) {
    const cases = await expectedFor(path.join(projects, project));
    fs.writeFileSync(path.join(expected, `${project}.json`), JSON.stringify(cases, null, 1) + "\n");
  }
  fs.writeFileSync(
    path.join(expected, "meta.json"),
    JSON.stringify(
      { node: process.version, sqlite: chatDb.database().constants ? "node:sqlite" : "unknown", generatedBy: "experiments/rust-owner/fixtures/generate.cjs" },
      null,
      1,
    ) + "\n",
  );
}

async function main() {
  const check = process.argv.includes("--check");
  if (!check) return generate(__dirname);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-owner-fixtures-"));
  try {
    await generate(temp);
    let drift = 0;
    for (const project of PROJECTS) {
      const fresh = JSON.parse(fs.readFileSync(path.join(temp, "expected", `${project}.json`), "utf8"));
      const committed = JSON.parse(fs.readFileSync(path.join(__dirname, "expected", `${project}.json`), "utf8"));
      for (const key of new Set([...Object.keys(fresh), ...Object.keys(committed)]))
        if (fresh[key] !== committed[key]) {
          drift++;
          console.error(`drift: ${project} ${key}`);
        }
    }
    if (drift) {
      console.error(`${drift} expected results differ from the committed fixtures: the Node format changed. Rerun without --check and the Rust tests.`);
      process.exitCode = 1;
    } else console.log("Node results match the committed fixtures.");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
