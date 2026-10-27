const test = require("node:test");
const { readProjectState: readSavedState } = require("@milagre/core/project-store");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { once } = require("node:events");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { startDaemon } = require("./server.cjs");
const { connect } = require("./client.cjs");
const { MAX_FRAME_BYTES } = require("./protocol.cjs");
const { applyStatePatch } = require("@milagre/shared/state-patch");
const { mergeTranscript } = require("@milagre/shared/subagent-transcript");

const gitConfig = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

// One chat whose saved replies take more than 16 MB: many replies with long tool output, as a heavy user's would.
function largeChat({ worktreeId, sessionId, firstId, replies = 900 }) {
  const messages = [];
  for (let index = 0; index < replies; index++) {
    messages.push({
      id: firstId + index,
      session_id: sessionId,
      // Long replies make the size: long tool output moves to sidecars, out of the state.
      body: `Reply ${index} `.padEnd(20_000, "reply line\n"),
      context: null,
      role: "assistant",
      steps: [{ id: `step-${index}`, kind: "shell", title: "Ran `npm test`", status: "done", detail: `$ npm test\n${index} passed` }],
    });
  }
  return {
    session: {
      id: sessionId,
      worktree_id: worktreeId,
      agent_name: "main",
      status: "Created",
      provider: "claude",
      native_session_id: `large-${sessionId}`,
      title: "Long chat",
    },
    messages,
  };
}
async function writeState(folder, state) {
  await fs.mkdir(path.join(folder, ".milagre"), { recursive: true });
  await fs.writeFile(path.join(folder, ".milagre/coordination.json"), JSON.stringify(state));
}
// The raw reply to one request on a plain socket, skipping events. One reader per socket parses every frame from the
// start, so a frame split across chunks is never read from its middle.
const rawReaders = new WeakMap();
function rawRequest(socket, request) {
  let reader = rawReaders.get(socket);
  if (!reader) {
    reader = { text: "", waiters: new Map(), early: new Map() };
    rawReaders.set(socket, reader);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      const lines = (reader.text + chunk).split("\n");
      reader.text = lines.pop();
      for (const line of lines) {
        const message = JSON.parse(line);
        if (message.id == null) continue;
        const waiter = reader.waiters.get(message.id);
        if (waiter) {
          reader.waiters.delete(message.id);
          waiter(message);
        } else reader.early.set(message.id, message);
      }
    });
  }
  return new Promise((resolve) => {
    reader.waiters.set(request.id, resolve);
    socket.write(JSON.stringify(request) + "\n");
  });
}

async function waitFor(read) {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (value) return value;
    await delay(10);
  }
  throw new Error("Timed out waiting for daemon state");
}
async function fixture(t, { createSession, lazyMessages, ...options } = {}) {
  const fixtureOptions = { createSession };
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-daemon-")));
  const dataDir = path.join(directory, "profile");
  const project = path.join(directory, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  const sessions = [];
  const daemon = await startDaemon({
    dataDir,
    version: "9.8.7",
    maxFrameBytes: 8192,
    runtimeOptions: {
      cwd: project,
      environmentReady: Promise.resolve(),
      titleModels: {},
      ...(lazyMessages === undefined ? {} : { lazyMessages }),
      agentCli: Object.assign(async () => ({ command: "/fake/codex" }), { invalidate() {} }),
      createSession(provider, options) {
        if (fixtureOptions.createSession) return fixtureOptions.createSession(provider, options);
        const session = {
          closed: false,
          turnActive: false,
          async startTurn() {
            this.turnActive = true;
            options.emit({ type: "session-ready", sessionId: "native-id" });
            options.emit({ type: "turn-started", turnId: "turn-1" });
            options.emit({
              type: "permission-request",
              requestId: "permission-1",
              kind: "command",
              tool: "Shell",
              title: "Run?",
              command: "ls",
              allowForChat: true,
            });
            return { turnId: "turn-1" };
          },
          respondToPermission(requestId, decision) {
            this.decision = { requestId, decision };
            options.emit({ type: "permission-resolved", requestId });
            return true;
          },
          async close() {
            this.closed = true;
            if (this.turnActive) options.emit({ type: "turn-cancelled" });
            this.turnActive = false;
          },
        };
        sessions.push(session);
        return session;
      },
    },
    ...options,
  });
  const clients = [];
  const client = async () => {
    const c = await connect({ dataDir });
    clients.push(c);
    return c;
  };
  t.after(async () => {
    for (const c of clients) c.close();
    try {
      await daemon.close();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  return { daemon, dataDir, project, sessions, client };
}

test("independent clients reconnect to a running Chat and its pending approval", async (t) => {
  const { daemon, project, sessions, client } = await fixture(t);
  const first = await client();
  const observer = await client();
  const events = [];
  observer.on("event", (event) => events.push(event));
  const opened = await first.call("project:open", [project]);
  const session = Object.values(opened.state.sessions)[0];
  const chatId = `${project}#${session.id}`;
  await first.call("chat:send", [{ projectPath: project, sessionId: session.id, body: "Hello", provider: "codex", model: "test", permissionMode: "ask" }]);
  await waitFor(() => events.find((event) => event.channel === "agent:event" && event.payload.event.type === "permission-request"));
  first.close();
  const second = await client();
  const snapshot = await second.call("chat:runs");
  assert.ok(JSON.stringify(snapshot.runs[chatId]).includes("permission-1"));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].closed, false);
  assert.equal(await second.call("agent:respond-permission", [{ chatId, requestId: "permission-1", decision: "allow" }]), true);
  assert.deepEqual(sessions[0].decision, { requestId: "permission-1", decision: "allow" });
  await assert.rejects(second.call("not:a-method"), /Unknown command/);
  assert.equal((await second.call("daemon:status")).version, "9.8.7");
  const stopping = once(observer, "close");
  await second.call("daemon:stop");
  await stopping;
  // Every client hears the stop was asked for, so a desktop doesn't start the host again.
  assert.equal(events.at(-1).channel, "daemon:stopping");
  assert.equal(sessions[0].closed, true);
  const saved = await readSavedState(project);
  assert.ok(saved.sessions[session.id].resumeTurn, "stop saves resumable turn state");
  await assert.rejects(fs.stat(daemon.socketPath), { code: "ENOENT" });
});

test("socket is private and rejects incompatible, malformed and oversized requests", async (t) => {
  const { daemon, dataDir } = await fixture(t);
  assert.equal((await fs.stat(daemon.socketPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(daemon.socketPath))).mode & 0o777, 0o700);
  await assert.rejects(startDaemon({ dataDir, version: "other" }), /already owned/);
  for (const [frame, expected] of [
    [JSON.stringify({ v: 999, id: 1, method: "daemon:status", args: [] }) + "\n", "VERSION_MISMATCH"],
    ["bad json\n", "INVALID_REQUEST"],
    [JSON.stringify({ v: 1, id: 1, method: "daemon:status", args: {} }) + "\n", "INVALID_REQUEST"],
    ["x".repeat(8193), "FRAME_TOO_LARGE"],
  ]) {
    const socket = net.createConnection(daemon.socketPath);
    t.after(() => socket.destroy());
    await once(socket, "connect");
    const reply = once(socket, "data");
    socket.write(frame);
    assert.equal(JSON.parse(String((await reply)[0])).error.code, expected);
    socket.destroy();
  }
});

test("a failed daemon stop reports the save error and permits a retry after recovery", async (t) => {
  const { project, sessions, client } = await fixture(t);
  const first = await client();
  const opened = await first.call("project:open", [project]);
  const session = Object.values(opened.state.sessions)[0];
  await first.call("chat:send", [{ projectPath: project, sessionId: session.id, body: "Keep me", provider: "codex", model: "test" }]);
  await waitFor(() => sessions.length === 1);
  const rename = fs.rename;
  let fail = true;
  t.mock.method(fs, "rename", async (...args) => {
    if (fail && String(args[1]).endsWith("/coordination.json")) throw new Error("disk full");
    return rename(...args);
  });
  const events = [];
  first.on("event", (event) => events.push(event.channel));
  try {
    await assert.rejects(first.call("daemon:stop"), /disk full/);
    assert.equal(sessions[0].closed, true);
  } finally {
    fail = false;
  }
  assert.equal(events.includes("daemon:stopping"), false, "a stop that failed to save is not announced");
  assert.equal((await first.call("daemon:stop")).stopping, true);
});

test("desktop capability advertises methods, flush preserves a running turn, and waiting notices reach clients", async (t) => {
  const { project, sessions, client } = await fixture(t);
  const desktop = await client();
  const mobile = await client();
  const status = await desktop.call("daemon:status");
  assert.ok(status.capabilities?.includes("desktop-v1"));
  assert.ok(status.methods.includes("chat:send"));
  assert.equal(status.closing, false);
  const notices = [];
  desktop.on("event", (event) => {
    if (event.channel === "notification:waiting") notices.push(event.payload);
  });
  const opened = await desktop.call("project:open", [project]);
  const session = Object.values(opened.state.sessions)[0];
  await mobile.call("chat:send", [
    { projectPath: project, sessionId: session.id, body: "Shared Chat", provider: "codex", model: "test", permissionMode: "ask" },
  ]);
  await waitFor(() => notices.length);
  assert.equal(notices[0].requestId, "permission-1");
  await desktop.call("daemon:flush");
  desktop.close();
  assert.equal(sessions[0].closed, false);
  assert.ok(JSON.stringify(await mobile.call("chat:runs")).includes("permission-1"));
  const saved = await readSavedState(project);
  assert.ok(saved.messages.some((message) => message.body === "Shared Chat"));
});

test("each desktop connection keeps its own Project and focus cannot read another client Chat", async (t) => {
  const { project, client } = await fixture(t);
  const other = path.join(path.dirname(project), "other");
  await fs.mkdir(other);
  execFileSync("git", ["init", "-b", "main", other], { stdio: "ignore" });
  const first = await client();
  const second = await client();
  const a = await first.call("project:open", [project]);
  const b = await second.call("project:open", [other]);
  const aId = Object.values(a.state.sessions)[0].id;
  const bId = Object.values(b.state.sessions)[0].id;
  await first.call("chat:set-open", [`${project}#${aId}`]);
  await second.call("chat:set-open", [`${other}#${bId}`]);
  await second.call("chat:patch", [other, bId, { unread: true }]);
  await first.call("daemon:focus", [{ focused: true }]);
  assert.equal((await second.call("project:snapshot", [other])).state.sessions[bId].unread, true);
  assert.equal((await first.call("project:current")).path, project);
  assert.equal((await second.call("project:current")).path, other);
  await assert.rejects(first.call("daemon:focus", [{ focused: "yes" }]), /focused/);
});

test("paged snapshots preserve one immutable watermark across Projects above the frame limit", async (t) => {
  const maxFrameBytes = 8192;
  // Two note bodies alone exceed the limit, independent of temporary-path length.
  const body = "x".repeat(Math.ceil(maxFrameBytes * 0.6));
  const { dataDir, project } = await fixture(t, { maxFrameBytes });
  const client = await connect({ dataDir });
  t.after(() => client.close());
  const other = path.join(path.dirname(project), "other");
  await fs.mkdir(other);
  execFileSync("git", ["init", "-b", "main", other], { stdio: "ignore" });
  for (const folder of [project, other]) {
    const opened = await client.call("project:open", [folder]);
    const session = Object.values(opened.state.sessions)[0];
    await client.call("chat:git-note", [`${folder}#${session.id}`, body]);
    const snapshot = await client.call("project:snapshot", [folder]);
    assert.equal(snapshot.state.messages[0].body, body);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < maxFrameBytes);
  }
  // The client reads an unpaged snapshot over the limit in pages too.
  assert.equal((await client.call("daemon:snapshot")).projects.length, 2);
  const manifest = await client.call("daemon:snapshot", [{ paged: true }]);
  assert.ok(manifest.pageCount > 1);
  await assert.rejects(client.call("daemon:snapshot-page", [manifest.snapshotId, 1]), /out of order/);
  const stranger = await connect({ dataDir });
  t.after(() => stranger.close());
  await assert.rejects(stranger.call("daemon:snapshot-page", [manifest.snapshotId, 0]), /expired/);
  const opened = await client.call("project:snapshot", [project]);
  const session = Object.values(opened.state.sessions)[0];
  await client.call("chat:patch", [project, session.id, { title: "Changed after capture" }]);
  const fragments = [];
  for (let index = 0; index < manifest.pageCount; index++) fragments.push(await client.call("daemon:snapshot-page", [manifest.snapshotId, index]));
  const captured = JSON.parse(fragments.join(""));
  assert.equal(captured.projects.length, 2);
  for (const snapshot of captured.projects) assert.equal(snapshot.state.messages[0].body, body);
  assert.equal(captured.eventSeq, manifest.eventSeq);
  assert.notEqual(captured.projects.find((item) => item.path === project).state.sessions[session.id].title, "Changed after capture");
  await assert.rejects(client.call("daemon:snapshot-page", [manifest.snapshotId, 0]), /expired|snapshot/i);
});

test("a Project state over 16 MB opens through the client, and a change to it keeps every connection", async (t) => {
  const { project, client } = await fixture(t, { maxFrameBytes: MAX_FRAME_BYTES });
  const { session, messages } = largeChat({ worktreeId: 1, sessionId: 2, firstId: 10 });
  await writeState(project, {
    next_id: 5000,
    projects: { 1: { id: 1, name: "project" } },
    worktrees: { 1: { id: 1, project_id: 1, path: project, name: "main" } },
    sessions: { 2: session },
    messages,
    tasks: {},
  });
  const desktop = await client();
  const observer = await client();
  const events = [];
  observer.on("event", (event) => events.push(event));
  const opened = await desktop.call("project:open", [project]);
  assert.ok(Buffer.byteLength(JSON.stringify(opened)) > MAX_FRAME_BYTES);
  assert.equal(opened.state.messages.length, 900);
  assert.equal(opened.state.messages[899].body.length, 20_000);
  assert.equal((await desktop.call("project:current")).state.messages.length, 900);
  await desktop.call("chat:patch", [project, 2, { title: "Renamed" }]);
  const changed = await waitFor(() => events.find((event) => event.channel === "project:state"));
  assert.equal(changed.payload.path, project);
  assert.equal(changed.payload.stateTooLarge, true, "the state is left out of the event and read in pages");
  assert.equal("state" in changed.payload, false);
  assert.equal((await observer.call("project:snapshot", [project])).state.sessions[2].title, "Renamed");
  assert.equal((await desktop.call("daemon:status")).version, "9.8.7");
});

test("a response over the frame limit fails with a clear error for a client that cannot read pages", async (t) => {
  const { daemon, project, client } = await fixture(t);
  const first = await client();
  const opened = await first.call("project:open", [project]);
  const session = Object.values(opened.state.sessions)[0];
  // Two notes, each small enough to send, make a state over this fixture's 8 KB frame limit.
  for (const body of ["x".repeat(5000), "z".repeat(5000)]) await first.call("chat:git-note", [`${project}#${session.id}`, body]);
  assert.equal((await first.call("project:snapshot", [project])).state.messages[1].body.length, 5000);
  const socket = net.createConnection(daemon.socketPath);
  t.after(() => socket.destroy());
  await once(socket, "connect");
  const refused = await rawRequest(socket, { v: 1, id: 1, method: "project:snapshot", args: [project] });
  assert.equal(refused.error.code, "FRAME_TOO_LARGE");
  assert.match(refused.error.message, /over the local daemon's .* frame limit/);
  const status = await rawRequest(socket, { v: 1, id: 2, method: "daemon:status", args: [] });
  assert.ok(status.result.capabilities.includes("result-pages-v1"), "the connection stays open");
});

test("pages of a response are read in order, by the connection that asked, before they expire", async (t) => {
  const { dataDir, project, client } = await fixture(t);
  const first = await client();
  const opened = await first.call("project:open", [project]);
  const session = Object.values(opened.state.sessions)[0];
  for (const body of ["y".repeat(5000), "w".repeat(5000)]) await first.call("chat:git-note", [`${project}#${session.id}`, body]);
  const socket = net.createConnection(require("./paths.cjs").socketPath(dataDir));
  t.after(() => socket.destroy());
  await once(socket, "connect");
  const manifest = await rawRequest(socket, { v: 1, id: 1, method: "project:snapshot", args: [project], pages: true });
  assert.ok(manifest.pages.pageCount > 1);
  assert.equal("result" in manifest, false);
  await assert.rejects(first.call("daemon:result-page", [manifest.pages.pageId, 0]), /expired|out of order/);
  const outOfOrder = await rawRequest(socket, { v: 1, id: 2, method: "daemon:result-page", args: [manifest.pages.pageId, 1] });
  assert.match(outOfOrder.error.message, /out of order/);
  const parts = [];
  for (let index = 0; index < manifest.pages.pageCount; index++)
    parts.push((await rawRequest(socket, { v: 1, id: 10 + index, method: "daemon:result-page", args: [manifest.pages.pageId, index] })).result);
  assert.deepEqual(
    JSON.parse(parts.join("")).state.messages.map((item) => item.body),
    ["y".repeat(5000), "w".repeat(5000)],
  );
  const again = await rawRequest(socket, { v: 1, id: 99, method: "daemon:result-page", args: [manifest.pages.pageId, 0] });
  assert.match(again.error.message, /expired/);
});

test("chats brought back from a large old worktree file load through the daemon", async (t) => {
  const { project, client } = await fixture(t, { maxFrameBytes: MAX_FRAME_BYTES });
  execFileSync("git", ["-C", project, ...gitConfig, "commit", "--allow-empty", "-m", "Initial"], { stdio: "ignore" });
  const linked = path.join(path.dirname(project), "linked");
  execFileSync("git", ["-C", project, "worktree", "add", "-b", "linked", linked], { stdio: "ignore" });
  const { session, messages } = largeChat({ worktreeId: 2, sessionId: 3, firstId: 10 });
  await writeState(linked, {
    next_id: 5000,
    projects: { 1: { id: 1, name: "linked" } },
    worktrees: { 1: { id: 1, project_id: 1, path: project, name: "main" }, 2: { id: 2, project_id: 1, path: linked, name: "linked" } },
    sessions: { 3: session },
    messages,
    tasks: {},
    approvals: [],
  });
  assert.ok((await fs.stat(path.join(linked, ".milagre/coordination.json"))).size > MAX_FRAME_BYTES);
  const desktop = await client();
  const opened = await desktop.call("project:open", [project, { takeNotice: true }]);
  assert.deepEqual(opened.restoredChats, [{ worktree: "linked", count: 1 }]);
  const chat = Object.values(opened.state.sessions).find((item) => item.title === "Long chat");
  assert.equal(opened.state.worktrees[chat.worktree_id].path, linked);
  assert.equal(opened.state.messages.filter((item) => item.session_id === chat.id).length, 900);
  assert.equal((await desktop.call("project:current")).restoredChats, undefined);
  await assert.rejects(fs.stat(path.join(linked, ".milagre/coordination.json")), { code: "ENOENT" });
});

// A project whose state is a few pages at this fixture's 8 KB frames: two notes, each small enough to send.
async function notedProject(first, project, letters = ["p", "q"]) {
  const opened = await first.call("project:open", [project]);
  const session = Object.values(opened.state.sessions)[0];
  for (const letter of letters) await first.call("chat:git-note", [`${project}#${session.id}`, letter.repeat(5000)]);
  return session;
}

test("many paged reads at once on one connection all finish, waiting instead of evicting one being read", async (t) => {
  const { project, client } = await fixture(t, { pagesBudgetChars: 3000 });
  const first = await client();
  await notedProject(first, project);
  const reads = await Promise.all(Array.from({ length: 8 }, () => first.call("project:snapshot", [project])));
  for (const read of reads)
    assert.deepEqual(
      read.state.messages.map((item) => item.body),
      ["p".repeat(5000), "q".repeat(5000)],
    );
});

test("a paged response stays while its reader keeps going and expires once it stops", async (t) => {
  const { dataDir, project, client } = await fixture(t, { pagesTtlMs: 1000 });
  await notedProject(await client(), project);
  const socket = net.createConnection(require("./paths.cjs").socketPath(dataDir));
  t.after(() => socket.destroy());
  await once(socket, "connect");
  let id = 0;
  const ask = (method, args, extra = {}) => rawRequest(socket, { v: 1, id: ++id, method, args, ...extra });
  const steady = (await ask("project:snapshot", [project], { pages: true })).pages;
  assert.ok(steady.pageCount >= 3);
  const parts = [];
  for (let index = 0; index < steady.pageCount; index++) {
    // Each gap is well under the limit (a busy CI runner once stretched 200ms gaps past 300ms); the whole read is over it.
    if (index) await delay(600);
    parts.push((await ask("daemon:result-page", [steady.pageId, index])).result);
  }
  assert.equal(JSON.parse(parts.join("")).state.messages.length, 2);
  const stalled = (await ask("project:snapshot", [project], { pages: true })).pages;
  assert.equal(typeof (await ask("daemon:result-page", [stalled.pageId, 0])).result, "string");
  await delay(1500);
  assert.match((await ask("daemon:result-page", [stalled.pageId, 1])).error.message, /expired/);
});

test("an event whose state is over a quarter of a frame is sent without it", async (t) => {
  const { project, client } = await fixture(t);
  const first = await client();
  const observer = await client();
  const events = [];
  observer.on("event", (event) => events.push(event));
  const session = await notedProject(first, project, ["r"]);
  await first.call("chat:patch", [project, session.id, { title: "Quarter" }]);
  const changed = await waitFor(() => events.find((event) => event.channel === "project:state" && event.payload.stateTooLarge));
  assert.equal("state" in changed.payload, false);
  assert.equal((await observer.call("project:snapshot", [project])).state.sessions[session.id].title, "Quarter");
});

test("a daemon that resumes a turn at startup brings the chats back first and keeps the notice for the window", async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-daemon-resume-")));
  const project = path.join(directory, "project");
  const linked = path.join(directory, "linked");
  const dataDir = path.join(directory, "profile");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  execFileSync("git", ["-C", project, ...gitConfig, "commit", "--allow-empty", "-m", "Initial"], { stdio: "ignore" });
  execFileSync("git", ["-C", project, "worktree", "add", "-b", "linked", linked], { stdio: "ignore" });
  // A stale stopped turn makes startup load the project; a recent entry from before #117 names the linked worktree.
  await writeState(project, {
    next_id: 20,
    projects: { 1: { id: 1, name: "project" } },
    worktrees: { 1: { id: 1, project_id: 1, path: project, name: "main" } },
    sessions: { 2: { id: 2, worktree_id: 1, agent_name: "main", status: "Created", resumeTurn: { stoppedAt: 0 } } },
    messages: [],
    tasks: {},
  });
  await writeState(linked, {
    next_id: 9,
    projects: { 1: { id: 1, name: "linked" } },
    worktrees: { 1: { id: 1, project_id: 1, path: linked, name: "linked" } },
    sessions: { 3: { id: 3, worktree_id: 1, agent_name: "linked", status: "Created", native_session_id: "from-linked", title: "Linked chat" } },
    messages: [{ id: 4, session_id: 3, body: "Saved in linked", context: null }],
    tasks: {},
  });
  await fs.mkdir(dataDir);
  await fs.writeFile(
    path.join(dataDir, "recent-projects.json"),
    JSON.stringify([
      { path: linked, name: "linked" },
      { path: project, name: "project" },
    ]),
  );
  const daemon = await startDaemon({ dataDir, version: "test", runtimeOptions: { cwd: project, environmentReady: Promise.resolve(), titleModels: {} } });
  const desktop = await connect({ dataDir });
  t.after(async () => {
    desktop.close();
    try {
      await daemon.close();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  // Startup already merged it: the old file is renamed, and no project was made of the linked worktree.
  const left = await fs.readdir(path.join(linked, ".milagre"));
  assert.equal(left.includes("coordination.json"), false);
  assert.equal(left.filter((name) => name.startsWith("coordination.json.migrated-")).length, 1);
  // The phone's bridge opening first (no takeNotice) leaves the notice for the desktop window.
  assert.equal((await desktop.call("project:open", [project])).restoredChats, undefined);
  const opened = await desktop.call("project:open", [project, { takeNotice: true }]);
  assert.deepEqual(opened.restoredChats, [{ worktree: "linked", count: 1 }]);
  assert.equal(Object.values(opened.state.sessions).filter((session) => session.title === "Linked chat").length, 1);
  assert.equal((await desktop.call("project:open", [project, { takeNotice: true }])).restoredChats, undefined);
  await daemon.close();
  assert.equal((await fs.readdir(path.join(linked, ".milagre"))).includes("coordination.json"), false, "nothing recreated the old file");
});

// No test may dial the real relay.
const fakePhoneOptions = () => ({ localPort: 0, lanPort: null, startRelay: () => ({ close: async () => {}, status: () => "online" }) });
const phoneStatus = async (client, state) =>
  waitFor(async () => {
    const next = await client.call("phone:status");
    return next.state === state && next;
  });
const unreachable = (url) =>
  waitFor(() =>
    fetch(url).then(
      () => false,
      () => true,
    ),
  );

test("phone methods are advertised to desktop, drive a real bridge, and stay out of the mobile bridge", async (t) => {
  const { dataDir, client } = await fixture(t, { phoneOptions: fakePhoneOptions() });
  const desktop = await client();
  const status = await desktop.call("daemon:status");
  for (const method of ["phone:status", "phone:set-enabled", "phone:reset", "phone:open-pairing"]) assert.ok(status.methods.includes(method), method);
  assert.deepEqual(await desktop.call("phone:status"), { enabled: false, state: "off", remote: "none", lan: { enabled: false, addresses: [] } });
  const changes = [];
  desktop.on("event", (event) => {
    if (event.channel === "phone:status") changes.push(event.payload.state);
  });
  assert.equal((await desktop.call("phone:set-enabled", [true])).state, "starting");
  const on = await phoneStatus(desktop, "on");
  assert.equal(on.remote, "relay");
  assert.ok(on.pairingUntil > Date.now(), "enabling opens the pairing window");
  const reopened = await desktop.call("phone:open-pairing");
  assert.ok(reopened.pairingUntil >= on.pairingUntil);
  assert.match(on.localUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(on.qrSvg, /^<svg/);
  const token = new URL(on.pairingLink).searchParams.get("token");
  await waitFor(() => changes.includes("on"));
  assert.deepEqual(changes.slice(0, 2), ["starting", "on"]);
  // The phone's own bridge serves daemon methods but never the ones that manage its access.
  const call = (method, args = [], url = on.localUrl, bearer = token) =>
    fetch(url + "/rpc", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ v: 1, method, args }),
    });
  assert.equal((await call("daemon:status")).status, 200);
  for (const [method, args] of [["phone:status"], ["phone:set-enabled", [false]], ["phone:reset"], ["phone:open-pairing"]])
    assert.equal((await call(method, args)).status, 403, method);
  assert.equal((await desktop.call("phone:status")).state, "on");
  await assert.rejects(desktop.call("phone:set-enabled", ["yes"]), /true or false/);
  // A reset settles (and clears push registrations) before it answers, so it answers with the new code.
  assert.equal((await desktop.call("phone:reset")).state, "on");
  const again = await phoneStatus(desktop, "on");
  assert.notEqual(new URL(again.pairingLink).searchParams.get("token"), token);
  assert.equal((await call("daemon:status", [], again.localUrl)).status, 401, "the old token stops working");
  assert.equal((await desktop.call("phone:set-enabled", [false])).state, "off");
  await unreachable(again.localUrl + "/rpc");
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, "mobile.json"), "utf8")).enabled, false);
});

test("phone:set-lan is listed, reaches the phone setting and stays out of the mobile bridge", async (t) => {
  const { client } = await fixture(t, { phoneOptions: fakePhoneOptions() });
  const desktop = await client();
  const status = await desktop.call("daemon:status");
  assert.ok(status.methods.includes("phone:set-lan"));
  // The fake phone has no LAN port, so the setting stays off whatever is saved.
  assert.equal((await desktop.call("phone:set-lan", [false])).lan.enabled, false);
  await assert.rejects(desktop.call("phone:set-lan", ["yes"]), /true or false/);
  await desktop.call("phone:set-enabled", [true]);
  const on = await phoneStatus(desktop, "on");
  const token = new URL(on.pairingLink).searchParams.get("token");
  const response = await fetch(on.localUrl + "/rpc", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ v: 1, method: "phone:set-lan", args: [true] }),
  });
  assert.equal(response.status, 403);
});

test("a first pairing reaches the desktop as phone:paired, with the count in the phone status", async (t) => {
  const relays = [];
  const startRelay = (options) => {
    relays.push(options);
    return { close: async () => {}, status: () => "online" };
  };
  const { client } = await fixture(t, { phoneOptions: { localPort: 0, lanPort: null, startRelay } });
  const desktop = await client();
  const paired = [];
  desktop.on("event", (event) => {
    if (event.channel === "phone:paired") paired.push(event.payload);
  });
  await desktop.call("phone:set-enabled", [true]);
  assert.equal((await phoneStatus(desktop, "on")).pairedPhones, 0);
  await relays[0].phones.add("phoneA");
  await waitFor(() => paired.length === 1);
  assert.deepEqual(paired, [{ pairedPhones: 1, kind: "phone" }]);
  assert.equal((await desktop.call("phone:status")).pairedPhones, 1);
});

test("a phone reset while the phone is off answers off", async (t) => {
  const { client } = await fixture(t, { phoneOptions: fakePhoneOptions() });
  const desktop = await client();
  assert.deepEqual(await desktop.call("phone:reset"), { enabled: false, state: "off", remote: "none", lan: { enabled: false, addresses: [] } });
});

test("an enabled phone comes back when the daemon restarts, and stopping the daemon closes its bridge", async (t) => {
  const first = await fixture(t, { phoneOptions: fakePhoneOptions() });
  const desktop = await first.client();
  await desktop.call("phone:set-enabled", [true]);
  const on = await phoneStatus(desktop, "on");
  await first.daemon.close();
  await unreachable(on.localUrl + "/rpc");
  const second = await startDaemon({
    dataDir: first.dataDir,
    version: "9.8.7",
    phoneOptions: fakePhoneOptions(),
    runtimeOptions: { environmentReady: Promise.resolve(), titleModels: {}, agentCli: Object.assign(async () => ({ command: null }), { invalidate() {} }) },
  });
  const client = await connect({ dataDir: first.dataDir });
  try {
    const back = await phoneStatus(client, "on");
    assert.equal(new URL(back.pairingLink).searchParams.get("token"), new URL(on.pairingLink).searchParams.get("token"));
  } finally {
    client.close();
    await second.close();
  }
});

test("captures let in together reserve their room at once, so they stay within the budget and the slot cap", async () => {
  const { createResultPages } = require("./server.cjs");
  const { MAX_PENDING } = require("./protocol.cjs");
  const pages = createResultPages(8192, { budgetChars: 3000 });
  const text = "x".repeat(2000);
  let admitted = 0;
  const first = await pages.capture(text);
  admitted++;
  const rest = Array.from({ length: 5 }, () =>
    pages.capture(text).then((result) => {
      admitted++;
      return result;
    }),
  );
  await new Promise(setImmediate);
  assert.equal(admitted, 1);
  // Reading the first to its end frees its room: exactly one waiter takes it.
  for (let index = 0; index < first.pageCount; index++) pages.page(first.pageId, index);
  await new Promise(setImmediate);
  assert.equal(admitted, 2);
  assert.deepEqual(pages.usage(), { slots: 1, chars: 2000 });
  // Small captures stop at MAX_PENDING slots, and only MAX_PENDING more may wait.
  const many = createResultPages(8192);
  let small = 0;
  const all = Array.from({ length: MAX_PENDING * 2 }, () =>
    many.capture("y".repeat(100)).then(() => {
      small++;
    }),
  );
  await new Promise(setImmediate);
  assert.equal(small, MAX_PENDING);
  assert.equal(many.usage().slots, MAX_PENDING);
  await assert.rejects(many.capture("z"), { code: "PAGES_BUSY" });
  pages.clear();
  many.clear();
  await Promise.all([...rest, ...all]);
});

// A plain socket that collects every reply by id, for requests the client would cap.
async function rawConnection(t, dataDir) {
  const socket = net.createConnection(require("./paths.cjs").socketPath(dataDir));
  t.after(() => socket.destroy());
  await once(socket, "connect");
  const replies = new Map();
  let text = "";
  socket.on("data", (chunk) => {
    text += chunk;
    const lines = text.split("\n");
    text = lines.pop();
    for (const line of lines) {
      const message = JSON.parse(line);
      if (message.id != null) replies.set(message.id, message);
    }
  });
  let closed = false;
  socket.on("close", () => {
    closed = true;
  });
  const send = (request) => socket.write(JSON.stringify({ v: 1, args: [], ...request }) + "\n");
  const reply = (id) => waitFor(() => replies.get(id) || (closed && { closed: true }));
  return { send, reply, replies, isClosed: () => closed };
}

test("replies waiting for paging room do not hold the slots a reader needs for its pages", async (t) => {
  const { dataDir, project, client } = await fixture(t, { pagesBudgetChars: 3000 });
  await notedProject(await client(), project);
  const raw = await rawConnection(t, dataDir);
  // As many requests as a connection may have in flight; the first gets its pages, the other 31 wait for room.
  for (let id = 1; id <= 32; id++) raw.send({ id, method: "project:snapshot", args: [project], pages: true });
  const first = (await raw.reply(1)).pages;
  await delay(100);
  // One more takes the slot the first reply gave back, and waits too: 32 now wait.
  raw.send({ id: 33, method: "project:snapshot", args: [project], pages: true });
  await delay(100);
  assert.equal(raw.replies.size, 1, "the rest wait for room");
  // The reader's page reads still get through, and the socket stays open.
  const parts = [];
  for (let index = 0; index < first.pageCount; index++) {
    raw.send({ id: 100 + index, method: "daemon:result-page", args: [first.pageId, index] });
    const page = await raw.reply(100 + index);
    assert.equal(page.error, undefined, JSON.stringify(page));
    parts.push(page.result);
  }
  assert.equal(JSON.parse(parts.join("")).state.messages.length, 2);
  assert.ok((await raw.reply(2)).pages, "the next waiting reply gets its room");
  assert.equal(raw.isClosed(), false);
});

test("paged snapshots follow the result-page rules: two at once, re-armed by each read, expiring when left", async (t) => {
  const { project, client } = await fixture(t, { pagesTtlMs: 1000 });
  const first = await client();
  await notedProject(first, project);
  const one = await first.call("daemon:snapshot", [{ paged: true }]);
  const two = await first.call("daemon:snapshot", [{ paged: true }]);
  assert.ok(one.pageCount > 2 && two.pageCount > 2);
  // Both are read, side by side: the second capture didn't evict the first, and each read re-arms its limit.
  const parts = [[], []];
  for (let index = 0; index < Math.max(one.pageCount, two.pageCount); index++) {
    if (index) await delay(400);
    for (const [slot, manifest] of [one, two].entries()) {
      if (index < manifest.pageCount) parts[slot].push(await first.call("daemon:snapshot-page", [manifest.snapshotId, index]));
    }
  }
  for (const text of parts) assert.equal(JSON.parse(text.join("")).projects.length, 1);
  const stalled = await first.call("daemon:snapshot", [{ paged: true }]);
  await first.call("daemon:snapshot-page", [stalled.snapshotId, 0]);
  await delay(1500);
  await assert.rejects(first.call("daemon:snapshot-page", [stalled.snapshotId, 1]), /expired/);
});

test("daemon delivers push after clients leave and Phone reset/disable revokes registrations", async (t) => {
  const messages = [];
  let emit;
  const { dataDir, project, client } = await fixture(t, {
    pushOptions: {
      fetcher: async (url, options) => {
        assert.ok(url.endsWith("/send"));
        messages.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ data: { status: "ok", id: "ticket" } }));
      },
    },
    runtimeOptions: {
      environmentReady: Promise.resolve(),
      titleModels: {},
      agentCli: Object.assign(async () => ({ command: "/fake/codex" }), { invalidate() {} }),
      createSession(_provider, options) {
        emit = options.emit;
        return {
          async startTurn() {
            emit({ type: "turn-started", turnId: "turn" });
            emit({ type: "permission-request", requestId: "approval", title: "Run?", tool: "Shell", kind: "command", command: "ls" });
            return { turnId: "turn" };
          },
          async close() {
            emit({ type: "turn-cancelled" });
          },
        };
      },
    },
  });
  const c = await client();
  assert.ok((await c.call("daemon:status")).capabilities.includes("mobile-push-v1"));
  const registration = {
    deviceId: "b6e2df4b-972b-4e7b-bc65-6cda0a173798",
    token: "ExpoPushToken[test]",
    hostId: "https://mac.example",
    notifyWhenWaiting: true,
    notifyOnCompletion: true,
  };
  await c.call("push:register", [registration]);
  const opened = await c.call("project:open", [project]);
  const session = Object.values(opened.state.sessions)[0];
  await c.call("chat:send", [{ projectPath: project, sessionId: session.id, body: "Hello", provider: "codex", model: "test", permissionMode: "ask" }]);
  await waitFor(() => messages.length === 1);
  c.close();
  emit({ type: "permission-resolved", requestId: "approval" });
  emit({ type: "text-delta", text: "Completed on the daemon." });
  emit({ type: "turn-completed" });
  await waitFor(() => messages.length === 2);
  assert.equal(messages[1].title, "Hello");
  assert.equal(messages[1].body, "Completed on the daemon.");
  assert.ok(!messages[1].subtitle);
  const second = await client();
  await second.call("phone:reset");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, "mobile-push.json"), "utf8")), []);
  await second.call("push:register", [registration]);
  await second.call("phone:set-enabled", [false]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, "mobile-push.json"), "utf8")), []);
});

test("a phone reset or disable answers with the status it settled on, not the one it started from", async (t) => {
  const { client } = await fixture(t, { phoneOptions: { localPort: 0, lanPort: null } });
  const desktop = await client();
  await desktop.call("phone:set-enabled", [true]);
  const on = await phoneStatus(desktop, "on");
  // Settings shows the reply, which arrives after the status events: a stale "starting" would hide the new code.
  const reset = await desktop.call("phone:reset");
  assert.equal(reset.state, "on");
  assert.notEqual(new URL(reset.pairingLink).searchParams.get("token"), new URL(on.pairingLink).searchParams.get("token"));
  const off = await desktop.call("phone:set-enabled", [false]);
  assert.equal(off.state, "off");
});

test("a client that takes state patches gets what changed, one that doesn't still gets the whole state", async (t) => {
  const { project, client } = await fixture(t);
  const patched = await client();
  const whole = await client();
  const patchEvents = [];
  const wholeEvents = [];
  patched.on("event", (event) => patchEvents.push(event));
  whole.on("event", (event) => wholeEvents.push(event));
  assert.ok((await patched.call("daemon:status")).capabilities.includes("state-patches-v1"));
  const { epoch } = await patched.call("daemon:state-patches");
  const opened = await patched.call("project:open", [project]);
  const session = Object.values(opened.state.sessions)[0];
  const held = await patched.call("state:read", [project]);
  assert.equal(held.epoch, epoch);
  assert.deepEqual(held.state, (await patched.call("project:snapshot", [project])).state);

  await patched.call("chat:patch", [project, session.id, { title: "Renamed" }]);
  const change = await waitFor(() => patchEvents.find((event) => event.channel === "project:state" && event.payload.version > held.version));
  assert.equal(change.payload.base, held.version);
  assert.equal(change.payload.epoch, epoch);
  assert.equal("state" in change.payload, false);
  const applied = applyStatePatch(held.state, change.payload.patch);
  assert.deepEqual(applied, (await patched.call("project:snapshot", [project])).state);
  assert.equal(applied.messages, held.state.messages);
  const wholeChange = await waitFor(() =>
    wholeEvents.find((event) => event.channel === "project:state" && event.payload.state?.sessions[session.id].title === "Renamed"),
  );
  assert.equal("patch" in wholeChange.payload, false);

  // The next change follows on from that one.
  await patched.call("chat:patch", [project, session.id, { title: "Again" }]);
  const next = await waitFor(() => patchEvents.find((event) => event.channel === "project:state" && event.payload.version > change.payload.version));
  assert.equal(next.payload.base, change.payload.version);
  assert.equal(applyStatePatch(applied, next.payload.patch).sessions[session.id].title, "Again");
});

test("an open's reply carries its state's number, so the first change is a patch on it; one over the event limit says to read again", async (t) => {
  // An 8 KB frame: the event limit is 2 KB, so a reply longer than that can't go as a patch.
  const { project, client } = await fixture(t);
  const desktop = await client();
  const events = [];
  desktop.on("event", (event) => events.push(event));
  const { epoch } = await desktop.call("daemon:state-patches");
  const opened = await desktop.call("project:open", [project]);
  // Nothing was sent for this Project yet: its numbers start at the state the open answered with.
  assert.equal(opened.epoch, epoch);
  assert.equal(typeof opened.version, "number");
  const session = Object.values(opened.state.sessions)[0];
  const states = () => events.filter((event) => event.channel === "project:state");
  await desktop.call("chat:patch", [project, session.id, { title: "First" }]);
  // The first change follows on from the reply, instead of sending the window to read the whole state again.
  const first = await waitFor(() => states().find((event) => event.payload.version > opened.version));
  assert.equal(first.payload.base, opened.version);
  assert.equal("resync" in first.payload, false);
  const patched = applyStatePatch(opened.state, first.payload.patch);
  assert.deepEqual(patched, (await desktop.call("project:snapshot", [project])).state);
  // Opening it again answers with the state sent last, under its number.
  const reopened = await desktop.call("project:open", [project]);
  assert.equal(reopened.version, first.payload.version);
  assert.deepEqual(reopened.state, patched);
  await desktop.call("chat:git-note", [`${project}#${session.id}`, "x".repeat(5000)]);
  const large = await waitFor(() => states().find((event) => event.payload.version > first.payload.version));
  assert.equal(large.payload.resync, true);
  assert.equal("patch" in large.payload, false);
  const again = await desktop.call("state:read", [project]);
  assert.equal(again.version, large.payload.version);
  assert.equal(again.state.messages.at(-1).body.length, 5000);
});

test("a reply whose state differs from the last sent only in a Chat it loaded keeps that number, for lean and whole clients", async (t) => {
  const { daemon, project, client } = await fixture(t, { lazyMessages: { idleMs: 0, sweepMs: 0 } });
  const lean = await client();
  await lean.call("daemon:state-patches", [{ messages: false }]);
  const whole = await client();
  const wholeEvents = [];
  whole.on("event", (event) => wholeEvents.push(event));
  await whole.call("daemon:state-patches", [{}]);
  const opened = await lean.call("project:open", [project]);
  const session = Object.values(opened.state.sessions)[0];
  await lean.call("chat:git-note", [`${project}#${session.id}`, "First note"]);
  await lean.call("daemon:flush");
  // The Chat leaves memory (a state sent to every client), then its page loads it back: a state sent to nobody.
  await daemon.unloadIdle();
  const sent = await whole.call("state:read", [project]);
  await lean.call("chat:messages", [project, session.id, { turns: 5 }]);
  const leanOpen = await lean.call("project:open", [project]);
  const wholeOpen = await whole.call("project:open", [project]);
  assert.equal(leanOpen.version, sent.version);
  assert.equal(wholeOpen.version, sent.version);
  assert.deepEqual(wholeOpen.state, sent.state);
  // The next change is a patch on that number, and gives the state a fresh read does.
  await lean.call("chat:patch", [project, session.id, { title: "Renamed" }]);
  const change = await waitFor(() => wholeEvents.find((event) => event.channel === "project:state" && event.payload.version > sent.version));
  assert.equal(change.payload.base, sent.version);
  assert.deepEqual(applyStatePatch(wholeOpen.state, change.payload.patch), (await whole.call("state:read", [project])).state);
});

test("project:read with { state: false } opens the Project without its state, under the number of the state last sent", async (t) => {
  const { project, client } = await fixture(t);
  const desktop = await client();
  const { epoch } = await desktop.call("daemon:state-patches", [{ messages: false }]);
  const opened = await desktop.call("project:open", [project]);
  assert.deepEqual(await desktop.call("project:read", [project, { state: false }]), {
    path: project,
    name: path.basename(project),
    git: true,
    version: opened.version,
    epoch,
  });
  // Without it, as before, with the number beside the state.
  const read = await desktop.call("project:read", [project]);
  assert.deepEqual([read.version, read.epoch, read.state.sessions], [opened.version, epoch, opened.state.sessions]);
});

test("a connection's Project follows a sidebar open, and a Link it opens has none", async (t) => {
  const { project, client } = await fixture(t);
  const other = path.join(path.dirname(project), "other");
  await fs.mkdir(other);
  execFileSync("git", ["init", "-b", "main", other], { stdio: "ignore" });
  const desktop = await client();
  await desktop.call("project:open", [other]);
  await desktop.call("project:open", [project]);
  assert.equal((await desktop.call("project:current")).path, project);
  assert.equal((await desktop.call("canvas:open-project", [other])).path, other);
  assert.equal((await desktop.call("project:current")).path, other, "the sidebar's open is the connection's Project");
  const ids = Object.fromEntries((await desktop.call("project:registry")).map((entry) => [entry.path, entry.id]));
  const link = await desktop.call("link:create", [{ name: "Both", projectIds: [ids[project], ids[other]] }]);
  await desktop.call("link:open", [link.id]);
  // With a Link open there is no Project of its own: the window's next start opens the launch Project.
  assert.equal((await desktop.call("project:current")).path, project);
});

test("a client that reads transcripts on demand gets each subagent with the end of its transcript", async (t) => {
  const entry = (n) => ({ id: `e${n}`, kind: "message", text: `Entry ${n}` });
  const { project, client } = await fixture(t, {
    createSession(_provider, options) {
      return {
        closed: false,
        async startTurn() {
          // A provider sends its child as it knows it: here only the entry it just added.
          options.emit({ type: "turn-started", turnId: "turn-1" });
          options.emit({
            type: "subagent-update",
            agent: { id: "child", title: "Review", status: "running", startedAt: 1, updatedAt: Date.now(), transcript: [entry(21)] },
          });
          return { turnId: "turn-1" };
        },
        async close() {
          this.closed = true;
        },
      };
    },
  });
  await fs.mkdir(path.join(project, ".milagre"));
  const transcript = Array.from({ length: 20 }, (_, index) => entry(index + 1));
  await fs.writeFile(
    path.join(project, ".milagre/coordination.json"),
    JSON.stringify({
      next_id: 3,
      projects: { 1: { id: 1, name: "project" } },
      worktrees: { 1: { id: 1, project_id: 1, path: project, name: "main" } },
      sessions: {
        2: {
          id: 2,
          worktree_id: 1,
          agent_name: "main",
          status: "Created",
          subagents: [{ id: "child", title: "Review", status: "running", startedAt: 1, updatedAt: 2, transcript }],
        },
      },
      messages: [],
      tasks: {},
    }),
  );
  const desktop = await client();
  const whole = await client();
  const events = [];
  const wholeEvents = [];
  desktop.on("event", (event) => events.push(event));
  whole.on("event", (event) => wholeEvents.push(event));
  assert.ok((await desktop.call("daemon:status")).capabilities.includes("subagent-tails-v1"));
  await desktop.call("daemon:state-patches", [{ messages: false, transcripts: false }]);
  await whole.call("daemon:state-patches");
  const opened = await desktop.call("project:open", [project]);
  const tail = opened.state.sessions[2].subagents[0];
  assert.deepEqual(
    tail.transcript.map((item) => item.id),
    ["e17", "e18", "e19", "e20"],
  );
  assert.equal(tail.transcriptLength, 20);
  assert.equal((await desktop.call("state:read", [project])).state.sessions[2].subagents[0].transcriptLength, 20);
  assert.equal((await whole.call("project:open", [project])).state.sessions[2].subagents[0].transcript.length, 20);
  const read = await desktop.call("chat:subagent", [project, 2, "child"]);
  assert.deepEqual(read.transcript, transcript);
  await assert.rejects(desktop.call("chat:subagent", [project, 2, "gone"]), /no longer in this Chat/);

  // A running child's update carries only the end of its transcript to this client, and all of it to the other.
  await desktop.call("chat:send", [{ projectPath: project, sessionId: 2, body: "Go", provider: "codex", model: "test", permissionMode: "ask" }]);
  const isUpdate = (event) => event.channel === "agent:event" && event.payload.event.type === "subagent-update";
  const update = (await waitFor(() => events.find(isUpdate))).payload.event.agent;
  assert.equal(update.transcript.length, 4);
  assert.equal(update.transcriptLength, 21);
  assert.equal(update.transcript.at(-1).id, "e21");
  assert.equal((await waitFor(() => wholeEvents.find(isUpdate))).payload.event.agent.transcript.length, 21);
  // The whole transcript read before, with that tail on top, is the host's.
  assert.deepEqual(mergeTranscript(read.transcript, update), (await desktop.call("chat:subagent", [project, 2, "child"])).transcript);
});

test("a client that reads archived subagents on demand gets each as a summary, in states, patches and updates", async (t) => {
  const entry = (n) => ({ id: `e${n}`, kind: "message", text: `Entry ${n}` });
  let emit;
  const { project, client } = await fixture(t, {
    createSession(_provider, options) {
      emit = options.emit;
      return {
        closed: false,
        async startTurn() {
          // An archived child that ended runs again, as a resumed session picks up its background agents.
          options.emit({ type: "turn-started", turnId: "turn-1" });
          options.emit({
            type: "subagent-update",
            agent: { id: "child", title: "Review", status: "running", startedAt: 1, updatedAt: Date.now(), latestActivity: "Writing", transcript: [entry(21)] },
          });
          return { turnId: "turn-1" };
        },
        async close() {
          this.closed = true;
        },
      };
    },
  });
  await fs.mkdir(path.join(project, ".milagre"));
  const transcript = Array.from({ length: 20 }, (_, index) => entry(index + 1));
  const child = {
    id: "child",
    title: "Review",
    status: "completed",
    startedAt: 1,
    updatedAt: 2,
    endedAt: 2,
    archived: true,
    prompt: "Check the auth flow",
    latestActivity: "Reading auth.ts",
    transcript,
  };
  const live = { id: "live", title: "Tests", status: "completed", startedAt: 1, updatedAt: 2, latestActivity: "Finished", transcript: [entry(1)] };
  await writeState(project, {
    next_id: 3,
    projects: { 1: { id: 1, name: "project" } },
    worktrees: { 1: { id: 1, project_id: 1, path: project, name: "main" } },
    sessions: { 2: { id: 2, worktree_id: 1, agent_name: "main", status: "Created", subagents: [child, live] } },
    messages: [],
    tasks: {},
  });
  const desktop = await client();
  const tails = await client();
  const events = [];
  const tailEvents = [];
  desktop.on("event", (event) => events.push(event));
  tails.on("event", (event) => tailEvents.push(event));
  assert.ok((await desktop.call("daemon:status")).capabilities.includes("archived-subagent-summaries-v1"));
  await desktop.call("daemon:state-patches", [{ messages: false, transcripts: false, archivedSubagents: false }]);
  await tails.call("daemon:state-patches", [{ messages: false, transcripts: false }]);
  const opened = await desktop.call("project:open", [project]);
  const [summary, kept] = opened.state.sessions[2].subagents;
  assert.deepEqual(summary, {
    id: "child",
    title: "Review",
    status: "completed",
    startedAt: 1,
    updatedAt: 2,
    endedAt: 2,
    archived: true,
    transcript: [],
    detailsOnDemand: true,
  });
  // A subagent on the track goes as before.
  assert.deepEqual(kept, live);
  assert.equal((await desktop.call("state:read", [project])).state.sessions[2].subagents[0].detailsOnDemand, true);
  // Replies that carry their Project nested (worktree:create, the Linear link and unlink) take the same form.
  const unlinked = await desktop.call("worktree:unlink-issue", [{ projectPath: project, worktreeId: 1 }]);
  assert.equal(unlinked.project.state.sessions[2].subagents[0].detailsOnDemand, true);
  assert.deepEqual([unlinked.project.state.messages, unlinked.project.state.messagesInChats], [[], true]);
  // A client that only takes tails still gets the archived subagent's details.
  const tailed = (await tails.call("state:read", [project])).state.sessions[2].subagents[0];
  assert.equal(tailed.latestActivity, "Reading auth.ts");
  assert.equal(tailed.transcriptLength, 20);
  // Opening it reads the rest.
  const read = await desktop.call("chat:subagent", [project, 2, "child"]);
  assert.equal(read.prompt, "Check the auth flow");
  assert.equal(read.latestActivity, "Reading auth.ts");
  assert.deepEqual(read.transcript, transcript);

  // Restoring it sends its details as a patch on the summary; archiving it again takes them back out.
  let held = await desktop.call("state:read", [project]);
  const patchAfter = async (version) => {
    const event = await waitFor(() => events.find((item) => item.channel === "project:state" && item.payload.version > version));
    assert.equal(event.payload.base, held.version);
    held = { ...held, version: event.payload.version, state: applyStatePatch(held.state, event.payload.patch) };
    return held.state.sessions[2].subagents[0];
  };
  await desktop.call("chat:archive-subagent", [project, 2, "child", false]);
  const restored = await patchAfter(held.version);
  assert.equal(restored.detailsOnDemand, undefined);
  assert.equal(restored.latestActivity, "Reading auth.ts");
  assert.equal(restored.transcriptLength, 20);
  await desktop.call("chat:archive-subagent", [project, 2, "child", true]);
  const archivedAgain = await patchAfter(held.version);
  assert.equal(archivedAgain.detailsOnDemand, true);
  assert.equal("latestActivity" in archivedAgain, false);

  // An ended child that runs again is back on the track, so its update goes whole.
  await desktop.call("chat:send", [{ projectPath: project, sessionId: 2, body: "Go", provider: "codex", model: "test", permissionMode: "ask" }]);
  const isUpdate = (event) => event.channel === "agent:event" && event.payload.event.type === "subagent-update";
  const resumed = (await waitFor(() => events.find(isUpdate))).payload.event.agent;
  assert.equal(resumed.detailsOnDemand, undefined);
  assert.equal(resumed.latestActivity, "Writing");
  // One archived while it runs stays archived: its update goes to this client as a summary, and to the other with its tail.
  await desktop.call("chat:archive-subagent", [project, 2, "child", true]);
  emit({
    type: "subagent-update",
    agent: { id: "child", title: "Review", status: "running", startedAt: 1, updatedAt: Date.now(), latestActivity: "Testing", transcript: [entry(22)] },
  });
  const update = (await waitFor(() => events.filter(isUpdate)[1])).payload.event.agent;
  assert.equal(update.detailsOnDemand, true);
  assert.deepEqual(update.transcript, []);
  assert.equal("latestActivity" in update, false);
  const tailUpdate = (await waitFor(() => tailEvents.filter(isUpdate)[1])).payload.event.agent;
  assert.equal(tailUpdate.latestActivity, "Testing");
  assert.equal(tailUpdate.transcriptLength, 22);
  assert.equal((await desktop.call("chat:subagent", [project, 2, "child"])).latestActivity, "Testing");
});

test("a client that reads messages by Chat gets states without them, and each change's messages beside its patch", async (t) => {
  const { project, client } = await fixture(t);
  const desktop = await client();
  const events = [];
  desktop.on("event", (event) => events.push(event));
  await desktop.call("daemon:state-patches", [{ messages: false }]);
  const opened = await desktop.call("project:open", [project]);
  const session = Object.values(opened.state.sessions)[0];
  const chat = `${project}#${session.id}`;
  await desktop.call("chat:git-note", [chat, "First note"]);
  const held = await desktop.call("state:read", [project]);
  assert.deepEqual(held.state.messages, []);
  assert.equal(held.state.messagesInChats, true);
  // Replies carry states the same way: opening the Project again sends no messages either.
  const again = await desktop.call("project:open", [project]);
  assert.deepEqual([again.state.messages, again.state.messagesInChats], [[], true]);
  assert.ok((await desktop.call("daemon:status")).capabilities.includes("chat-pages-v1"));
  assert.equal(held.state.sessions[session.id].summary.count, 1);
  const page = await desktop.call("chat:messages", [project, session.id, { turns: 5 }]);
  assert.deepEqual(
    page.messages.map((message) => message.body),
    ["First note"],
  );

  await desktop.call("chat:git-note", [chat, "Second note"]);
  const added = await waitFor(() => events.find((event) => event.channel === "project:state" && event.payload.version > held.version));
  assert.equal("state" in added.payload, false);
  assert.equal(JSON.stringify(added.payload.patch ?? {}).includes("Second note"), false, "messages stay out of the patch");
  assert.deepEqual(
    added.payload.messages.changed.map(({ message, after }) => [message.body, after]),
    [["Second note", page.messages[0].id]],
  );
  assert.deepEqual(added.payload.messages.removed, []);
  const applied = applyStatePatch(held.state, added.payload.patch);
  assert.equal(applied.sessions[session.id].summary.count, 2);
  assert.deepEqual((await desktop.call("chat:search", [project, "second note"]))[0].message.session_id, session.id);
});

// Lazy message memory (#321): the host unloads an idle Chat's messages and chats.db is their only copy until needed.
test("a Chat the host unloaded reads back whole, and no client hears its messages removed or added again", async (t) => {
  const { savedRows } = require("@milagre/core/message-store");
  const { daemon, project, client } = await fixture(t, { lazyMessages: { idleMs: 0, sweepMs: 0 } });
  const lean = await client();
  const leanEvents = [];
  lean.on("event", (event) => leanEvents.push(event));
  await lean.call("daemon:state-patches", [{ messages: false }]);
  // An older desktop takes whole states in every event; another takes whole states as patches.
  const older = await client();
  const olderEvents = [];
  older.on("event", (event) => olderEvents.push(event));
  const patcher = await client();
  const patcherEvents = [];
  patcher.on("event", (event) => patcherEvents.push(event));
  await patcher.call("daemon:state-patches", [{}]);

  const opened = await lean.call("project:open", [project]);
  const session = Object.values(opened.state.sessions)[0];
  const chat = `${project}#${session.id}`;
  await lean.call("chat:git-note", [chat, "First note"]);
  await lean.call("chat:git-note", [chat, "A needle in here"]);
  await lean.call("daemon:flush");
  const bodies = (messages) => messages.filter((message) => message.session_id === session.id).map((message) => message.body);
  const ids = () => [...(savedRows(project)?.values() ?? [])].filter((row) => row.chat === session.id).map((row) => row.message.id);
  assert.equal(ids().length, 2);
  await daemon.unloadIdle();
  assert.deepEqual(ids(), [], "the Chat left memory");

  // Every reader still sees it whole.
  assert.deepEqual(bodies((await older.call("state:read", [project])).state.messages), ["First note", "A needle in here"]);
  assert.deepEqual(bodies((await older.call("project:snapshot", [project])).state.messages), ["First note", "A needle in here"]);
  let held = await patcher.call("state:read", [project]);
  assert.deepEqual(bodies(held.state.messages), ["First note", "A needle in here"]);
  assert.equal((await lean.call("state:read", [project])).state.sessions[session.id].summary.count, 2, "its summary stays");
  const [match] = await lean.call("chat:search", [project, "needle"]);
  assert.equal(match.message.session_id, session.id);
  assert.equal((await lean.call("chat:message", [project, match.message.id])).body, "A needle in here");
  assert.deepEqual(ids(), [], "searching and reading one message load nothing");
  const page = await lean.call("chat:messages", [project, session.id, { turns: 5 }]);
  assert.deepEqual(
    page.messages.map((message) => message.body),
    ["First note", "A needle in here"],
  );
  assert.equal(ids().length, 2, "reading its page loads it");

  // A message into the Chat once it left memory again: clients hear only that message.
  await daemon.unloadIdle();
  assert.deepEqual(ids(), []);
  const follow = (events, from) => events.filter((event) => event.channel === "project:state").slice(from);
  const leanFrom = follow(leanEvents, 0).length;
  const olderFrom = follow(olderEvents, 0).length;
  await lean.call("chat:git-note", [chat, "Third note"]);
  const added = await waitFor(() => follow(leanEvents, leanFrom).find((event) => event.payload.messages?.changed.length));
  assert.deepEqual(
    added.payload.messages.changed.map(({ message }) => message.body),
    ["Third note"],
  );
  assert.deepEqual(added.payload.messages.removed, []);
  const whole = await waitFor(() =>
    follow(olderEvents, olderFrom).find((event) => event.payload.state && bodies(event.payload.state.messages).includes("Third note")),
  );
  assert.deepEqual(bodies(whole.payload.state.messages), ["First note", "A needle in here", "Third note"]);

  // It leaves memory again, and a change elsewhere follows: nobody hears its messages removed.
  await lean.call("daemon:flush");
  await daemon.unloadIdle();
  assert.deepEqual(ids(), []);
  const leanBefore = follow(leanEvents, 0).length;
  const olderBefore = follow(olderEvents, 0).length;
  await lean.call("chat:patch", [project, session.id, { title: "Renamed" }]);
  const renamed = await waitFor(() => follow(leanEvents, leanBefore).find((event) => JSON.stringify(event.payload.patch ?? {}).includes("Renamed")));
  assert.deepEqual(renamed.payload.messages, { changed: [], removed: [] });
  const olderRenamed = await waitFor(() => follow(olderEvents, olderBefore).find((event) => event.payload.state?.sessions[session.id].title === "Renamed"));
  assert.deepEqual(bodies(olderRenamed.payload.state.messages), ["First note", "A needle in here", "Third note"]);

  // The patching whole-state client ends where a fresh read does.
  for (const event of patcherEvents.filter((item) => item.channel === "project:state" && item.payload.path === project)) {
    if (event.payload.version <= held.version) continue;
    if (event.payload.resync || event.payload.base !== held.version) held = await patcher.call("state:read", [project]);
    else held = { ...held, version: event.payload.version, state: applyStatePatch(held.state, event.payload.patch) };
  }
  const fresh = await patcher.call("state:read", [project]);
  assert.deepEqual(held.state, fresh.state);
  assert.deepEqual(bodies(fresh.state.messages), ["First note", "A needle in here", "Third note"]);

  // And on disk: everything, in order.
  await lean.call("daemon:flush");
  assert.deepEqual(bodies((await readSavedState(project)).messages), ["First note", "A needle in here", "Third note"]);
});
