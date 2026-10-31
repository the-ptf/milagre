const assert = require("node:assert/strict");
const test = require("node:test");
const { Delegations } = require("./delegations.cjs");
const { thisComputer } = require("@milagre/shared/host-computer");

// Delegations between computers (spec 2026-10-23), with every runtime part faked: `studio` is the paired computer that
// runs the turn (its Delegations take `hosted` records), `desk` the Mac whose Chat delegates. Calls between them go
// straight across, as computers.cjs carries them; `online` and `enabled` are the switches a test flips, and `lose(method)`
// loses a call's answer after studio ran it, when it returns true.
const STUDIO = "0b6f3c2e-1d4a-4c8e-9f00-2a1b3c4d5e6f";

function memoryStore(data = { delegations: [], negotiations: [], grants: [] }) {
  let saved = structuredClone(data);
  return {
    load: async () => structuredClone(saved),
    save: async (next) => {
      saved = structuredClone(next);
    },
    saved: () => saved,
  };
}

function pair({ deskData, studioData, mode = "full", studioMode = "full", decision = "allow" } = {}) {
  const net = { online: true, enabled: true, calls: [], lose: () => false };
  const deskNotes = [];
  const studioNotes = [];
  const delivered = [];
  const approvals = [];
  const reports = [];
  let turn = 0;
  const studioStore = memoryStore(studioData);
  const studio = new Delegations({
    store: studioStore,
    ports: {
      target: async () => null,
      hostTarget: async (worktree) => (worktree === "/web" ? { projectPath: "/web", projectName: "web", branch: "main" } : null),
      chat: async (key) => (key.startsWith("/web#") ? { label: `web / main / Chat ${key.split("#")[1]}`, worktreePath: "/web", archived: false } : null),
      openChat: async () => "/web#9",
      status: () => "idle",
      deliver: async (key, item) => {
        delivered.push({ key, item });
        return { started: Promise.resolve({ turnId: `t${++turn}`, steered: false }) };
      },
      reply: async () => "Added GET /health.",
      note: async (key, note) => studioNotes.push({ key, ...note }),
      permissionMode: () => studioMode,
      deliveryMode: () => studioMode,
      approve: async () => "allow",
      changed: () => {},
      remoteReport: (report) => {
        reports.push(report);
        if (net.online) void desk.remoteFinished(STUDIO, report);
      },
    },
  });
  const across = async (method, args) => {
    net.calls.push(method);
    if (!net.online) throw new Error("studio is offline.");
    const answer = await run(method, args);
    if (net.lose(method)) throw new Error("Daemon connection closed");
    return answer;
  };
  const run = async (method, [request]) => {
    if (method === "delegation:prepare") {
      const { label, raisedMode } = await studio.prepareHosted(request);
      return { label, raisedMode };
    }
    if (method === "delegation:receive") return studio.receiveHosted(request);
    if (method === "delegation:reports") return studio.hostedReports(request);
    if (method === "delegation:collected") return studio.collectedHosted(request);
    throw new Error(`Unknown command: ${method}`);
  };
  const desk = new Delegations({
    store: memoryStore(deskData),
    ports: {
      target: async () => null,
      chat: async (key) => ({ label: `api / main / Chat ${key.split("#")[1]}`, worktreePath: "/api", archived: false }),
      openChat: async () => "/api#9",
      status: () => "idle",
      deliver: async () => ({ started: Promise.resolve(null) }),
      reply: async () => "",
      note: async (key, note) => deskNotes.push({ key, ...note }),
      permissionMode: () => mode,
      deliveryMode: () => mode,
      approve: async (_key, request) => {
        approvals.push(request);
        return decision;
      },
      changed: () => {},
      remote: {
        enabled: () => net.enabled,
        list: () => [{ id: STUDIO, name: "studio", online: net.online }],
        computer: (name) => (name === "studio" || name === STUDIO ? { id: STUDIO, name: "studio", online: net.online } : null),
        invoke: (_id, method, args) => across(method, args),
        thisMac: () => "desk",
      },
    },
  });
  const finish = (key, turnId = "t1") => studio.observe(key, { type: "turn-started", turnId }).then(() => studio.observe(key, { type: "turn-completed" }));
  return { net, desk, studio, studioStore, deskNotes, studioNotes, delivered, approvals, reports, finish };
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const send = (fake, extra = {}) =>
  fake.desk.delegate("/api#1", { computer: "studio", worktree: "/web", chat: "new", message: "Add the /health endpoint", ...extra });

test("a Delegation to another computer runs in that computer's Chat, and its report comes back to the asking Chat", async () => {
  const fake = pair();
  const result = await send(fake);
  assert.match(result, /^Delegation sent to web \/ main \/ a new Chat on studio \(Chat 0b6f3c2e-[^|]+\|\/web#9\)/);
  // The turn runs on studio, in its own Chat, with the caller's mode and a prompt that names the asking computer.
  assert.equal(fake.delivered.length, 1);
  const { key, item } = fake.delivered[0];
  assert.equal(key, "/web#9");
  assert.equal(item.mode, "full");
  assert.equal(item.context.from, null);
  assert.equal(item.context.fromLabel, "api / main / Chat 1 on desk");
  assert.match(item.prompt, /^Delegation from api \/ main \/ Chat 1 on desk, another Chat, on the computer desk \(not the user\):/);
  // This Mac keeps the record, with the other computer's Chat as its qualified key, for the window's mirror.
  const [open] = fake.desk.snapshot().delegations;
  assert.equal(open.to_chat, `${STUDIO}|/web#9`);
  assert.deepEqual(open.computer, { id: STUDIO, name: "studio" });
  assert.equal(open.status, "running");
  assert.equal(fake.studio.snapshot().delegations[0].from_chat, null);

  await fake.finish("/web#9");
  await waitFor(() => fake.deskNotes.length === 1);
  const [note] = fake.deskNotes;
  assert.equal(note.key, "/api#1");
  assert.equal(note.body, "Added GET /health.");
  assert.deepEqual(note.context, {
    kind: "delegation-report",
    delegationId: open.id,
    from: `${STUDIO}|/web#9`,
    fromLabel: "web / main / a new Chat on studio",
    status: "done",
  });
  assert.equal(fake.studioNotes.length, 0, "studio has no asking Chat to tell");
  assert.equal(fake.desk.snapshot().delegations.length, 0);
  // The next turn of the asking Chat gets the report, and studio no longer keeps it once collected.
  const reports = await fake.desk.reportsForTurn("/api#1");
  assert.match(reports.text, /Delegation report from web \/ main \/ a new Chat on studio/);
  await waitFor(() => fake.studioStore.saved().delegations[0].collected === true);
  assert.equal(fake.studioStore.saved().delegations[0].report, undefined);
});

test("an offline computer fails the call at once and nothing is recorded or queued", async () => {
  const fake = pair();
  fake.net.online = false;
  await assert.rejects(send(fake), /^Error: studio is offline, so nothing was sent\. Try again once it is back\.$/);
  assert.deepEqual(fake.net.calls, [], "nothing went out");
  assert.equal(fake.desk.snapshot().delegations.length, 0);
  assert.equal(fake.delivered.length, 0);
});

test("with the Experimental switch off, or for a Negotiation, nothing goes to another computer", async () => {
  const fake = pair();
  fake.net.enabled = false;
  await assert.rejects(send(fake), /Settings > Experimental/);
  fake.net.enabled = true;
  await assert.rejects(send(fake, { negotiation: true }), /Negotiations stay on one computer/);
  await assert.rejects(send(fake, { computer: "laptop" }), /No paired computer is called laptop/);
  assert.deepEqual(fake.net.calls, []);
});

test("a ref of another computer names it without `computer`, and a ref of a third computer is refused", async () => {
  const fake = pair();
  await fake.desk.delegate("/api#1", { worktree: `${STUDIO}|/web`, chat: `${STUDIO}|/web#4`, message: "Again" });
  assert.equal(fake.delivered[0].key, "/web#4", "studio got its own bare key");
  const other = "11111111-2222-4333-8444-555555555555";
  await assert.rejects(
    fake.desk.delegate("/api#1", { computer: "studio", worktree: "/web", chat: `${other}|/web#4`, message: "Elsewhere" }),
    /another computer than studio/,
  );
});

test("studio refuses a Worktree it doesn't have, and the reason reaches the asking agent", async () => {
  const fake = pair();
  await assert.rejects(send(fake, { worktree: "/elsewhere" }), /^Error: studio can't take this Delegation: That Worktree isn't an active Worktree/);
  assert.equal(fake.desk.snapshot().delegations.length, 0);
});

test("in Ask mode a Delegation follows the receiving Chat's mode: no card unless it would run in a higher mode", async () => {
  const fake = pair({ mode: "ask", decision: "deny", studioMode: "ask" });
  await send(fake);
  assert.equal(fake.approvals.length, 0, "the receiving Chat runs at the same mode, so no card");
  assert.equal(fake.delivered.length, 1);

  const raised = pair({ mode: "ask", studioMode: "full", decision: "deny" });
  await assert.rejects(send(raised, { chat: "/web#4" }), /denied/);
  assert.match(raised.approvals[0].title, /in Full permission\?$/);
  assert.equal(raised.delivered.length, 0, "nothing ran on studio");
});

test("a report sent while this Mac was away is collected when the computer is back, once", async () => {
  const fake = pair();
  await send(fake);
  fake.net.online = false;
  await fake.finish("/web#9");
  await waitFor(() => fake.reports.length === 1);
  assert.equal(fake.deskNotes.length, 0, "the event was lost");
  fake.net.online = true;
  await fake.desk.catchUp(STUDIO);
  await fake.desk.catchUp(STUDIO);
  assert.equal(fake.deskNotes.length, 1);
  assert.equal(fake.deskNotes[0].context.status, "done");
  // A late copy of the event settles nothing more.
  assert.equal(await fake.desk.remoteFinished(STUDIO, fake.reports[0]), false);
});

test("Stop in the asking Chat leaves its Delegation to another computer running, as Stop leaves a local one", async () => {
  const fake = pair();
  await send(fake);
  await fake.desk.stop({ chatKey: "/api#1" });
  assert.equal(fake.desk.snapshot().delegations[0].status, "running");
  assert.equal(fake.deskNotes.length, 0);
  await fake.finish("/web#9");
  await waitFor(() => fake.deskNotes.length === 1);
  assert.equal(fake.deskNotes[0].context.status, "done");
});

test("removing the computer cancels its open Delegations here, with a notice in the asking Chat", async () => {
  const fake = pair();
  await send(fake);
  await fake.desk.computerRemoved("someone-else");
  assert.equal(fake.desk.snapshot().delegations.length, 1, "another computer's removal settles nothing");
  await fake.desk.computerRemoved(STUDIO);
  assert.equal(fake.desk.snapshot().delegations.length, 0);
  assert.equal(fake.deskNotes.length, 1);
  const [note] = fake.deskNotes;
  assert.equal(note.key, "/api#1");
  assert.equal(note.context.status, "cancelled");
  assert.match(note.body, new RegExp(`^studio was removed from ${thisComputer}'s computers, so this Delegation was cancelled here`));
  assert.match((await fake.desk.reportsForTurn("/api#1")).text, /studio was removed/);
  // A report that still arrives settles nothing more.
  await fake.finish("/web#9");
  await waitFor(() => fake.reports.length === 1);
  assert.equal(fake.deskNotes.length, 1);
});

test("a lost answer to the send is checked with studio: the Delegation it took keeps running here", async () => {
  const fake = pair();
  fake.net.lose = (method) => method === "delegation:receive";
  const result = await send(fake);
  assert.match(result, /^Delegation sent to web \/ main \/ a new Chat on studio \(Chat 0b6f3c2e-[^|]+\|\/web#9\)/);
  assert.equal(fake.delivered.length, 1, "studio ran it once");
  const [open] = fake.desk.snapshot().delegations;
  assert.equal(open.status, "running");
  assert.equal(open.to_chat, `${STUDIO}|/web#9`);
  await fake.finish("/web#9");
  await waitFor(() => fake.deskNotes.length === 1);
  assert.equal(fake.deskNotes[0].context.status, "done");
});

test("a send studio refused still fails at once, once studio says it has no record of it", async () => {
  const fake = pair();
  await assert.rejects(send(fake, { message: " " }), /^Error: Couldn't send the Delegation to studio: A Delegation needs an id and a message\.$/);
  assert.deepEqual(fake.net.calls, ["delegation:prepare", "delegation:receive", "delegation:reports"]);
  assert.equal(fake.desk.snapshot().delegations.length, 0);
  assert.equal(fake.delivered.length, 0);
});

test("with no answer at all, the Delegation stays open until studio is back, then follows what studio did", async () => {
  // Studio took it, then the link dropped before either answer came back.
  const fake = pair();
  fake.net.lose = (method) => {
    if (method !== "delegation:receive") return false;
    fake.net.online = false;
    return true;
  };
  const result = await send(fake);
  assert.match(
    result,
    /^studio didn't confirm it got this Delegation \(Daemon connection closed\), so it may be running there or not at all\. Don't send it again/,
  );
  const [open] = fake.desk.snapshot().delegations;
  assert.equal(open.status, "queued");
  assert.equal(open.to_chat, null);
  assert.equal(fake.deskNotes.length, 0, "no failure report");
  fake.net.lose = () => false;
  fake.net.online = true;
  await fake.desk.catchUp(STUDIO);
  const [running] = fake.desk.snapshot().delegations;
  assert.equal(running.status, "running");
  assert.equal(running.to_chat, `${STUDIO}|/web#9`, "the card can mirror its turn now");
  await fake.finish("/web#9");
  await waitFor(() => fake.deskNotes.length === 1);
  assert.equal(fake.deskNotes[0].body, "Added GET /health.");
});

test("a restart keeps a Delegation whose send was never confirmed", async () => {
  const unconfirmed = {
    id: "d-lost",
    link_id: null,
    from_chat: "/api#1",
    from_label: "api",
    to_chat: null,
    to_label: "web on studio",
    message: "Add it",
    status: "queued",
    unconfirmed: true,
    remote: { computerId: STUDIO, computerName: "studio" },
  };
  const fake = pair({ deskData: { delegations: [unconfirmed], negotiations: [], grants: [] } });
  await fake.desk.ready;
  assert.equal(fake.desk.snapshot().delegations.length, 1);
  await fake.desk.catchUp(STUDIO);
  assert.equal(fake.deskNotes[0].body, "studio never got this Delegation, so nothing ran there.");
});

test("the same id twice starts one turn on studio", async () => {
  const fake = pair();
  const request = { id: "d-1", worktree: "/web", chat: "new", message: "Once", mode: "ask", from: { label: "api", computer: "desk" } };
  const first = await fake.studio.receiveHosted(request);
  const again = await fake.studio.receiveHosted(request);
  assert.deepEqual(again, first);
  assert.equal(fake.delivered.length, 1);
});

test("a restart keeps this Mac's open Delegations to other computers, and studio keeps an interrupted one to collect", async () => {
  const running = {
    id: "d-remote",
    link_id: null,
    from_chat: "/api#1",
    from_label: "api",
    to_chat: `${STUDIO}|/web#9`,
    to_label: "web on studio",
    message: "Add it",
    status: "running",
    remote: { computerId: STUDIO, computerName: "studio" },
  };
  const hosted = {
    id: "h1",
    hosted: true,
    remote_id: "d-remote",
    link_id: null,
    from_chat: null,
    from_label: "api on desk",
    from_computer: "desk",
    to_chat: "/web#9",
    to_label: "web",
    message: "Add it",
    status: "running",
  };
  const fake = pair({
    deskData: { delegations: [running], negotiations: [], grants: [] },
    studioData: { delegations: [hosted], negotiations: [], grants: [] },
  });
  await fake.desk.ready;
  await fake.studio.ready;
  assert.equal(fake.desk.snapshot().delegations.length, 1, "still running on studio");
  await waitFor(() => fake.deskNotes.length === 1);
  assert.equal(fake.deskNotes[0].context.status, "cancelled", "studio's restart cancelled it and told the asking Mac");
  assert.match(fake.deskNotes[0].body, /Milagre restarted before web finished/);
  assert.equal(fake.studioNotes.length, 0);
});

// Two whole runtimes, one per computer, wired as the daemon wires them (server.cjs): this Mac's runtime calls the other's
// commands, and the other's events reach this Mac's `remoteComputers` listeners.
test("two runtimes: linked_overview lists studio's Worktrees, and a Delegation there reports back", async (t) => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const { createRuntime } = require("./runtime.cjs");
  const { runTool } = require("./linked-tools.cjs");
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-remote-")));
  const runtimes = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const folders = {};
  for (const name of ["api", "web"]) {
    folders[name] = path.join(dir, name);
    await fs.mkdir(folders[name]);
    execFileSync("git", ["init", "-b", "main", folders[name]], { stdio: "ignore" });
    execFileSync("git", ["-C", folders[name], "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Initial"], {
      stdio: "ignore",
    });
  }
  const results = [];
  const prompts = [];
  // A provider that runs each turn's script: the planning Chat calls the linked tools, studio's Chat replies.
  const createSession = (_provider, options) => {
    const emit = options.emit;
    const session = {
      turnActive: false,
      closed: false,
      nativeId: null,
      pid: null,
      permissions: { mode: "full", add: (_request, answer) => answer("allow") },
      async startTurn(request) {
        prompts.push(request.prompt);
        this.turnActive = true;
        emit({ type: "turn-started", turnId: `turn-${prompts.length}` });
        setImmediate(async () => {
          if (options.cwd === folders.api) {
            const tool = (name) => options.linked.tools.find((item) => item.name === name);
            results.push(await runTool(tool("linked_overview"), {}));
            results.push(await runTool(tool("delegate"), { computer: "studio", worktree: folders.web, chat: "new", message: "Add the /health endpoint" }));
          }
          emit({ type: "text-delta", messageId: "m", text: options.cwd === folders.web ? "Added GET /health." : "Asked studio." });
          this.turnActive = false;
          emit({ type: "turn-completed" });
        });
        return { turnId: `turn-${prompts.length}`, steered: false };
      },
      respondToPermission: () => false,
      answerQuestion: () => false,
      setPermissionMode() {},
      async interrupt() {},
      async close() {
        this.closed = true;
      },
    };
    return session;
  };
  const listeners = new Set();
  const base = (name, extra) => ({
    dataDir: path.join(dir, `${name}-profile`),
    chatsHome: path.join(dir, "chats"),
    cwd: folders.api,
    version: "1.0.0",
    environmentReady: Promise.resolve(),
    registryRoots: [],
    titleModels: {},
    agentCli: async () => ({ command: "/fake/agent" }),
    agentCliStatus: async () => ({ claude: { state: "ready" }, codex: { state: "ready" } }),
    agentModels: async () => ({ claude: [{ id: "claude-test", efforts: [] }], codex: [] }),
    createSession,
    ...extra,
  });
  const studio = createRuntime(
    base("studio", {
      emit: (channel, payload) => {
        for (const listener of listeners) listener(STUDIO, channel, payload);
      },
    }),
  );
  runtimes.push(studio);
  const desk = createRuntime(
    base("desk", {
      remoteComputers: {
        list: () => [{ id: STUDIO, name: "studio", online: true }],
        invoke: (_id, method, args) => studio.invoke(method, args),
        thisMac: () => "desk",
        onEvent: (listener) => listeners.add(listener),
        onOnline: () => () => {},
      },
    }),
  );
  runtimes.push(desk);
  await studio.openProject(folders.web);
  const opened = await desk.openProject(folders.api);
  await desk.invoke("linked:remote-enabled:save", [true]);
  const session = Object.values(opened.state.sessions)[0];
  await desk.invoke("chat:send", [
    {
      projectPath: folders.api,
      sessionId: session.id,
      worktreeId: session.worktree_id,
      body: "Plan the health check",
      prompt: "Plan the health check",
      images: [],
      files: [],
      provider: "claude",
      model: "claude-test",
      permissionMode: "full",
    },
  ]);
  const report = await waitFor(async () =>
    (await desk.invoke("project:snapshot", [folders.api])).state.messages.find((message) => message.context?.kind === "delegation-report"),
  );
  assert.equal(results[0].isError, false, results[0].text);
  assert.match(results[0].text, /Other computers[^\n]*\n- studio:\n {2}- web \/ main: worktree .*\/web$/m);
  assert.equal(results[1].isError, false, results[1].text);
  assert.equal(report.body, "Added GET /health.");
  assert.equal(report.context.status, "done");
  assert.match(report.context.from, new RegExp(`^${STUDIO}\\|${folders.web}#\\d+$`));
  const received = (await studio.invoke("project:snapshot", [folders.web])).state.messages.find((message) => message.context?.kind === "delegation");
  assert.equal(received.body, "Add the /health endpoint");
  assert.equal(received.context.from, null);
  assert.match(received.context.fromLabel, /^api \/ main \/ .* on desk$/);
  assert.equal((await desk.invoke("linked:snapshot")).delegations.length, 0);
});
