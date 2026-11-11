// Real production client and storage readers; copied test Projects only. This is not a live migration probe.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { createHash } = require("node:crypto");
const { connect } = require("../../../apps/daemon/src/client.cjs");
const { connectDesktopRuntime } = require("../../../apps/daemon/src/runtime-client.cjs");
const { socketPath } = require("../../../apps/daemon/src/paths.cjs");
const { readProjectState } = require("../../../packages/core/src/project-store.cjs");
const { readChatRows } = require("../../../packages/core/src/chat-db.cjs");
const { withDetails } = require("../../../packages/core/src/project-content.cjs");
const { chatPage } = require("../../../packages/core/src/chat-pages.cjs");

const binary = process.argv[2];
const temporaryRoot = fs.realpathSync("/tmp");
const oracleRoot = fs.mkdtempSync(path.join(temporaryRoot, "milagre-runtime-oracle-"));
const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
let stage = "startup";
const deadline = setTimeout(() => {
  child.kill("SIGKILL");
  console.error(`Isolated runtime deadline exceeded at ${stage}`);
  process.exitCode = 1;
}, 30000);
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
const exited = once(child, "exit");
const lines = readline.createInterface({ input: child.stdout });
const clients = [];
let runtime;
let metadata;
const terminalPids = new Set();
function digestTree(root) {
  const hash = createHash("sha256");
  function walk(folder) {
    for (const entry of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, entry);
      const stat = fs.lstatSync(file);
      assert.ok(!stat.isSymbolicLink(), "test never follows fixture symlinks");
      hash.update(path.relative(root, file));
      if (stat.isDirectory()) walk(file);
      else {
        assert.ok(stat.isFile());
        hash.update(fs.readFileSync(file));
      }
    }
  }
  walk(root);
  return hash.digest("hex");
}
async function run() {
  const [line] = await once(lines, "line");
  metadata = JSON.parse(line);
  assert.equal(metadata.fixture, true);
  assert.equal(metadata.projectReadsOnly, true);
  assert.equal(metadata.terminals, true);
  assert.equal(path.dirname(metadata.profile), temporaryRoot);
  assert.equal(metadata.socket, socketPath(metadata.profile));
  const projectRoot = path.join(metadata.profile, ".projects");
  const before = digestTree(projectRoot);
  const client = await connect({ dataDir: metadata.profile, timeoutMs: 5000 });
  clients.push(client);
  const second = await connect({ dataDir: metadata.profile, timeoutMs: 5000 });
  clients.push(second);
  const status = await client.call("daemon:status");
  assert.ok(status.capabilities.includes("result-pages-v1"));
  assert.ok(!status.capabilities.includes("desktop-v1"));
  assert.ok(!status.capabilities.includes("state-patches-v1"));
  const copies = new Map();
  for (const name of ["alpha", "legacy", "surrogates", "large"]) {
    const source = path.join(projectRoot, name);
    const oracle = path.join(oracleRoot, name);
    fs.cpSync(source, oracle, { recursive: true });
    // Node readers can compact/write sidecars and initialize SQLite; they only see a separate disposable copy.
    const state = await readProjectState(oracle);
    copies.set(name, { source, oracle, state });
  }
  stage = "scope checks and unopened messages";
  const { source: alpha, oracle: alphaOracle } = copies.get("alpha");
  const { source: legacy } = copies.get("legacy");
  const { source: large } = copies.get("large");
  await assert.rejects(client.call("project:open", [oracleRoot]), { code: "ISOLATED_SCOPE_ONLY" });
  await assert.rejects(client.call("project:open", [path.join(alpha, "..", "alpha") + "/"]), { code: "ISOLATED_SCOPE_ONLY" });
  await assert.rejects(client.call("chat:message", [alpha, 2]), { code: "COMMAND_FAILED", message: "Open the Project before reading its messages." });
  await assert.rejects(client.call("chat:messages", [legacy, 1]), { code: "COMMAND_FAILED" });
  assert.deepEqual(
    await client.call("chat:messages", [alpha, 1, { turns: 1 }]),
    chatPage(
      readChatRows(alphaOracle, [1]).map((row) => row.message),
      1,
      { turns: 1 },
    ),
  );

  stage = "saved Project and Chat read parity";
  for (const [name, { source, oracle, state }] of copies) {
    const opened = await client.call("project:open", [source]);
    assert.deepEqual(opened, { path: source, name, git: false, state });
    assert.deepEqual(await client.call("project:current"), opened, "selection belongs to the current connection");
    const read = await client.call("state:read", [source]);
    assert.deepEqual(read.state, state);
    assert.equal(read.version, 1);
    assert.match(read.epoch, /^isolated-read:/);
    assert.deepEqual((await client.call("project:snapshot", [source])).state, state);
    for (const chat of Object.values(state.sessions)) {
      for (const options of [{}, { turns: 1, limit: 3 }, { limit: 4 }, { before: state.messages.at(-1)?.id }, { turns: 0 }]) {
        assert.deepEqual(
          await client.call("chat:messages", [source, chat.id, options]),
          chatPage(state.messages, chat.id, options),
          `${name} Chat ${chat.id} page`,
        );
      }
    }
    for (const message of state.messages.filter((item) => typeof item.id === "number").slice(0, 8)) {
      assert.deepEqual(await client.call("chat:message", [source, message.id]), await withDetails(oracle, message), `${name} details ${message.id}`);
    }
    for (const identity of ["cm-1", "cm-2", "queued-1", "queued-10", "legacy-cm-1", "legacy-queued", "missing-identity"]) {
      const message = state.messages.find((item) => item.clientMessageId === identity);
      const queued = Object.values(state.sessions).find((chat) => chat.queued?.some((item) => item.clientMessageId === identity));
      const expected = message ? { sessionId: message.session_id } : queued ? { sessionId: queued.id } : null;
      assert.deepEqual(await client.call("chat:send-status", [source, identity]), expected);
    }
    await assert.rejects(client.call("chat:message", [source, "missing-message"]), {
      code: "COMMAND_FAILED",
      message: "That message is no longer in this Project.",
    });
    await assert.rejects(client.call("chat:send-status", [source, ""]), { code: "COMMAND_FAILED", message: "Choose an open Chat and message identity." });
  }
  assert.ok(JSON.stringify(copies.get("large").state).length > 100000);
  assert.equal((await client.call("project:snapshot", [copies.get("surrogates").source])).state.sessions[1].title, "half \ud83d");
  const scopes = [...copies].map(([name, { source, state }]) => ({ path: source, name, state }));
  const { inboxSnapshot } = await import("../../../packages/shared/src/attention.mjs");
  assert.deepEqual(await client.call("chat:inbox"), inboxSnapshot(scopes));

  stage = "per-client selection and production runtime hydration";
  await second.call("project:open", [legacy]);
  assert.equal((await second.call("project:current")).path, legacy);
  assert.equal((await client.call("project:current")).path, large);
  let lastSnapshot;
  const connectionEvents = [];
  runtime = await connectDesktopRuntime({
    connect: () => connect({ dataDir: metadata.profile, timeoutMs: 5000 }),
    emit(channel, payload) {
      if (channel === "runtime:snapshot") lastSnapshot = payload;
      if (channel === "runtime:connection") connectionEvents.push(payload);
    },
  });
  assert.deepEqual((await runtime.openProject(large)).state, copies.get("large").state);
  // Explicit snapshot paging exercises the snapshot serializer independently of ordinary result pages.
  const manifest = await client.call("daemon:snapshot", [{ paged: true }]);
  assert.equal(typeof manifest.snapshotId, "number");
  assert.ok(manifest.pageCount > 100);
  const fragments = [];
  for (let index = 0; index < manifest.pageCount; index++) fragments.push(await client.call("daemon:snapshot-page", [manifest.snapshotId, index]));
  const snapshot = JSON.parse(fragments.join(""));
  assert.deepEqual(
    snapshot.projects.map(({ path: projectPath, name, state }) => ({ path: projectPath, name, state })),
    scopes,
  );
  assert.equal(snapshot.eventSeq, 0);
  // Runtime first connect is intentionally lazy about full snapshots. Its reconnect path is covered in wire tests.
  assert.ok(connectionEvents.every((event) => !event.hostOutdated));
  assert.ok(lastSnapshot === undefined || Array.isArray(lastSnapshot.projects));

  stage = "unsupported mutations leave copies byte-identical";
  for (const method of ["chat:send", "chat:delete", "worktree:create", "project:forget", "scope:retry-save", "command:run", "desktop:invoke", "link:open"]) {
    await assert.rejects(runtime.invoke(method, [alpha, { body: "must not be saved", clientMessageId: "never-sent" }]), {
      code: "UNSUPPORTED_MUTATION",
      message: "The isolated Rust read runtime does not execute mutations or start services",
    });
  }
  assert.equal(digestTree(projectRoot), before, "all reads and refused mutations preserve every copied byte");
  assert.equal(await client.call("chat:send-status", [alpha, "never-sent"]), null);
  assert.ok(!fs.existsSync(path.join(alpha, ".milagre/owner.lock")), "no writer ownership is taken");

  stage = "real terminal commands through the production runtime client";
  const terminalEvents = [];
  client.on("event", (event) => {
    if (event.channel.startsWith("terminal:")) terminalEvents.push(event);
  });
  const chatId = `${alpha}#1`;
  const profiles = await runtime.invoke("terminal:profiles", [{}]);
  assert.equal(profiles.defaultShell, "/bin/sh");
  assert.equal(profiles.selectedShell, null);
  await assert.rejects(runtime.invoke("terminal:setShell", [{ shell: "/not-an-installed-shell" }]), {
    code: "COMMAND_FAILED",
    message: "Choose an installed shell.",
  });
  assert.equal((await runtime.invoke("terminal:setShell", [{ shell: "/bin/sh" }])).selectedShell, "/bin/sh");
  await assert.rejects(runtime.invoke("terminal:open", [{ chatId: `${oracleRoot}#1` }]), {
    code: "COMMAND_FAILED",
    message: "Only copied fixture Chats can open a Terminal.",
  });
  await assert.rejects(runtime.invoke("terminal:open", [{ chatId, cwd: "/tmp" }]), {
    code: "COMMAND_FAILED",
    message: "Choose one of this Chat's Worktrees.",
  });
  await assert.rejects(runtime.invoke("terminal:open", [{ chatId: `${alpha}#3` }]), {
    code: "COMMAND_FAILED",
    message: "That Chat is archived.",
  });
  const terminal = await runtime.invoke("terminal:open", [{ chatId, cols: 91, rows: 27 }]);
  assert.equal(terminal.cwd, alpha);
  assert.equal(terminal.chatId, chatId);
  assert.equal(terminal.cols, 91);
  assert.equal(terminal.rows, 27);
  const viewer = { offset: 0, output: "" };
  async function readUntil(id, state, done) {
    const expires = Date.now() + 10000;
    while (!done(state.output)) {
      assert.ok(Date.now() < expires, "Terminal output deadline");
      const read = await runtime.invoke("terminal:read", [{ terminalId: id, after: state.offset, limit: 4096 }]);
      if (read.reset) state.output = read.data;
      else {
        assert.equal(read.offset, state.offset + read.data.length, "wire offsets count UTF-16 units");
        state.output += read.data;
      }
      state.offset = read.offset;
      assert.equal(read.ended, false);
    }
  }
  await runtime.invoke("terminal:input", [{ terminalId: terminal.id, data: "stty -echo\nprintf 'READY_%s\\n' 'FOR_PROBE'\n" }]);
  await readUntil(terminal.id, viewer, (text) => text.includes("READY_FOR_PROBE\r\n"));
  assert.deepEqual(
    await runtime.invoke("terminal:input", [
      {
        terminalId: terminal.id,
        data: "printf '\\nDIR='; pwd; printf 'PID=%s\\n' \"$$\"; stty size; printf 'UNICODE=🦀\\n'; printf 'MARKERS=\u{10fffe}\u{f0000}\\n'; printf 'RUST_TERMINAL_END\\n'\n",
      },
    ]),
    { accepted: true },
  );
  await readUntil(terminal.id, viewer, (text) => text.includes("RUST_TERMINAL_END\r\n"));
  assert.ok(viewer.output.includes(`DIR=${alpha}\r\n`));
  assert.ok(viewer.output.includes("27 91\r\n"));
  assert.ok(viewer.output.includes("UNICODE=🦀\r\n"));
  assert.ok(viewer.output.includes("MARKERS=\u{10fffe}\u{f0000}\r\n"), "ordinary terminal Unicode is not decoded as storage surrogate markers");
  const pid = Number(/\r\nPID=(\d+)\r\n/.exec(viewer.output)[1]);
  terminalPids.add(pid);
  process.kill(pid, 0);
  await runtime.invoke("terminal:resize", [{ terminalId: terminal.id, cols: 113, rows: 41 }]);
  await runtime.invoke("terminal:input", [{ terminalId: terminal.id, data: "stty size\n" }]);
  await readUntil(terminal.id, viewer, (text) => text.includes("41 113\r\n"));
  await assert.rejects(runtime.invoke("terminal:resize", [{ terminalId: terminal.id, cols: 0, rows: 0 }]), {
    code: "COMMAND_FAILED",
    message: "Invalid Terminal size.",
  });
  stage = "terminal survives viewer disconnect and replays output";
  await runtime.close();
  runtime = null;
  assert.equal((await second.call("terminal:list", [{ chatId }])).terminals[0].id, terminal.id);
  process.kill(pid, 0);
  runtime = await connectDesktopRuntime({ connect: () => connect({ dataDir: metadata.profile, timeoutMs: 5000 }) });
  const replay = { offset: 0, output: "" };
  await readUntil(terminal.id, replay, (text) => text.includes("UNICODE=🦀\r\n"));
  await runtime.invoke("terminal:input", [{ terminalId: terminal.id, data: "printf '\\nAFTER_VIEWER_DISCONNECT=%s\\n' \"$$\"\n" }]);
  await readUntil(terminal.id, replay, (text) => text.includes(`AFTER_VIEWER_DISCONNECT=${pid}\r\n`));
  await runtime.invoke("terminal:close", [{ terminalId: terminal.id }]);
  assert.deepEqual(await runtime.invoke("terminal:list", [{ chatId }]), { terminals: [] });
  await assert.rejects(runtime.invoke("terminal:input", [{ terminalId: terminal.id, data: "never executes\n" }]), {
    code: "COMMAND_FAILED",
    message: "This Terminal has ended.",
  });
  assert.ok(terminalEvents.some((event) => event.channel === "terminal:changed" && event.payload.chatId === chatId));
  assert.ok(terminalEvents.some((event) => event.channel === "terminal:preferences-changed"));
  assert.ok(terminalEvents.every((event, index) => index === 0 || event.seq > terminalEvents[index - 1].seq));
  await runtime.invoke("terminal:setShell", [{ shell: null }]);
  // Leave one shell to prove daemon shutdown disposes host-owned PTYs before the temporary profile disappears.
  const survivor = await runtime.invoke("terminal:open", [{ chatId }]);
  const survivingViewer = { offset: 0, output: "" };
  await runtime.invoke("terminal:input", [{ terminalId: survivor.id, data: "printf '\\nSHUTDOWN_PID=%s\\n' \"$$\"\n" }]);
  await readUntil(survivor.id, survivingViewer, (text) => /\r\nSHUTDOWN_PID=\d+\r\n/.test(text));
  terminalPids.add(Number(/\r\nSHUTDOWN_PID=(\d+)\r\n/.exec(survivingViewer.output)[1]));
  assert.equal(digestTree(projectRoot), before, "terminal commands did not write copied Project bytes");

  stage = "tamper refusal";
  // Deliberately change only an isolated fixture after byte-preservation assertions.
  fs.appendFileSync(path.join(legacy, ".milagre/coordination.json"), "\n");
  await assert.rejects(client.call("state:read", [legacy]), { code: "FIXTURE_CHANGED" });
  const extra = path.join(alpha, ".milagre/forbidden-link");
  fs.symlinkSync(oracleRoot, extra);
  await assert.rejects(client.call("state:read", [alpha]), { code: "UNSAFE_FIXTURE" });
  fs.unlinkSync(extra);
  console.log(
    "Rust runtime Node conformance passed: 4 copied Projects, saved reads, UTF-16, inbox, paged state, isolation, explicit mutation errors, real PTY commands/disconnect/shutdown",
  );
}
run()
  .catch((error) => {
    console.error(`At ${stage}:`, error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await runtime?.close();
    for (const client of clients) client.close();
    child.stdin.end();
    const [code] = await exited;
    if (code !== 0) {
      console.error(stderr);
      process.exitCode = 1;
    }
    lines.close();
    clearTimeout(deadline);
    if (metadata && (fs.existsSync(metadata.profile) || fs.existsSync(metadata.socket))) {
      console.error("Isolated runtime did not remove its own temporary profile/socket");
      process.exitCode = 1;
    }
    fs.rmSync(oracleRoot, { recursive: true, force: true });
  });
