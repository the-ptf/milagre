const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { scanSources } = require("./sources.cjs");
const { claudeTranscript, codexTranscript } = require("./transcripts.cjs");
const { addImportedChats } = require("./import.cjs");
const { createRuntime } = require("../runtime.cjs");

const CLAUDE_ID = "11111111-2222-3333-4444-555555555555";
const CODEX_ID = "019a0000-0000-7000-8000-000000000001";

const lines = (items) => items.map((item) => JSON.stringify(item)).join("\n") + "\n";

function claudeLines(cwd) {
  return lines([
    { type: "attachment", attachment: { type: "hook_success" } },
    { type: "user", cwd, timestamp: "2026-11-01T10:00:00Z", message: { role: "user", content: "Fix the login bug" } },
    { type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "thinking", thinking: "Look at auth first." }] } },
    { type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "Checking the auth module." }] } },
    { type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "npm test" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "1 failing" }] } },
    { type: "user", isSidechain: true, message: { role: "user", content: "subagent prompt" } },
    { type: "user", message: { role: "user", content: "<system-reminder>ignore</system-reminder>" } },
    { type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "Fixed: the token expired early." }] } },
    { type: "user", isMeta: true, message: { role: "user", content: "meta" } },
    { type: "user", message: { role: "user", content: [{ type: "text", text: "Thanks, ship it" }] } },
    { type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "Opened the PR." }] } },
  ]);
}

function codexItemLines(cwd) {
  const item = (value) => ({ type: "event_msg", timestamp: "2026-11-02T10:00:00Z", payload: { type: "item_completed", item: value } });
  return lines([
    { type: "session_meta", payload: { id: CODEX_ID, cwd } },
    { type: "turn_context", payload: { cwd, model: "gpt-6.1" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions" }] } },
    item({ type: "UserMessage", content: [{ type: "text", text: "Add dark mode" }] }),
    item({ type: "AgentMessage", content: [{ type: "Text", text: "Adding the theme toggle." }] }),
    item({ type: "CommandExecution", id: "exec-1", command: ["/bin/zsh", "-lc", "npm run lint"], status: "completed", exit_code: 0, aggregated_output: "ok" }),
    item({
      type: "FileChange",
      id: "exec-2",
      status: "completed",
      changes: { [path.join(cwd, "theme.ts")]: { type: "update", unified_diff: "@@ -1 +1 @@\n-a\n+b\n" } },
    }),
    item({ type: "AgentMessage", content: [{ type: "Text", text: "Done." }] }),
  ]);
}

function codexResponseLines() {
  return lines([
    { type: "turn_context", payload: { model: "gpt-5" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "List the files" }] } },
    { type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c1", arguments: JSON.stringify({ command: ["ls"] }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "a.txt" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "One file: a.txt" }] } },
  ]);
}

function t3Database(file, project, worktree) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT, workspace_root TEXT, scripts_json TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, archived_at TEXT);
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, default_provider TEXT, runtime_mode TEXT, interaction_mode TEXT, active_provider_thread_id TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, provider TEXT, status TEXT, updated_at TEXT, payload_json TEXT, driver TEXT);
  `);
  db.prepare("INSERT INTO projection_projects VALUES (?, ?, ?, '[]', ?, ?, NULL, NULL)").run(
    "p1",
    "app",
    project,
    "2026-11-01T00:00:00Z",
    "2026-11-01T00:00:00Z",
  );
  db.prepare("INSERT INTO projection_projects VALUES (?, ?, ?, '[]', ?, ?, ?, NULL)").run(
    "p2",
    "gone",
    "/nowhere",
    "2026-11-01T00:00:00Z",
    "2026-11-01T00:00:00Z",
    "2026-11-02T00:00:00Z",
  );
  const thread = (id, title, provider, nativeId, payload, archived = null, deleted = null) => {
    db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, 'p1', ?, ?, 'full-access', 'default', ?, ?, ?, ?, ?, ?)").run(
      id,
      title,
      provider,
      `pt-${id}`,
      "2026-11-01T10:00:00Z",
      "2026-11-03T10:00:00Z",
      archived,
      deleted,
      JSON.stringify(payload),
    );
    db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, 'idle', ?, ?, ?)").run(
      `pt-${id}`,
      id,
      provider,
      "2026-11-03T10:00:00Z",
      JSON.stringify({ driver: provider, nativeThreadRef: nativeId ? { nativeId } : null }),
      provider,
    );
  };
  thread("t-claude", "Fix login", "claudeAgent", CLAUDE_ID, { branch: "main", worktreePath: null, modelSelection: { model: "claude-opus-5-5" } });
  thread("t-codex", "Dark mode", "codex", CODEX_ID, { branch: "dark", worktreePath: worktree }, "2026-11-04T00:00:00Z");
  thread("t-cursor", "Cursor work", "cursor", "cursor-1", { worktreePath: null });
  thread("t-lost", "Lost work", "claudeAgent", "99999999-0000-4000-8000-000000000000", { worktreePath: null });
  thread("t-sub", "Subagent", "claudeAgent", "sub-1", { lineage: { relationshipToParent: "subagent" } });
  thread("t-deleted", "Deleted", "claudeAgent", "del-1", {}, null, "2026-11-05T00:00:00Z");
  db.close();
}

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "milagre-ade-import-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const project = path.join(dir, "app");
  const worktree = path.join(dir, "app-dark");
  fs.mkdirSync(project, { recursive: true });
  execFileSync("git", ["init", "-qb", "main", project]);
  execFileSync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "Initial"]);
  execFileSync("git", ["-C", project, "worktree", "add", "-qb", "dark", worktree]);
  t3Database(path.join(home, ".t3", "userdata", "statev2.sqlite"), project, worktree);
  const claudeDir = path.join(home, ".claude", "projects", "-app");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, `${CLAUDE_ID}.jsonl`), claudeLines(project));
  const codexDir = path.join(home, ".codex", "sessions", "2026", "11", "02");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, `rollout-2026-11-02T10-00-00-${CODEX_ID}.jsonl`), codexItemLines(worktree));

  const paseo = path.join(home, ".paseo");
  fs.mkdirSync(path.join(paseo, "projects"), { recursive: true });
  fs.writeFileSync(path.join(paseo, "projects", "projects.json"), JSON.stringify([{ projectId: "pp1", rootPath: project, displayName: "app", kind: "git" }]));
  fs.writeFileSync(
    path.join(paseo, "projects", "workspaces.json"),
    JSON.stringify([{ workspaceId: "w1", projectId: "pp1", cwd: worktree, kind: "worktree", branch: "dark" }]),
  );
  fs.mkdirSync(path.join(paseo, "agents", "-app-dark"), { recursive: true });
  fs.writeFileSync(
    path.join(paseo, "agents", "-app-dark", "a1.json"),
    JSON.stringify({
      id: "a1",
      provider: "codex",
      cwd: worktree,
      workspaceId: "w1",
      title: "Paseo agent",
      persistence: { sessionId: CODEX_ID },
      updatedAt: "2026-11-02T00:00:00Z",
    }),
  );
  fs.writeFileSync(path.join(paseo, "agents", "-app-dark", "a2.json"), JSON.stringify({ id: "a2", provider: "claude", cwd: worktree, internal: true }));

  const orca = path.join(home, "Library", "Application Support", "Orca");
  fs.mkdirSync(orca, { recursive: true });
  fs.writeFileSync(
    path.join(orca, "orca-data.json"),
    JSON.stringify({ repos: [{ id: "r1", path: project, displayName: "App", kind: "git" }], worktreeMeta: { [`r1::${worktree}`]: { displayName: "dark" } } }),
  );
  return { dir, home, project, worktree };
}

test("scans T3 Code, Paseo and Orca data in a home folder", (t) => {
  const { home, project, worktree } = fixture(t);
  const sources = Object.fromEntries(scanSources({ env: {}, home, platform: "darwin" }).map((source) => [source.id, source]));

  assert.equal(sources.t3code.found, true);
  assert.deepEqual(
    sources.t3code.projects.map((item) => item.path),
    [project],
  );
  const threads = Object.fromEntries(sources.t3code.projects[0].threads.map((thread) => [thread.id, thread]));
  assert.deepEqual(Object.keys(threads).sort(), ["t3code:t-claude", "t3code:t-codex", "t3code:t-cursor", "t3code:t-lost"]);
  assert.equal(threads["t3code:t-claude"].provider, "claude");
  assert.equal(threads["t3code:t-claude"].nativeId, CLAUDE_ID);
  assert.equal(threads["t3code:t-codex"].cwd, worktree);
  assert.equal(threads["t3code:t-codex"].archived, true);
  assert.equal(threads["t3code:t-cursor"].provider, null);

  assert.equal(sources.paseo.found, true);
  assert.deepEqual(
    sources.paseo.projects[0].threads.map((thread) => [thread.title, thread.provider, thread.nativeId, thread.cwd]),
    [["Paseo agent", "codex", CODEX_ID, worktree]],
  );

  assert.equal(sources.orca.found, true);
  assert.deepEqual(sources.orca.projects, [{ name: "App", path: project, worktrees: 1, threads: [] }]);
});

test("reports a source that isn't installed as not found", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-ade-empty-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(
    scanSources({ env: {}, home: dir, platform: "linux" }).map((source) => [source.id, source.found]),
    [
      ["t3code", false],
      ["paseo", false],
      ["orca", false],
    ],
  );
});

test("turns a Claude transcript into user messages and replies with steps", async (t) => {
  const { home } = fixture(t);
  const messages = await claudeTranscript(path.join(home, ".claude", "projects", "-app", `${CLAUDE_ID}.jsonl`));
  assert.deepEqual(
    messages.map((message) => [message.role, message.body]),
    [
      ["user", "Fix the login bug"],
      ["assistant", "Checking the auth module.\n\nFixed: the token expired early."],
      ["user", "Thanks, ship it"],
      ["assistant", "Opened the PR."],
    ],
  );
  const steps = messages[1].steps;
  assert.deepEqual(
    steps.map((step) => [step.kind ?? "thinking", step.title, step.status]),
    [
      ["thinking", "Thought", "done"],
      ["shell", "Ran `npm test`", "done"],
    ],
  );
  assert.match(steps[1].detail, /1 failing/);
  assert.equal(steps[1].offset, "Checking the auth module.".length);
  assert.equal(messages[1].model, "claude-opus-5-5");
});

test("turns both Codex rollout formats into messages", async (t) => {
  const { home } = fixture(t);
  const file = fs.readdirSync(path.join(home, ".codex", "sessions", "2026", "11", "02"))[0];
  const items = await codexTranscript(path.join(home, ".codex", "sessions", "2026", "11", "02", file));
  assert.deepEqual(
    items.map((message) => [message.role, message.body]),
    [
      ["user", "Add dark mode"],
      ["assistant", "Adding the theme toggle.\n\nDone."],
    ],
  );
  assert.deepEqual(
    items[1].steps.map((step) => [step.kind, step.title]),
    [
      ["shell", "Ran `npm run lint`"],
      ["edit", "Edited `theme.ts`"],
    ],
  );
  assert.equal(items[1].model, "gpt-6.1");

  const older = path.join(home, "old.jsonl");
  fs.writeFileSync(older, codexResponseLines());
  const responses = await codexTranscript(older);
  assert.deepEqual(
    responses.map((message) => [message.role, message.body]),
    [
      ["user", "List the files"],
      ["assistant", "One file: a.txt"],
    ],
  );
  assert.match(responses[1].steps[0].detail, /a\.txt/);
});

test("adds imported Chats once and keeps their dates", () => {
  const state = { next_id: 3, worktrees: { 1: { id: 1, name: "app", path: "/app" } }, sessions: {}, messages: [] };
  const chat = {
    id: "t3code:t1",
    source: "t3code",
    worktreeId: 1,
    title: "Fix login",
    provider: "claude",
    nativeId: CLAUDE_ID,
    createdAt: 1000,
    updatedAt: 2000,
    messages: [
      { role: "user", body: "Fix it", context: null },
      { role: "assistant", body: "Fixed.", context: null, outcome: "completed" },
    ],
  };
  const first = addImportedChats(state, [chat, { ...chat, id: "t3code:t2", worktreeId: 9, nativeId: "other" }]);
  assert.deepEqual(first.added, [{ id: "t3code:t1", sessionId: 3 }]);
  assert.deepEqual(first.skipped, [{ id: "t3code:t2", reason: "no-worktree" }]);
  const session = first.state.sessions[3];
  assert.equal(session.native_session_id, CLAUDE_ID);
  assert.equal(session.provider, "claude");
  assert.deepEqual(session.importedFrom, { source: "t3code", id: "t3code:t1" });
  assert.equal(session.summary.lastAt, 2000);
  assert.equal(session.summary.firstAt, 1000);
  assert.deepEqual(
    first.state.messages.map((message) => [message.id, message.session_id]),
    [
      [4, 3],
      [5, 3],
    ],
  );
  assert.equal(first.state.next_id, 6);

  const lost = addImportedChats(first.state, [{ ...chat, id: "t3code:t3", nativeId: "gone", missing: true }]);
  assert.equal(lost.state, first.state);
  assert.deepEqual(lost.skipped, [{ id: "t3code:t3", reason: "no-transcript" }]);

  const again = addImportedChats(first.state, [chat, { ...chat, id: "paseo:a1", missing: true }]);
  assert.equal(again.state, first.state);
  assert.deepEqual(
    again.skipped.map((item) => item.reason),
    ["already-imported", "already-imported"],
  );
});

test("imports a T3 Code Project and its threads into Milagre", async (t) => {
  const { dir, home, project, worktree } = fixture(t);
  const runtime = createRuntime({
    cwd: project,
    titleModels: {},
    expandSkills: false,
    dataDir: path.join(dir, "profile"),
    chatsHome: path.join(dir, "chats"),
    worktreeRoot: path.join(dir, "worktrees"),
    registryRoots: [],
    environmentReady: Promise.resolve(),
    emit: () => {},
    adeImport: { home, env: {}, platform: "darwin" },
  });
  t.after(() => runtime.close());

  const scanned = await runtime.invoke("import:scan", []);
  const t3 = scanned.sources.find((source) => source.id === "t3code");
  assert.equal(t3.projects[0].exists, true);
  assert.equal(t3.projects[0].registered, false);
  const scannedThread = (id) => t3.projects[0].threads.find((thread) => thread.id === id);
  assert.equal(scannedThread("t3code:t-cursor").unsupported, "unsupported");
  assert.equal(scannedThread("t3code:t-lost").unsupported, "no-transcript");
  assert.equal(scannedThread("t3code:t-claude").unsupported, undefined);
  assert.equal(scannedThread("t3code:t-codex").unsupported, undefined);

  const result = await runtime.invoke("import:run", [{ projects: [`t3code:${project}`], threads: ["t3code:t-claude", "t3code:t-codex", "t3code:t-cursor"] }]);
  assert.equal(result.chats, 2);
  assert.deepEqual(
    result.skipped.map((item) => [item.title, item.reason]),
    [["Cursor work", "unsupported"]],
  );

  const { state } = await runtime.openProject(project);
  const imported = Object.values(state.sessions).filter((session) => session.importedFrom);
  const byTitle = Object.fromEntries(imported.map((session) => [session.title, session]));
  assert.equal(byTitle["Fix login"].native_session_id, CLAUDE_ID);
  assert.equal(state.worktrees[byTitle["Fix login"].worktree_id].path, project);
  assert.equal(byTitle["Dark mode"].provider, "codex");
  assert.equal(byTitle["Dark mode"].archived, true);
  assert.equal(fs.realpathSync(state.worktrees[byTitle["Dark mode"].worktree_id].path), fs.realpathSync(worktree));
  const messages = await runtime.invoke("chat:messages", [project, byTitle["Fix login"].id]);
  assert.deepEqual(
    (messages.messages ?? messages).map((message) => message.body),
    ["Fix the login bug", "Checking the auth module.\n\nFixed: the token expired early.", "Thanks, ship it", "Opened the PR."],
  );

  const rescanned = await runtime.invoke("import:scan", []);
  const again = rescanned.sources.find((source) => source.id === "t3code").projects[0];
  assert.equal(again.registered, true);
  assert.equal(again.threads.find((thread) => thread.id === "t3code:t-claude").imported, true);
  const second = await runtime.invoke("import:run", [{ threads: ["t3code:t-claude"] }]);
  assert.equal(second.chats, 0);
  assert.deepEqual(
    second.skipped.map((item) => item.reason),
    ["already-imported"],
  );
});
