// Actual Rust ProjectStates and actual Node ProjectStates, each owning/reading disposable fixture copies only.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { wire } = require("../../../apps/daemon/src/protocol.cjs");
const readline = require("node:readline");
const { createHash } = require("node:crypto");
const { connect } = require("../../../apps/daemon/src/client.cjs");
const { connectDesktopRuntime } = require("../../../apps/daemon/src/runtime-client.cjs");
const { ProjectStates } = require("../../../packages/core/src/project-states.cjs");
const { readProjectState, compactProjectState } = require("../../../packages/core/src/project-store.cjs");
const { withDetails } = require("../../../packages/core/src/project-content.cjs");
const { chatPage, chatSearch } = require("../../../packages/core/src/chat-pages.cjs");
const { wholeState, unloadedChats } = require("../../../packages/core/src/message-store.cjs");
const oracleRoot = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "milagre-runtime-states-oracle-"));
const child = spawn(process.argv[2], [], { stdio: ["pipe", "pipe", "pipe"] });
const exit = once(child, "exit");
const lines = readline.createInterface({ input: child.stdout });
let stderr = "";
child.stderr.on("data", (data) => {
  stderr += data;
});
let stage = "startup",
  metadata,
  client,
  runtime;
const states = new ProjectStates({
  read: readProjectState,
  compact: compactProjectState, // Match production runtime, including summaries on first read.
  save: async () => {
    throw new Error("The oracle never saves");
  },
  messages: { directory: (key) => key, now: Date.now },
});
const deadline = setTimeout(() => {
  child.kill("SIGKILL");
  console.error(`Owned runtime deadline exceeded at ${stage}`);
  process.exitCode = 1;
}, 30000);
const copies = new Map();
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const normalize = (value) => JSON.parse(JSON.stringify(value));
async function raw(socketPath) {
  const socket = net.createConnection(socketPath);
  await once(socket, "connect");
  const messages = [];
  let wake;
  const protocol = wire(socket, {
    onMessage: (message) => {
      messages.push(message);
      wake?.();
    },
    onInvalid: (error) => {
      throw error;
    },
  });
  const next = async () => {
    while (!messages.length)
      await new Promise((resolve) => {
        wake = resolve;
      });
    wake = null;
    return messages.shift();
  };
  return {
    socket,
    next,
    call: async (id, method, args = [], pages = false) => {
      protocol.send({ v: 1, id, method, args, pages });
      return next();
    },
  };
}
async function unicodeWire(socketPath, project) {
  const connection = await raw(socketPath);
  try {
    for (const id of ["\ud83d", "\ude00", "\ud83d\ude00", "\u{10fffe}", "\u{f003d}", "\u{10fffe}\u{f003d}", "\ud83d".repeat(128), "\u{10fffe}".repeat(64)]) {
      assert.deepEqual(await connection.call(id, "designs:enabled:read"), { v: 1, id, result: { enabled: true } }, "request ID returns losslessly");
      const failed = await connection.call(id, "not-a-method");
      assert.equal(failed.id, id, "error envelope ID returns losslessly");
      assert.equal(failed.error.code, "COMMAND_FAILED");
    }
    for (const id of ["\ud83d".repeat(129), "\u{10fffe}".repeat(65)]) {
      const failed = await connection.call(id, "designs:enabled:read");
      assert.equal(failed.id, null);
      assert.equal(failed.error.code, "INVALID_REQUEST");
    }
    const id = "page-\ud83d-\u{10fffe}\u{f003d}";
    const capture = await connection.call(id, "project:read", [project], true);
    assert.equal(capture.id, id);
    assert.ok(capture.pages.pageCount > 1);
    const fragments = [];
    for (let n = 0; n < capture.pages.pageCount; n++) {
      const result = await connection.call(id, "daemon:result-page", [capture.pages.pageId, n]);
      assert.equal(result.id, id);
      fragments.push(result.result);
    }
    const restored = JSON.parse(fragments.join(""));
    assert.equal(restored.state.sessions[1].title, "half \ud83d");
    assert.ok(JSON.stringify(restored).includes("real \u{10fffe}"));
  } finally {
    connection.socket.destroy();
  }
  for (const frame of [
    "[".repeat(129) + "0" + "]".repeat(129) + "\n",
    "x".repeat(4097) + "\n",
    '{"v":1,"id":"bad","method":"designs:enabled:read","args":["\\uNOPE"]}\n',
  ]) {
    const invalid = await raw(socketPath);
    try {
      invalid.socket.write(frame);
      const reply = await invalid.next();
      assert.equal(reply.id, null);
      assert.equal(reply.error.code, frame.startsWith("x") ? "FRAME_TOO_LARGE" : "INVALID_REQUEST");
    } finally {
      invalid.socket.destroy();
    }
  }
}
async function run() {
  const [line] = await once(lines, "line");
  metadata = JSON.parse(line);
  assert.equal(metadata.ownedCopies, true);
  assert.equal(metadata.projectReadCommandsOnly, true);
  assert.equal(path.dirname(metadata.profile), fs.realpathSync("/tmp"));
  assert.ok(fs.existsSync(path.join(metadata.profile, "MILAGRE-ISOLATED-COPY")));
  for (const name of ["alpha", "legacy", "surrogates", "large"]) {
    const source = path.join(metadata.profile, ".projects", name);
    const oracle = path.join(oracleRoot, name);
    fs.cpSync(source, oracle, { recursive: true });
    copies.set(name, { source, oracle });
  }
  client = await connect({ dataDir: metadata.profile, timeoutMs: 5000 });
  runtime = await connectDesktopRuntime({ connect: () => connect({ dataDir: metadata.profile, timeoutMs: 5000 }) });
  const status = await client.call("daemon:status");
  assert.ok(status.methods.includes("chat:search"));
  assert.ok(status.methods.includes("chat:all-messages"));
  assert.ok(!status.capabilities.includes("state-patches-v1"));
  assert.ok(!status.capabilities.includes("desktop-v1"));
  await assert.rejects(runtime.openProject(oracleRoot), { code: "ISOLATED_SCOPE_ONLY" });
  let inboxError;
  const scopes = [];
  const { inboxSnapshot } = await import("../../../packages/shared/src/attention.mjs");
  let observedLazyChats = 0;
  // Compare valid inboxes first, then admit alpha and require whole-inbox refusal.
  for (const name of ["legacy", "surrogates", "large", "alpha"]) {
    const { source, oracle } = copies.get(name);
    stage = `${name} owned state and lazy message reads`;
    const open = await runtime.openProject(source);
    const current = await states.get(oracle);
    const whole = wholeState(current);
    if (name === "alpha") {
      assert.equal(whole.sessions[1].summary.count, 7, "production compaction repairs the sparse seed summary");
      assert.equal(whole.sessions[1].summary.titleLine, "Fix the needle in the parser");
    }
    assert.deepEqual(open, normalize({ path: source, name, git: false, state: whole }));
    const lock = path.join(source, ".milagre/runtime.lock/owner.json");
    assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, child.pid, "Rust owns only this copied Project");
    observedLazyChats += unloadedChats(current).size;
    const all = await runtime.invoke("chat:all-messages", [source, { withState: true }]);
    assert.deepEqual(all, normalize(await states.allMessages(oracle, { withState: true })));
    if (name === "alpha")
      assert.ok(all.state.messages.length < all.messages.length, "metadata leaves old Chats unloaded while whole reads still include their rows");
    assert.deepEqual(
      await runtime.invoke("chat:all-messages", [source, { marks: true, withState: true }]),
      normalize(await states.messageMarks(oracle, { withState: true })),
    );
    for (const query of ["needle", "question", "legacy", "🦀", "\ud83d", "\ude00", "\u{10fffe}", "\u{10fffe}\u{f003d}", "no-such-result"]) {
      const state = await states.get(oracle);
      const active = Object.values(state.sessions)
        .filter((chat) => !chat.archived)
        .map((chat) => chat.id);
      const messages = await states.searchableMessages(oracle, active);
      assert.deepEqual(await runtime.invoke("chat:search", [source, query, { limit: 6 }]), normalize(chatSearch(state, query, { limit: 6 }, messages)));
    }
    for (const id of [1, 2, 902]) {
      const message = await states.findMessage(oracle, "id", id);
      if (message) assert.deepEqual(await runtime.invoke("chat:message", [source, id]), normalize(await withDetails(oracle, message)));
      else await assert.rejects(runtime.invoke("chat:message", [source, id]), { message: "That message is no longer in this Project." });
    }
    for (const chat of Object.values(whole.sessions)) {
      for (const agent of chat.subagents ?? []) {
        assert.deepEqual(await runtime.invoke("chat:subagent", [source, chat.id, agent.id]), normalize(agent));
      }
      const options = { turns: 1, limit: 3 };
      const loaded = await states.load(oracle, [chat.id]);
      assert.deepEqual(await runtime.invoke("chat:messages", [source, chat.id, options]), normalize(chatPage(loaded.messages, chat.id, options)));
    }
    for (const identity of [
      "cm-1",
      "queued-1",
      "legacy-queued",
      "cm-\ud83d-lone",
      "queued-\ude00",
      "cm-real-10fffe\u{10fffe}",
      "cm-\u{10fffe}\u{f003d}-lone",
    ]) {
      const message = await states.findMessage(oracle, "clientMessageId", identity);
      const pending = Object.values((await states.get(oracle)).sessions).find((chat) => chat.queued?.some((item) => item.clientMessageId === identity));
      assert.deepEqual(
        await runtime.invoke("chat:send-status", [source, identity]),
        message ? { sessionId: message.session_id } : pending ? { sessionId: pending.id } : null,
      );
    }
    const reread = await runtime.invoke("state:read", [source]);
    assert.deepEqual(reread.state, normalize(wholeState(await states.get(oracle))));
    assert.equal(reread.version, 1);
    assert.equal((await runtime.invoke("state:read", [source])).version, 1);
    if (name === "alpha") {
      // Production summaries expose unread Chat 7's malformed object body. Node refuses the whole inbox.
      await assert.rejects(states.inboxState(oracle), (error) => {
        assert.equal(error.name, "TypeError");
        assert.equal(error.message, "body?.slice is not a function");
        inboxError = error.message;
        return true;
      });
    } else {
      scopes.push({ path: source, name, state: await states.inboxState(oracle) });
      assert.deepEqual(await runtime.invoke("chat:inbox"), normalize(inboxSnapshot(scopes)));
    }
  }
  assert.ok(observedLazyChats > 0);
  assert.equal(inboxError, "body?.slice is not a function");
  await assert.rejects(runtime.invoke("chat:inbox"), { code: "COMMAND_FAILED", message: inboxError });
  const inboxWire = await raw(metadata.socket);
  try {
    // Exact wire shape excludes a partial result or paged capture from valid scopes.
    assert.deepEqual(await inboxWire.call("inbox-refusal", "chat:inbox", [], true), {
      v: 1,
      id: "inbox-refusal",
      error: { code: "COMMAND_FAILED", message: inboxError },
    });
  } finally {
    inboxWire.socket.destroy();
  }
  stage = "owned snapshots and explicit mutation refusals";
  const snapshot = await client.call("daemon:snapshot", [{ paged: true }]);
  assert.ok(snapshot.pageCount > 100);
  const pages = [];
  for (let index = 0; index < snapshot.pageCount; index++) pages.push(await client.call("daemon:snapshot-page", [snapshot.snapshotId, index]));
  const restored = JSON.parse(pages.join(""));
  assert.equal(restored.projects.length, 4);
  assert.equal(restored.projects.find((project) => project.name === "surrogates").state.sessions[1].title, "half \ud83d");
  for (const { source } of copies.values()) {
    const file = path.join(source, ".milagre/coordination.json");
    const before = digest(file);
    await assert.rejects(runtime.invoke("chat:send", [source, { body: "never sent", clientMessageId: "never-sent" }]), {
      code: "UNSUPPORTED_MUTATION",
      message: "The isolated Rust read runtime does not execute mutations or start services",
    });
    assert.equal(digest(file), before);
    assert.equal(await runtime.invoke("chat:send-status", [source, "never-sent"]), null);
  }
  stage = "lossless request IDs, pages and frame limits";
  await unicodeWire(metadata.socket, copies.get("surrogates").source);
  stage = "owned terminal resolver";
  const chatId = `${copies.get("alpha").source}#1`;
  const terminal = await runtime.invoke("terminal:open", [{ chatId }]);
  assert.equal(terminal.cwd, copies.get("alpha").source);
  await runtime.invoke("terminal:input", [{ terminalId: terminal.id, data: "printf '\\nOWNED_%s\\n' 'PTY_OK'\n" }]);
  let output = "",
    after = 0;
  while (!output.includes("OWNED_PTY_OK\r\n")) {
    const read = await runtime.invoke("terminal:read", [{ terminalId: terminal.id, after }]);
    output += read.data;
    after = read.offset;
  }
  const nativeText = "lone:\ud83d marker:\u{10fffe}\u{f003d}";
  await runtime.invoke("terminal:input", [{ terminalId: terminal.id, data: `printf '\\nNATIVE_%s\\n' '${nativeText}'\n` }]);
  while (!output.includes(`NATIVE_${nativeText.toWellFormed()}\r\n`)) {
    const read = await runtime.invoke("terminal:read", [{ terminalId: terminal.id, after }]);
    output += read.data;
    after = read.offset;
  }
  await assert.rejects(runtime.invoke("terminal:input", [{ terminalId: "bad\ud83d", data: "never sent" }]), { code: "UNSUPPORTED_UTF16_IDENTITY" });
  await runtime.invoke("terminal:close", [{ terminalId: terminal.id }]);
  console.log(
    `Owned Rust runtime conformance passed: 4 isolated Projects, ${observedLazyChats} lazy Chats, Node ProjectStates parity, search, subagents, inbox, pages, real PTY`,
  );
}
run()
  .catch((error) => {
    console.error(`At ${stage}:`, error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await states.close();
    await runtime?.close();
    client?.close();
    child.stdin.end();
    const [code] = await exit;
    if (code !== 0) {
      console.error(stderr);
      process.exitCode = 1;
    }
    clearTimeout(deadline);
    lines.close();
    if (metadata && (fs.existsSync(metadata.profile) || fs.existsSync(metadata.socket))) {
      console.error("Owned runtime failed to remove its temporary profile/socket");
      process.exitCode = 1;
    }
    fs.rmSync(oracleRoot, { recursive: true, force: true });
  });
