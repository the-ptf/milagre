const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startDaemon } = require("./server.cjs");
const { connect } = require("./client.cjs");
const { startTestMac, until } = require("./relay-test-kit.cjs");
const { runTool } = require("@milagre/core/linked-tools");
const { PendingPermissions } = require("@milagre/core/agents/permissions");
const { thisComputer } = require("@milagre/shared/host-computer");

const commit = (folder) =>
  execFileSync("git", ["-C", folder, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Initial"], {
    stdio: "ignore",
  });

// A provider whose turn runs `script(options, permissions, stopped)` and replies what it returns. Its approval cards are the
// real PendingPermissions, in the mode the turn starts in; `allowMilagre` answers Milagre's own cards (the delegate card) at
// once. Stop (`interrupt`) cancels a running turn as a provider does, and resolves `stopped` for a script that waits on it.
const fakeSessions =
  (script, { allowMilagre = false } = {}) =>
  (_provider, options) => {
    const permissions = new PendingPermissions(options.emit);
    if (allowMilagre) {
      const add = permissions.add.bind(permissions);
      permissions.add = (request, answer, extra) => (extra?.fromMilagre ? answer("allow") : add(request, answer, extra));
    }
    const stop = Promise.withResolvers();
    return {
      turnActive: false,
      closed: false,
      nativeId: null,
      pid: null,
      permissions,
      async startTurn(request) {
        if (request.permissionMode) permissions.setMode(request.permissionMode);
        this.turnActive = true;
        options.emit({ type: "turn-started", turnId: "turn-1" });
        setImmediate(async () => {
          const reply = await script(options, permissions, stop.promise);
          if (!this.turnActive) return;
          options.emit({ type: "text-delta", messageId: "m", text: reply });
          this.turnActive = false;
          options.emit({ type: "turn-completed" });
        });
        return { turnId: "turn-1", steered: false };
      },
      respondToPermission: (requestId, decision) => permissions.resolve(requestId, decision),
      answerQuestion: () => false,
      setPermissionMode: (mode) => permissions.setMode(mode),
      async interrupt() {
        if (!this.turnActive) return;
        this.turnActive = false;
        options.emit({ type: "turn-cancelled" });
        stop.resolve();
      },
      async close() {
        this.closed = true;
      },
    };
  };

const agents = {
  environmentReady: Promise.resolve(),
  titleModels: {},
  agentCli: async () => ({ command: "/fake/agent" }),
  agentCliStatus: async () => ({ claude: { state: "ready" }, codex: { state: "ready" } }),
  agentModels: async () => ({ claude: [{ id: "claude-test", efforts: [] }], codex: [] }),
};

/**
 * Studio, the paired computer whose daemon runs the turn in its own Chat (`studioScript`), and this Mac, a headless
 * daemon paired to it over a local relay, whose Chat's agent calls linked_overview and then delegate to Studio.
 */
async function pairedMacs(t, { studioScript }) {
  const studio = await startTestMac(t, { runtime: { ...agents, createSession: fakeSessions(studioScript) } });
  commit(studio.project);
  await studio.client.call("project:open", [studio.project]);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-remote-delegation-")));
  const dataDir = path.join(root, "profile");
  const api = path.join(root, "api");
  await fs.mkdir(dataDir, { mode: 0o700 });
  await fs.mkdir(api);
  execFileSync("git", ["init", "-b", "main", api], { stdio: "ignore" });
  commit(api);
  const results = [];
  const daemon = await startDaemon({
    dataDir,
    version: "test",
    computerOptions: { allowLocalRelay: true, reconnectMs: 50, checkEveryMs: 60000, networkMs: 60000 },
    runtimeOptions: {
      cwd: api,
      ...agents,
      createSession: fakeSessions(
        async (options) => {
          const tool = (name) => options.linked.tools.find((item) => item.name === name);
          results.push(await runTool(tool("linked_overview"), {}));
          results.push(await runTool(tool("delegate"), { computer: "Studio", worktree: studio.project, chat: "new", message: "Add the /health endpoint" }));
          return "Asked Studio.";
        },
        { allowMilagre: true },
      ),
    },
  });
  const owner = await connect({ dataDir });
  const events = [];
  owner.on("event", (event) => events.push(event));
  t.after(async () => {
    owner.close();
    await daemon.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await owner.call("computers:setup-key", [{ file: path.join(root, "private-key") }]);
  await owner.call("computers:set-enabled", [true]);
  const link = (await studio.client.call("phone:status")).pairingLink;
  const added = await owner.call("computers:add", [link, { name: "Studio" }]);
  assert.equal(added.ok, true, added.message);
  await until(async () => (await owner.call("computers:list")).computers[0]?.state === "online", "Studio online");
  // Settings > Experimental: off until turned on.
  assert.equal((await owner.call("linked:remote-enabled:read")).enabled, false);
  await owner.call("linked:remote-enabled:save", [true]);
  const opened = await owner.call("project:open", [api]);
  const session = Object.values(opened.state.sessions)[0];
  const send = (permissionMode) =>
    owner.call("chat:send", [
      {
        projectPath: api,
        sessionId: session.id,
        worktreeId: session.worktree_id,
        body: "Plan the health check",
        prompt: "Plan the health check",
        images: [],
        files: [],
        provider: "claude",
        model: "claude-test",
        permissionMode,
      },
    ]);
  const report = () =>
    until(
      async () => (await owner.call("chat:messages", [api, session.id])).messages?.find((message) => message.context?.kind === "delegation-report"),
      "the Delegation report from Studio",
    );
  return { studio, owner, events, results, send, report, computerId: added.computer.id };
}

test("a Chat delegates to a paired computer over the relay, and the report comes back through it", { timeout: 60000 }, async (t) => {
  const macs = await pairedMacs(t, { studioScript: async () => "Added GET /health." });
  await macs.send("full");
  const report = await macs.report();
  const [overview, sent] = macs.results;
  assert.equal(overview.isError, false, overview.text);
  assert.match(overview.text, /- Studio:\n {2}- project \/ main: worktree /);
  assert.equal(sent.isError, false, sent.text);
  assert.equal(report.body, "Added GET /health.");
  assert.equal(report.context.status, "done");
  assert.ok(report.context.from.startsWith(`${macs.computerId}|${macs.studio.project}#`), report.context.from);
  // Studio's Chat took it as a Delegation from this Mac's Chat; it has no Chat there to open.
  const [studioPath, studioId] = report.context.from.split("|")[1].split("#");
  const received = (await macs.studio.client.call("chat:messages", [studioPath, Number(studioId)])).messages.find(
    (message) => message.context?.kind === "delegation",
  );
  assert.equal(received.body, "Add the /health endpoint");
  assert.equal(received.context.from, null);
  // Studio was told the report was collected.
  await until(
    async () => JSON.parse(await fs.readFile(path.join(macs.studio.dataDir, "delegations.json"), "utf8")).delegations.every((item) => item.collected),
    "Studio drops the collected report",
  );
});

test("the card's Stop on this Mac stops the turn on Studio, and the report comes back cancelled", { timeout: 60000 }, async (t) => {
  let running = false;
  const macs = await pairedMacs(t, {
    studioScript: async (_options, _permissions, stopped) => {
      running = true;
      await stopped;
      return "Never sent.";
    },
  });
  await macs.send("full");
  const open = await until(async () => {
    const [delegation] = (await macs.owner.call("linked:snapshot")).delegations;
    return running && delegation?.to_chat ? delegation : null;
  }, "Studio's turn running");
  assert.equal(open.status, "running");
  assert.ok(open.to_chat.startsWith(`${macs.computerId}|`), open.to_chat);
  // What the card's Stop sends: agent:interrupt on that computer's bridge (computers:invoke), with the qualified key.
  await macs.owner.call("computers:invoke", [macs.computerId, "agent:interrupt", [open.to_chat]]);
  const report = await macs.report();
  assert.equal(report.context.status, "cancelled");
  assert.match(report.body, /was stopped/);
  assert.equal((await macs.owner.call("linked:snapshot")).delegations.length, 0);
});

test("removing Studio from this Mac's computers cancels its open Delegation, with a notice in the asking Chat", { timeout: 60000 }, async (t) => {
  let running = false;
  const macs = await pairedMacs(t, {
    studioScript: async (_options, _permissions, stopped) => {
      running = true;
      await stopped;
      return "Never sent.";
    },
  });
  await macs.send("full");
  await until(async () => running && (await macs.owner.call("linked:snapshot")).delegations[0]?.to_chat, "Studio's turn running");
  await macs.owner.call("computers:remove", [macs.computerId]);
  const report = await macs.report();
  assert.equal(report.context.status, "cancelled");
  assert.match(report.body, new RegExp(`^Studio was removed from ${thisComputer}'s computers, so this Delegation was cancelled here`));
  assert.equal((await macs.owner.call("linked:snapshot")).delegations.length, 0);
});

test("an approval in the delegated turn can be answered from either Mac; the first answer wins and both cards clear", { timeout: 60000 }, async (t) => {
  let decided;
  const macs = await pairedMacs(t, {
    studioScript: async (_options, permissions) => {
      decided = await new Promise((resolve) =>
        permissions.add({ requestId: "run-tests", kind: "command", tool: "Bash", title: "Run npm test?", command: "npm test", allowForChat: false }, resolve),
      );
      return `Tests ${decided === "allow" ? "ran" : "skipped"}.`;
    },
  });
  // In Ask, the Chat Studio opens runs in Ask too, so its turn stops on the card.
  await macs.send("ask");
  const remoteEvent = (type) =>
    macs.events.find(({ channel, payload }) => channel === "computers:event" && payload.channel === "agent:event" && payload.payload.event?.type === type)
      ?.payload.payload;
  const asked = await until(async () => remoteEvent("permission-request"), "the card reaching this Mac");
  assert.ok(asked.chatId.startsWith(`${macs.computerId}|`), "this Mac keeps it under Studio's qualified key");
  // Studio's own window answers first; this Mac's answer then finds nothing to answer.
  const bare = asked.chatId.split("|")[1];
  assert.equal(await macs.studio.client.call("agent:respond-permission", [{ chatId: bare, requestId: "run-tests", decision: "allow" }]), true);
  assert.equal(
    await macs.owner.call("computers:invoke", [
      macs.computerId,
      "agent:respond-permission",
      [{ chatId: asked.chatId, requestId: "run-tests", decision: "deny" }],
    ]),
    false,
  );
  const resolved = await until(async () => remoteEvent("permission-resolved"), "this Mac's card clearing");
  assert.equal(resolved.event.decision, "allow");
  const report = await macs.report();
  assert.equal(decided, "allow");
  assert.equal(report.body, "Tests ran.");
});
