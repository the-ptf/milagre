const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomBytes, randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const http = require("node:http");
const { setTimeout: delay } = require("node:timers/promises");
const { WebSocket } = require("ws");
const { startDaemon } = require("./server.cjs");
const { forPhone, runsForPhone, startMobileBridge } = require("./mobile-bridge.cjs");
const { connect } = require("./client.cjs");
const { demoRuntimeOptions } = require("./demo-agent.cjs");

test("phone projections preserve PR references without shell output", () => {
  const { forChatList } = require("./mobile-bridge.cjs");
  const project = {
    state: {
      sessions: { 1: { id: 1 } },
      messages: [
        { id: 1, session_id: 1, body: "Open a PR", role: "user" },
        {
          id: 2,
          session_id: 1,
          body: "",
          role: "assistant",
          steps: [{ kind: "shell", status: "done", detail: "$ gh pr create --fill\nhttps://github.com/example/project/pull/246" }],
        },
        { id: 3, session_id: 1, body: "Next", role: "user" },
      ],
      tasks: {},
    },
  };
  for (const copy of [forPhone(project), forChatList(project, { runs: {} }).project]) {
    assert.deepEqual(copy.pullRequestRefs, { 1: ["https://github.com/example/project/pull/246"] });
    assert.ok(copy.state.messages.every((message) => !message.steps?.some((step) => step.detail?.includes("gh pr create"))));
  }
  assert.equal(project.pullRequestRefs, undefined, "projection metadata does not change stored state");
});

async function fixture(t, { runtimeOptions = {}, bridgeOptions = {} } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-mobile-")));
  const dataDir = path.join(root, "profile");
  const project = path.join(root, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  const daemon = await startDaemon({
    dataDir,
    version: "test",
    runtimeOptions: {
      environmentReady: Promise.resolve(),
      titleModels: {},
      worktreeRoot: path.join(root, "worktrees"),
      agentCli: Object.assign(async () => ({ command: null, problem: "Test has no provider" }), { invalidate() {} }),
      ...runtimeOptions,
    },
  });
  const token = randomBytes(32).toString("hex");
  const bridge = await startMobileBridge({ dataDir, port: 0, token, ...bridgeOptions });
  t.after(async () => {
    await bridge.close();
    await daemon.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const request = (route, options = {}) => fetch(bridge.url + route, { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers } });
  const rpc = (method, args = []) =>
    request("/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ v: 1, method, args }) });
  return { dataDir, project, bridge, request, rpc, token, daemon };
}

test("inbox question and approval actions settle through the owner, and Clear removes unread outcomes", async (t) => {
  const { rpc, request, project } = await fixture(t, { runtimeOptions: demoRuntimeOptions() });
  await rpc("project:open", [project]);
  const opened = (await (await request("/snapshot?projectPath=" + encodeURIComponent(project))).json()).result;
  const worktreeId = Object.values(opened.project.state.worktrees)[0].id;
  const snapshot = async () => (await (await request("/inbox")).json()).result;
  const waitFor = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      const inbox = await snapshot();
      if (predicate(inbox)) return inbox;
      await delay(20);
    }
    throw new Error("Inbox did not settle");
  };
  for (const body of ["question", "approval"]) {
    assert.equal((await rpc("chat:send", [{ projectPath: project, worktreeId, body, provider: "codex", model: "demo", permissionMode: "ask" }])).status, 200);
  }
  const waiting = await waitFor((inbox) => inbox.items.length === 2);
  const question = waiting.items.find((item) => item.status === "question");
  const approval = waiting.items.find((item) => item.status === "approval");
  assert.ok(question.question);
  assert.ok(approval.permission);
  const answer = await rpc("agent:answer-question", [
    { chatId: question.key, requestId: question.question.requestId, answers: { next: ["Read a Chat"] }, summary: "Next step: Read a Chat" },
  ]);
  assert.equal((await answer.json()).result, true);
  const allow = await rpc("agent:respond-permission", [{ chatId: approval.key, requestId: approval.permission.requestId, decision: "allow" }]);
  assert.equal((await allow.json()).result, true);
  const finished = await waitFor((inbox) => inbox.items.length === 2 && inbox.items.every((item) => item.status === "completed"));
  assert.ok(finished.items.some((item) => item.preview.includes("answer received")));
  for (const item of finished.items) {
    await rpc("chat:patch", [item.projectPath, Number(item.key.split("#").at(-1)), { unread: false }]);
  }
  await waitFor((inbox) => !inbox.items.length && !inbox.agents.length);
});

test("Live Activity answers reach the real question handler and persist one answer", async (t) => {
  const { rpc, request, project } = await fixture(t, { runtimeOptions: demoRuntimeOptions() });
  await rpc("project:open", [project]);
  const initial = (await (await request("/snapshot?projectPath=" + encodeURIComponent(project))).json()).result;
  const sessionId = Object.values(initial.project.state.sessions)[0].id;
  await rpc("chat:send", [{ projectPath: project, sessionId, body: "question", provider: "codex", model: "demo", permissionMode: "ask" }]);
  const deviceId = "b6e2df4b-972b-4e7b-bc65-6cda0a173798";
  let state;
  for (let i = 0; i < 100; i++) {
    state = (await (await rpc("live-activity:state", [{ deviceId }])).json()).result;
    if (state?.question) break;
    await delay(20);
  }
  assert.ok(state.question);
  const action = { deviceId, target: state.question.target, position: 1, option: 0 };
  const answered = await rpc("live-activity:answer", [action]);
  assert.equal(answered.status, 200);
  assert.equal((await answered.json()).result.status, "accepted");
  assert.notEqual((await rpc("live-activity:answer", [action])).status, 200);
  const after = (await (await request("/snapshot?projectPath=" + encodeURIComponent(project))).json()).result;
  const answers = after.project.state.messages.filter((message) => message.body === "Next step: Read a Chat");
  assert.equal(answers.length, 1);
  assert.equal(after.runs.runs[`${project}#${sessionId}`], undefined);
});

test("mobile bridge forwards commands to the existing owner and reads cached snapshots", async (t) => {
  const { dataDir, project, bridge, request, rpc } = await fixture(t);
  assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await rpc("daemon:status")).status, 200);
  assert.equal((await request("/snapshot?projectPath=" + encodeURIComponent(project))).status, 409);
  const opened = (await (await rpc("project:open", [project])).json()).result;
  assert.deepEqual(Object.keys(opened).sort(), ["name", "path"], "the phone reads state from /snapshot, not from open");
  const session = Object.values((await (await request("/snapshot?projectPath=" + encodeURIComponent(project))).json()).result.project.state.sessions)[0];
  const client = await connect({ dataDir });
  t.after(() => client.close());
  await client.call("chat:patch", [project, session.id, { title: "Updated from socket" }]);
  const snapshot = (await (await request("/snapshot?projectPath=" + encodeURIComponent(project))).json()).result;
  assert.equal(snapshot.project.state.sessions[session.id].title, "Updated from socket");
  assert.deepEqual(snapshot.runs.runs, {});
  await bridge.close();
  assert.equal((await client.call("daemon:status")).version, "test");
});

test("a phone opens a named Link and sends one shared Chat with two owned Worktrees", async (t) => {
  const { dataDir, project, rpc, request, bridge, token } = await fixture(t, { runtimeOptions: demoRuntimeOptions() });
  const second = path.join(path.dirname(project), "second");
  await fs.mkdir(second);
  execFileSync("git", ["init", "-b", "main", second], { stdio: "ignore" });
  for (const folder of [project, second]) {
    await fs.writeFile(path.join(folder, "status.txt"), "Original\n");
    execFileSync("git", ["-C", folder, "add", "."]);
    execFileSync("git", ["-C", folder, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Fixture"]);
    assert.equal((await rpc("project:open", [folder])).status, 200);
  }
  const registryResponse = await rpc("project:registry");
  assert.equal(registryResponse.status, 200);
  const registered = (await registryResponse.json()).result;
  const made = await rpc("link:create", [{ name: "Together", projectIds: registered.map((item) => item.id) }]);
  assert.equal(made.status, 200);
  const link = (await made.json()).result;
  const desktopReader = await connect({ dataDir });
  try {
    const hidden = await rpc("link:update", [{ ...link, hidden: true }]);
    assert.equal(hidden.status, 200);
    assert.equal((await desktopReader.call("link:list"))[0].hidden, true, "A phone visibility change reaches the desktop registry");
    await desktopReader.call("link:update", [{ ...link, hidden: false }]);
    const listed = await (await rpc("link:list")).json();
    assert.equal(listed.result[0].hidden, undefined, "A desktop visibility change reaches the phone without deleting the Link");
  } finally {
    desktopReader.close();
  }
  const owner = `milagre-link:${link.id}`;
  assert.equal((await rpc("link:open", [link.id])).status, 200);
  const snapshotRoute = "/snapshot?projectPath=" + encodeURIComponent(owner);
  const initial = (await (await request(snapshotRoute)).json()).result;
  assert.equal(initial.link.link.id, link.id);
  assert.equal(initial.link.projects.length, 2);
  assert.deepEqual(initial.link.state.sessions, {});
  const uploaded = await request("/attachments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectPath: owner, name: "notes.txt", base64: Buffer.from("Shared draft attachment").toString("base64") }),
  });
  assert.equal(uploaded.status, 200, "A Link draft can attach files before allocating Worktrees");
  const socket = new WebSocket(bridge.url.replace("http:", "ws:") + "/live?projectPath=" + encodeURIComponent(owner), {
    headers: { authorization: `Bearer ${token}` },
  });
  t.after(() => socket.terminate());
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const signals = [];
  socket.on("message", (raw) => signals.push(JSON.parse(String(raw)).type));
  const sent = { linkId: link.id, sessionId: null, operationId: randomUUID(), body: "hello", provider: "codex", model: "test", permissionMode: "auto" };
  const answer = await rpc("link:send", [sent]);
  assert.equal(answer.status, 200);
  const id = (await answer.json()).result.sessionId;
  assert.equal((await (await rpc("link:send", [sent])).json()).result.sessionId, id, "retry reuses the shared Chat");
  const client = await connect({ dataDir });
  t.after(() => client.close());
  let saved;
  for (let i = 0; i < 80; i++) {
    saved = (await (await request(snapshotRoute)).json()).result;
    if (saved.link.state.messages.some((message) => message.role === "assistant")) break;
    await delay(50);
  }
  assert.equal(Object.keys(saved.link.state.sessions).length, 1);
  assert.equal(saved.link.state.sessions[id].worktrees.length, 2);
  const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
  const media = (file) => request(`/media?projectPath=${encodeURIComponent(owner)}&path=${encodeURIComponent(file)}`);
  for (const member of saved.link.state.sessions[id].worktrees) {
    const image = path.join(member.worktreePath, "screenshot.png");
    await fs.writeFile(image, png);
    assert.equal((await media(image)).status, 200, "Images in either owned Worktree are available to the shared Chat");
  }
  const outside = path.join(path.dirname(project), "unrelated.png");
  await fs.writeFile(outside, png);
  const alias = path.join(saved.link.state.sessions[id].worktrees[0].worktreePath, "outside.png");
  await fs.symlink(outside, alias);
  assert.equal((await media(outside)).status, 403);
  assert.equal((await media(alias)).status, 403, "An owned Worktree symlink cannot share an unrelated file");
  assert.equal(saved.link.state.messages.filter((message) => message.role === "user").length, 1);
  assert.ok(saved.link.state.messages.some((message) => message.role === "assistant"));
  for (let i = 0; i < 40 && !signals.includes("project"); i++) await delay(50);
  assert.ok(signals.includes("project"), "Link state wakes the phone live socket");
  const message = saved.link.state.messages.at(-1);
  assert.equal((await (await request("/message?projectPath=" + encodeURIComponent(owner) + "&id=" + message.id)).json()).result.id, message.id);
  assert.equal((await request("/runs?projectPath=" + encodeURIComponent(owner))).status, 200);
  assert.equal((await rpc("chat:patch", [owner, id, { title: "From phone" }])).status, 200);
  assert.equal((await (await request(snapshotRoute)).json()).result.link.state.sessions[id].title, "From phone");
});

test("mobile archives finished subagents through the shared owner and restores their output", async (t) => {
  const { project, dataDir, rpc, request } = await fixture(t);
  const subagents = ["completed", "failed", "cancelled", "unknown"].map((status) => ({
    id: status,
    title: status,
    status,
    startedAt: 1,
    updatedAt: 2,
    transcript: [{ id: "message", kind: "message", text: "Preserved output" }],
  }));
  await fs.mkdir(path.join(project, ".milagre"));
  await fs.writeFile(
    path.join(project, ".milagre/coordination.json"),
    JSON.stringify({
      next_id: 3,
      projects: { 1: { id: 1, name: "project" } },
      worktrees: { 1: { id: 1, project_id: 1, path: project, name: "main" } },
      sessions: { 2: { id: 2, worktree_id: 1, agent_name: "main", status: "Created", subagents } },
      messages: [],
      tasks: {},
    }),
  );
  await rpc("project:open", [project]);
  assert.equal((await rpc("chat:archive-finished-subagents", [project, 2])).status, 200);
  const desktop = await connect({ dataDir });
  t.after(() => desktop.close());
  const state = (await desktop.call("project:open", [project])).state;
  assert.deepEqual(
    state.sessions[2].subagents.filter((agent) => agent.archived).map((agent) => agent.id),
    ["completed", "failed", "cancelled"],
  );
  assert.equal((await rpc("chat:archive-subagent", [project, 2, "completed", false])).status, 200);
  const phone = (await (await request("/snapshot?projectPath=" + encodeURIComponent(project))).json()).result;
  const restored = phone.project.state.sessions[2].subagents.find((agent) => agent.id === "completed");
  assert.equal(Boolean(restored.archived), false);
  assert.equal(restored.transcript[0].text, "Preserved output");
});

test("the phone shows the end of a long subagent transcript, and archived subagents as summaries, from a bridge that holds only those", async (t) => {
  const { project, rpc, request } = await fixture(t);
  const transcript = Array.from({ length: 30 }, (_, index) => ({ id: `e${index + 1}`, kind: "message", text: `Entry ${index + 1}` }));
  await fs.mkdir(path.join(project, ".milagre"));
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
          subagents: [
            { id: "child", title: "Review", status: "completed", startedAt: 1, updatedAt: 2, transcript },
            { id: "old", title: "Old", status: "completed", startedAt: 1, updatedAt: 2, archived: true, latestActivity: "Finished", transcript },
          ],
        },
      },
      messages: [],
      tasks: {},
    }),
  );
  await rpc("project:open", [project]);
  const phone = (await (await request("/snapshot?projectPath=" + encodeURIComponent(project))).json()).result;
  assert.deepEqual(
    phone.project.state.sessions[2].subagents[0].transcript.map((item) => item.id),
    ["e27", "e28", "e29", "e30"],
  );
  // The phone never shows an archived subagent, so the bridge holds it as a summary.
  const archived = phone.project.state.sessions[2].subagents[1];
  assert.deepEqual([archived.title, archived.detailsOnDemand, archived.transcript, archived.latestActivity], ["Old", true, [], undefined]);
});

test("the phone can load the real skill catalog for its project", async (t) => {
  const { project, rpc } = await fixture(t);
  await rpc("project:open", [project]);
  await fs.mkdir(path.join(project, ".agents", "skills", "phone-skill"), { recursive: true });
  await fs.writeFile(
    path.join(project, ".agents", "skills", "phone-skill", "SKILL.md"),
    "---\nname: phone-skill\ndescription: A skill from the project.\n---\nDo the work.\n",
  );
  const response = await rpc("skills:list", [project]);
  assert.equal(response.status, 200);
  const catalog = (await response.json()).result;
  assert.ok(catalog.skills.some((skill) => skill.name === "phone-skill" && skill.description === "A skill from the project."));
  assert.ok(
    ["tldr", "milagre", "milagre-advisor", "milagre-committee", "milagre-help"].every((name) => catalog.skills.some((skill) => skill.name === name)),
    "bundled skills reach the phone",
  );
  assert.equal((await rpc("skills:list", [os.homedir()])).status, 409, "the daemon still requires a known folder");
  const skill = catalog.skills.find((item) => item.name === "phone-skill");
  const read = await rpc("skills:read", [project, skill.path]);
  assert.equal(read.status, 200);
  assert.ok((await read.json()).result.includes("Do the work."), "the phone reads a listed SKILL.md");
});

test("HTTP guard rejects unauthorized, cross-origin, malformed and unsupported requests", async (t) => {
  const { bridge, request, rpc, token } = await fixture(t);
  assert.equal((await fetch(bridge.url + "/snapshot")).status, 401);
  assert.equal((await request("/snapshot", { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await request("/snapshot", { headers: { origin: "https://evil.example" } })).status, 403);
  const hostileHost = await new Promise((resolve, reject) => {
    const req = http.get(bridge.url + "/snapshot", { headers: { host: "evil.example", authorization: `Bearer ${token}` } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
  });
  assert.equal(hostileHost, 403);
  const androidHost = await new Promise((resolve, reject) => {
    const req = http.request(
      bridge.url + "/rpc",
      { method: "POST", headers: { host: `10.0.2.2:${new URL(bridge.url).port}`, authorization: `Bearer ${token}`, "content-type": "application/json" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ v: 1, method: "daemon:status", args: [] }));
  });
  assert.equal(androidHost, 200);
  assert.equal((await rpc("git:commit", ["/tmp/nope"])).status, 403);
  // The phone may ask for a removal, but the daemon refuses one outside a Project it has open.
  assert.equal((await rpc("worktree:remove", ["/tmp/nope"])).status, 409);
  assert.equal((await rpc("daemon:stop")).status, 403);
  assert.equal((await request("/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status, 400);
  assert.equal((await request("/rpc", { method: "POST", body: JSON.stringify({ v: 1, method: "daemon:status", args: [] }) })).status, 415);
  assert.equal(
    (
      await request("/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ v: 2, method: "daemon:status", args: [] }),
      })
    ).status,
    400,
  );
  assert.equal((await request("/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(1024 * 1024 + 1) })).status, 413);
});

test("mobile can manage Chat metadata and create Worktrees, and read changes only in open Projects", async (t) => {
  const { project, rpc, request } = await fixture(t);
  execFileSync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Initial"], {
    stdio: "ignore",
  });
  await rpc("project:open", [project]);
  const chat = Object.values((await (await request("/snapshot?projectPath=" + encodeURIComponent(project))).json()).result.project.state.sessions)[0];
  assert.equal((await rpc("chat:patch", [project, chat.id, { title: "Mobile name", archived: true }])).status, 200);
  let state = (await (await request("/snapshot?projectPath=" + encodeURIComponent(project))).json()).result;
  assert.equal(state.project.state.sessions[chat.id].title, "Mobile name");
  assert.equal(state.project.state.sessions[chat.id].archived, true);
  assert.equal((await rpc("project:branches", [project])).status, 200);
  const created = await rpc("worktree:create", [{ projectPath: project, baseBranch: "main", prompt: "Mobile feature" }]);
  assert.equal(created.status, 200);
  const result = (await created.json()).result;
  assert.ok(result.project.state.worktrees[result.worktreeId]);
  // Only the new worktree and its Chat travel back: a large Project's whole state is too big for the phone's socket.
  assert.deepEqual(Object.keys(result.project.state.worktrees), [String(result.worktreeId)]);
  assert.deepEqual(result.project.state.messages, []);
  assert.ok(Object.values(result.project.state.sessions).length >= 1);
  assert.ok(Object.values(result.project.state.sessions).every((session) => session.worktree_id === result.worktreeId));
  assert.equal(result.project.state.sessions[chat.id], undefined, "the main checkout's Chat stays out");
  await fs.writeFile(path.join(project, "mobile.txt"), "A change from the computer\n");
  const files = (await (await rpc("git:diff-files", [{ cwd: project, mode: "uncommitted" }])).json()).result;
  assert.ok(files.files.some((file) => file.path === "mobile.txt"));
  const diff = (await (await rpc("git:diff-file", [{ cwd: project, mode: "uncommitted", path: "mobile.txt", untracked: true }])).json()).result;
  assert.match(diff.patch, /\+A change from the computer/);
  assert.equal((await rpc("git:diff-files", [{ cwd: os.homedir(), mode: "uncommitted" }])).status, 409);
  assert.equal((await rpc("git:diff-file", [{ cwd: project, mode: "uncommitted", path: "../outside" }])).status, 409);
  for (const method of ["git:commit", "git:push", "git:open-pr", "daemon:stop"]) assert.equal((await rpc(method)).status, 403);
});

test("the phone checks a Chat's worktree and removes a clean Milagre worktree, and a changed one is refused", async (t) => {
  const { project, request, rpc } = await fixture(t);
  execFileSync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Initial"], {
    stdio: "ignore",
  });
  await rpc("project:open", [project]);
  const json = async (response) => {
    const body = await response.json();
    assert.equal(response.status, 200, body.error?.message);
    return body.result;
  };
  const roots = await json(await rpc("worktree:roots"));
  assert.ok(Array.isArray(roots) && roots.length > 0);
  const create = async (prompt) => {
    const created = await json(await rpc("worktree:create", [{ projectPath: project, baseBranch: "main", prompt }]));
    const worktree = created.project.state.worktrees[created.worktreeId];
    const chat = Object.values(created.project.state.sessions).find((session) => session.worktree_id === worktree.id);
    assert.ok(
      roots.some((root) => worktree.path.startsWith(root + "/")),
      "a created worktree is under a root the phone was given",
    );
    return { worktree, chatId: `${project}#${chat.id}` };
  };
  const removal = ({ worktree, chatId }, seen, force = false) =>
    rpc("worktree:remove", [worktree.path, { force, base: worktree.base, projectPath: project, chatId, seen }]);

  const clean = await create("Clean");
  const status = await json(await rpc("worktree:status", [clean.worktree.path, clean.worktree.base]));
  assert.deepEqual({ ...status, head: typeof status.head }, { uncommitted: 0, unpushed: 0, branch: clean.worktree.name, head: "string", removable: true });
  assert.equal((await json(await removal(clean, status))).removed, true);
  await assert.rejects(fs.stat(clean.worktree.path), { code: "ENOENT" });
  const snapshot = (await (await request("/snapshot?projectPath=" + encodeURIComponent(project))).json()).result;
  assert.equal(snapshot.project.state.worktrees[clean.worktree.id], undefined, "the removed worktree and its Chats leave the Project");

  // Work lands after the phone looked: neither the safe nor the forced removal goes ahead.
  const changed = await create("Changed");
  const seen = await json(await rpc("worktree:status", [changed.worktree.path, changed.worktree.base]));
  await fs.writeFile(path.join(changed.worktree.path, "late.txt"), "written after the check\n");
  for (const force of [false, true]) {
    const refused = await removal(changed, seen, force);
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error.message, /^WORKTREE_CHANGED: /);
  }
  assert.equal(await fs.readFile(path.join(changed.worktree.path, "late.txt"), "utf8"), "written after the check\n");
});

// A bridge over a daemon whose Chats run the scripted demo agent, with one commit, the Project open, and helpers to
// create a worktree (with its Chat), add a Chat to it and ask for its removal.
async function removalFixture(t) {
  const { createSession, agentCli, agentModels, agentCliStatus } = demoRuntimeOptions({});
  const f = await fixture(t, { runtimeOptions: { createSession, agentCli, agentModels, agentCliStatus } });
  execFileSync("git", ["-C", f.project, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Initial"], {
    stdio: "ignore",
  });
  await f.rpc("project:open", [f.project]);
  const answer = async (response) => ({ status: response.status, body: await response.json() });
  const snapshot = async () => (await (await f.request("/snapshot?projectPath=" + encodeURIComponent(f.project))).json()).result;
  const idle = async () => {
    for (let i = 0; i < 200 && Object.keys((await snapshot()).runs.runs).length; i++) await delay(20);
  };
  const create = async (prompt) => {
    const { body } = await answer(await f.rpc("worktree:create", [{ projectPath: f.project, baseBranch: "main", prompt }]));
    const worktree = body.result.project.state.worktrees[body.result.worktreeId];
    const chat = Object.values(body.result.project.state.sessions).find((session) => session.worktree_id === worktree.id);
    const seen = (await answer(await f.rpc("worktree:status", [worktree.path, worktree.base]))).body.result;
    return { worktree, chatId: `${f.project}#${chat.id}`, seen };
  };
  const addChat = async (worktree) => {
    const { status, body } = await answer(
      await f.rpc("chat:send", [{ projectPath: f.project, worktreeId: worktree.id, body: "hello", provider: "codex", model: "demo", permissionMode: "ask" }]),
    );
    assert.equal(status, 200, JSON.stringify(body));
    await idle();
    return body.result.sessionId;
  };
  const remove = (worktreePath, options) =>
    f.rpc("worktree:remove", [worktreePath, { force: false, base: "main", projectPath: f.project, ...options }]).then(answer);
  return { ...f, answer, snapshot, create, addChat, remove };
}

test("the daemon refuses to remove a worktree another Chat started using, or for a Chat on another worktree", async (t) => {
  const f = await removalFixture(t);
  const first = await f.create("First");
  const second = await f.create("Second");
  // A Chat started in the worktree after the phone checked it.
  assert.equal(await f.addChat(first.worktree), Number(first.chatId.split("#")[1]), "the first message goes to the worktree's own Chat");
  const later = await f.addChat(first.worktree);
  assert.notEqual(later, Number(first.chatId.split("#")[1]));
  let refused = await f.remove(first.worktree.path, { chatId: first.chatId, seen: first.seen });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error.message, /Another chat uses this worktree now/);
  // The Chat named is on another worktree.
  refused = await f.remove(first.worktree.path, { chatId: second.chatId, seen: first.seen });
  assert.match(refused.body.error.message, /isn't on this worktree/);
  refused = await f.remove(first.worktree.path, { chatId: `${f.project}#9999`, seen: first.seen });
  assert.match(refused.body.error.message, /isn't on this worktree/);
  await fs.stat(first.worktree.path);
  // Once the other Chat is archived too, the worktree goes.
  await f.rpc("chat:patch", [f.project, later, { archived: true }]);
  const removed = await f.remove(first.worktree.path, { chatId: first.chatId, seen: first.seen });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.result.removed, true);
});

test("the daemon removes only a worktree Milagre made in a Project open here", async (t) => {
  const f = await removalFixture(t);
  const made = await f.create("Made");
  // A Project that isn't open: refused before anything is written into it.
  const elsewhere = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-elsewhere-")));
  t.after(() => fs.rm(elsewhere, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "main", elsewhere], { stdio: "ignore" });
  let refused = await f.remove(made.worktree.path, { projectPath: elsewhere, chatId: made.chatId, seen: made.seen });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error.message, /Open this project in Milagre first/);
  await assert.rejects(fs.stat(path.join(elsewhere, ".milagre")), { code: "ENOENT" });
  // A folder that isn't one of the Project's worktrees.
  refused = await f.remove(path.join(path.dirname(made.worktree.path), "unknown"), { chatId: made.chatId, seen: made.seen });
  assert.match(refused.body.error.message, /isn't a worktree of this project/);
  // A worktree git has but Milagre didn't make: it has no base.
  const manual = path.join(path.dirname(made.worktree.path), "manual");
  execFileSync("git", ["-C", f.project, "worktree", "add", "-b", "manual", manual, "main"], { stdio: "ignore" });
  await f.rpc("project:open", [f.project]);
  const listed = Object.values((await f.snapshot()).project.state.worktrees).find((worktree) => worktree.path === manual);
  assert.ok(listed && !listed.base);
  refused = await f.remove(manual, { seen: made.seen });
  assert.match(refused.body.error.message, /didn't create/);
  // The Project's own checkout.
  refused = await f.remove(f.project, { seen: made.seen });
  assert.match(refused.body.error.message, /didn't create|isn't a worktree/);
  await fs.stat(manual);
  await fs.stat(made.worktree.path);
});

test("two removals of one worktree take turns, and the second reports it already removed", async (t) => {
  const f = await removalFixture(t);
  const made = await f.create("Twice");
  const [one, two] = await Promise.all([1, 2].map(() => f.remove(made.worktree.path, { chatId: made.chatId, seen: made.seen })));
  assert.deepEqual([one.status, two.status], [200, 200], JSON.stringify([one.body, two.body]));
  // Concurrent HTTP requests can reach the daemon in either order. Exactly one performs the removal.
  assert.equal([one, two].filter((reply) => reply.body.result.removed === true).length, 1);
  assert.equal([one, two].filter((reply) => reply.body.result.alreadyRemoved === true).length, 1);
  await assert.rejects(fs.stat(made.worktree.path), { code: "ENOENT" });
});

test("mobile uploads are private, bounded and scoped to an open Project", async (t) => {
  const { project, dataDir, request, rpc } = await fixture(t);
  const upload = (value) => request("/attachments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  const payload = { projectPath: project, name: "../../notes.txt", base64: Buffer.from("Review this document").toString("base64") };
  assert.equal((await upload(payload)).status, 409);
  await rpc("project:open", [project]);
  const response = await upload(payload);
  assert.equal(response.status, 200);
  const file = (await response.json()).result;
  assert.ok(file.path.startsWith(path.join(dataDir, "mobile-attachments") + path.sep));
  assert.equal(path.basename(file.path), "notes.txt");
  assert.equal(await fs.readFile(file.path, "utf8"), "Review this document");
  assert.equal((await fs.stat(file.path)).mode & 0o777, 0o600);
  assert.equal((await upload({ ...payload, base64: "invalid!" })).status, 400);
  assert.equal((await upload({ ...payload, base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") })).status, 413);
  const next = (await (await upload(payload)).json()).result;
  assert.notEqual(next.path, file.path);
});

test("a chat screenshot outside the Project is served privately and retained after its temporary source is removed", async (t) => {
  const { project, dataDir, request, rpc } = await fixture(t);
  const file = path.join(path.dirname(project), "drawer.png");
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("screenshot")]);
  await fs.writeFile(file, png);
  await rpc("project:open", [project]);
  const snapshot = (await (await request("/snapshot?projectPath=" + encodeURIComponent(project))).json()).result;
  const chat = Object.values(snapshot.project.state.sessions)[0];
  const media = () => request(`/media?projectPath=${encodeURIComponent(project)}&path=${encodeURIComponent(file)}`);
  assert.equal((await media()).status, 403);
  const client = await connect({ dataDir });
  t.after(() => client.close());
  await client.call("chat:git-note", [`${project}#${chat.id}`, `![Drawer](${file})`]);
  const response = await media();
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  await fs.unlink(file);
  assert.deepEqual(Buffer.from(await (await media()).arrayBuffer()), png);
  assert.equal(
    (await request(`/media?projectPath=${encodeURIComponent(project)}&path=${encodeURIComponent(path.join(path.dirname(project), "unshared.png"))}`)).status,
    403,
  );
});

test("mobile media serves images only from the Project Worktrees and Milagre image folders", async (t) => {
  const { project, dataDir, bridge, request, rpc, token } = await fixture(t);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("pretend image data")]);
  const media = (file, projectPath = project) => request(`/media?projectPath=${encodeURIComponent(projectPath)}&path=${encodeURIComponent(file)}`);
  const inside = path.join(project, "shot.png");
  await fs.writeFile(inside, png);
  assert.equal((await media(inside)).status, 409); // The Project is not open yet.
  execFileSync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Initial"], {
    stdio: "ignore",
  });
  const created = (await (await rpc("worktree:create", [{ projectPath: project, baseBranch: "main", prompt: "Media" }])).json()).result;
  const worktree = created.project.state.worktrees[created.worktreeId].path;

  const generated = path.join(worktree, "generated.png");
  await fs.writeFile(generated, png);
  const ok = await media(generated);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/png");
  assert.equal(ok.headers.get("cache-control"), "private, max-age=3600");
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), png);

  // Persisted attachments and mobile uploads.
  await fs.mkdir(path.join(project, ".milagre", "images"), { recursive: true });
  const persisted = path.join(project, ".milagre", "images", "abc.png");
  await fs.writeFile(persisted, png);
  assert.equal((await media(persisted)).status, 200);
  await fs.mkdir(path.join(dataDir, "mobile-attachments", "one"), { recursive: true });
  const uploaded = path.join(dataDir, "mobile-attachments", "one", "photo.png");
  await fs.writeFile(uploaded, png);
  assert.equal((await media(uploaded)).status, 200);

  // Outside every allowed folder, including through a symlink inside a Worktree.
  const outside = path.join(path.dirname(project), "secret.png");
  await fs.writeFile(outside, png);
  assert.equal((await media(outside)).status, 403);
  await fs.symlink(outside, path.join(worktree, "link.png"));
  assert.equal((await media(path.join(worktree, "link.png"))).status, 403);
  await fs.symlink(path.dirname(project), path.join(worktree, "up"));
  assert.equal((await media(path.join(worktree, "up", "secret.png"))).status, 403);
  assert.equal((await media(path.join(path.dirname(project), "missing.png"))).status, 403);
  assert.equal((await media(path.join(worktree, "missing.png"))).status, 404);

  // Only supported images: 415 for another extension or for bytes that are not an image, 400 for a relative path.
  await fs.writeFile(path.join(worktree, "notes.txt"), "hello");
  assert.equal((await media(path.join(worktree, "notes.txt"))).status, 415);
  await fs.writeFile(path.join(worktree, "fake.png"), "not really a png");
  assert.equal((await media(path.join(worktree, "fake.png"))).status, 415);
  await fs.symlink(path.join(worktree, "notes.txt"), path.join(worktree, "alias.png"));
  assert.equal((await media(path.join(worktree, "alias.png"))).status, 415);
  assert.equal((await media("shot.png")).status, 400);
  assert.equal((await request(`/media?projectPath=${encodeURIComponent(project)}`)).status, 400);
  assert.equal((await media(worktree + "/dir.png")).status, 404);
  await fs.mkdir(path.join(worktree, "folder.png"));
  assert.equal((await media(path.join(worktree, "folder.png"))).status, 403);

  // 15 MiB cap.
  const big = path.join(worktree, "big.png");
  await fs.writeFile(big, Buffer.concat([png, Buffer.alloc(15 * 1024 * 1024)]));
  assert.equal((await media(big)).status, 413);

  // Same token and host rules as every other route.
  const url = `/media?projectPath=${encodeURIComponent(project)}&path=${encodeURIComponent(generated)}`;
  assert.equal((await fetch(bridge.url + url)).status, 401);
  assert.equal((await request(url, { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await request(url, { headers: { origin: "https://evil.example" } })).status, 403);
  const hostileHost = await new Promise((resolve, reject) => {
    const req = http.get(bridge.url + url, { headers: { host: "evil.example", authorization: `Bearer ${token}` } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
  });
  assert.equal(hostileHost, 403);
});

test("the bridge reports a lost daemon and stops listening, so its owner can restart it", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-mobile-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "profile");
  const daemon = await startDaemon({ dataDir, version: "test", runtimeOptions: { environmentReady: Promise.resolve(), titleModels: {} } });
  const bridge = await startMobileBridge({ dataDir, port: 0, token: randomBytes(32).toString("hex") });
  await daemon.close();
  await bridge.lost;
  await assert.rejects(fetch(bridge.url + "/rpc", { method: "POST" }));
});

test("snapshots carry an ETag, an unchanged one is a 304, and large bodies are gzipped", async (t) => {
  const { project, rpc, request, token, dataDir } = await fixture(t);
  await rpc("project:open", [project]);
  const route = "/snapshot?projectPath=" + encodeURIComponent(project);
  const first = await request(route);
  const etag = first.headers.get("etag");
  assert.match(etag, /^"[\w-]+"$/);
  const body = await first.json();
  assert.equal(body.v, 1);
  const again = await request(route, { headers: { "if-none-match": etag } });
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");
  await rpc("chat:patch", [project, Object.values(body.result.project.state.sessions)[0].id, { title: "Changed" }]);
  assert.equal((await request(route, { headers: { "if-none-match": etag } })).status, 200);
  // The test Project is tiny, so a second bridge compresses everything.
  const eager = await startMobileBridge({ dataDir, port: 0, token, compressAbove: 0 });
  t.after(() => eager.close());
  const zipped = await new Promise((resolve, reject) => {
    require("node:http")
      .get(new URL(route, eager.url), { headers: { authorization: `Bearer ${token}`, "accept-encoding": "gzip" } }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ encoding: res.headers["content-encoding"], body: Buffer.concat(chunks) }));
      })
      .on("error", reject);
  });
  assert.equal(zipped.encoding, "gzip");
  assert.equal(JSON.parse(require("node:zlib").gunzipSync(zipped.body)).v, 1);
});

test("the phone snapshot leaves out tool output and old subagent transcript, keeping thinking", () => {
  const steps = [
    { id: "t", kind: "thinking", title: "Thought", status: "done", detail: "first" },
    { id: "a", kind: "shell", title: "Ran", status: "done", detail: "x".repeat(5000) },
    { id: "b", kind: "thinking", title: "Thought", status: "done", detail: "why" },
    { id: "c", kind: "read", title: "Read", status: "done" },
  ];
  const transcript = Array.from({ length: 9 }, (_, i) => ({ id: String(i), kind: "message", text: i === 8 ? "y".repeat(2000) : `line ${i}` }));
  const project = {
    path: "/p",
    state: {
      messages: [{ id: 1, session_id: 1, body: "hi", steps }],
      sessions: {
        1: {
          id: 1,
          subagents: [
            { id: "s", transcript },
            { id: "advisor", source: "milagre-advisor", transcript: [{ id: "result", kind: "message", text: "z".repeat(45_000) }] },
          ],
        },
      },
    },
  };
  const phone = forPhone(project);
  assert.deepEqual(
    phone.state.messages[0].steps.map((step) => [step.id, step.detail, step.hasDetail]),
    [
      ["t", undefined, true],
      ["a", undefined, true],
      ["b", "why", undefined],
      ["c", undefined, undefined],
    ],
  );
  assert.deepEqual(
    phone.state.sessions[1].subagents[0].transcript.map((item) => item.id),
    ["5", "6", "7", "8"],
  );
  assert.equal(phone.state.sessions[1].subagents[0].transcript.at(-1).text.length, 601);
  assert.equal(phone.state.sessions[1].subagents[1].transcript[0].text.length, 40_000, "advisor output remains readable within its shared bound");
  assert.equal(project.state.sessions[1].subagents[1].transcript[0].text.length, 45_000);
  assert.equal(project.state.messages[0].steps[1].detail.length, 5000, "the daemon's state is untouched");
});

function longTurn() {
  const steps = Array.from({ length: 300 }, (_, i) => ({
    id: `s${i}`,
    kind: i === 5 ? "thinking" : "shell",
    title: `Step ${i}`,
    status: i === 10 ? "running" : "done",
    note: `n${i}`,
    offset: i,
    detail: `${i % 10}`.repeat(19_990) + "END" + i,
  }));
  return { text: "working", model: "m", steps, approvals: [{ id: "a" }], questions: [], answered: {} };
}

test("runsForPhone keeps the end of live output and drops the rest of the tool output", () => {
  const run = longTurn();
  const runs = { runs: { "p#1": run, "p#2": { text: "no steps", steps: [] } }, seq: 7 };
  const phone = runsForPhone(runs);
  const steps = phone.runs["p#1"].steps;
  assert.equal(phone.seq, 7);
  assert.deepEqual(phone.runs["p#2"], runs.runs["p#2"]);
  assert.deepEqual(
    steps.filter((step) => step.detail).map((step) => step.id),
    ["s5", "s10", "s297", "s298", "s299"],
    "the thinking step, the running one and the last three",
  );
  for (const id of ["s10", "s297", "s298", "s299"]) {
    const step = steps.find((item) => item.id === id);
    assert.equal(step.detail.length, 4097);
    assert.ok(step.detail.startsWith("…") && step.detail.endsWith(`END${id.slice(1)}`), "the tail of the log");
    assert.equal(step.hasDetail, undefined);
  }
  assert.equal(steps[5].detail, run.steps[5].detail, "the latest thinking step is whole");
  assert.ok(steps.filter((step) => !step.detail).every((step) => step.hasDetail === true));
  assert.equal(steps.filter((step) => step.hasDetail).length, 295);
  assert.deepEqual(
    { ...steps[0], detail: undefined, hasDetail: undefined },
    { ...run.steps[0], detail: undefined, hasDetail: undefined },
    "everything but detail is unchanged",
  );
  assert.equal(phone.runs["p#1"].text, "working");
  assert.deepEqual(phone.runs["p#1"].approvals, run.approvals);
  assert.equal(run.steps[0].detail.length, 19_994, "the daemon's runs are untouched");
});

test("runsForPhone keeps only the latest thinking step whole, and short or empty output as is", () => {
  const step = (id, kind, status, detail) => ({ id, kind, title: id, status, ...(detail === undefined ? {} : { detail }) });
  const steps = [
    step("t1", "thinking", "done", "first"),
    step("t2", "thinking", "done", "second"),
    step("a", "shell", "done", "old"),
    step("b", "read", "done"),
    step("c", "shell", "done", "new"),
    step("d", "shell", "done", "short"),
    step("e", "shell", "running", "z".repeat(5000)),
  ];
  const phone = runsForPhone({ runs: { k: { text: "", steps } }, seq: 1 }).runs.k.steps;
  assert.deepEqual(
    phone.map((item) => [item.id, item.detail?.length, item.hasDetail]),
    [
      ["t1", undefined, true],
      ["t2", 6, undefined],
      ["a", undefined, true],
      ["b", undefined, undefined],
      ["c", 3, undefined],
      ["d", 5, undefined],
      ["e", 4097, undefined],
    ],
  );
});

test("/runs and the snapshot's runs stay small while a turn streams a lot of tool output, and /runs answers 304 when unchanged", async (t) => {
  const agent = scriptedAgent();
  const { dataDir, project, rpc, request } = await fixture(t, { runtimeOptions: agent.runtimeOptions });
  await rpc("project:open", [project]);
  const chat = Object.values((await (await request("/snapshot?projectPath=" + encodeURIComponent(project))).json()).result.project.state.sessions)[0].id;
  assert.equal(
    (await rpc("chat:send", [{ projectPath: project, sessionId: chat, body: "go", provider: "codex", model: "m", permissionMode: "ask" }])).status,
    200,
  );
  // The message is saved before the turn starts in the background; wait for its agent session.
  for (const start = Date.now(); !agent.sessions[0] && Date.now() - start < 3000; await delay(10));
  const session = agent.sessions[0];
  for (const step of longTurn().steps) {
    session.emit({ type: "step-started", step: { id: step.id, kind: step.kind, title: step.title } });
    if (step.status === "done") session.emit({ type: "step-completed", id: step.id, status: "done", detail: step.detail });
    else session.emit({ type: "step-output", id: step.id, text: step.detail });
  }
  const key = `${project}#${chat}`;
  const direct = await connect({ dataDir });
  t.after(() => direct.close());
  let whole;
  for (const start = Date.now(); Date.now() - start < 3000; await delay(20)) {
    whole = (await direct.call("chat:runs")).runs[key];
    if (whole?.steps.length === 300 && whole.steps.at(-1).status === "done") break;
  }
  assert.equal(whole.steps.length, 300);
  const route = "/runs?projectPath=" + encodeURIComponent(project);
  const response = await request(route);
  const text = await response.text();
  const steps = JSON.parse(text).result.runs[key].steps;
  assert.ok(JSON.stringify(whole).length > 5_000_000);
  assert.ok(text.length < 100_000, `${text.length} bytes`);
  assert.equal(steps.length, 300);
  assert.deepEqual(
    steps.filter((step) => step.detail).map((step) => step.id),
    ["s5", "s10", "s297", "s298", "s299"],
  );
  assert.ok(steps.filter((step) => step.detail && step.id !== "s5").every((step) => step.detail.length === 4097));
  assert.equal(steps.filter((step) => step.hasDetail).length, 295);
  const snapshot = await (await request("/snapshot?projectPath=" + encodeURIComponent(project))).text();
  assert.ok(snapshot.length < 120_000, `${snapshot.length} bytes`);
  assert.deepEqual(
    JSON.parse(snapshot).result.runs.runs[key].steps.map((step) => step.hasDetail),
    steps.map((step) => step.hasDetail),
    "the snapshot's runs are slimmed the same way",
  );
  const etag = response.headers.get("etag");
  assert.ok(etag);
  const again = await request(route, { headers: { "if-none-match": etag } });
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");
});

test("the phone can change a Chat's permission mode, and only to a known one", async (t) => {
  const { project, rpc } = await fixture(t);
  await rpc("project:open", [project]);
  assert.equal((await rpc("agent:set-permission-mode", [{ chatId: `${project}#1`, mode: "full" }])).status, 200);
  assert.equal((await rpc("agent:set-permission-mode", [{ chatId: `${project}#1`, mode: "root" }])).status, 409);
});

// An agent whose events the test sends itself, so each signal can be told apart.
function scriptedAgent() {
  const sessions = [];
  const createSession = (_provider, { emit }) => {
    const session = {
      closed: false,
      turnActive: false,
      nativeId: `scripted-${sessions.length}`,
      emit,
      async startTurn() {
        session.turnActive = true;
        emit({ type: "session-started", nativeId: session.nativeId });
        emit({ type: "turn-started", turnId: "turn" });
        return { turnId: "turn" };
      },
      respondToPermission: () => false,
      answerQuestion: () => false,
      async interrupt() {
        if (session.turnActive) emit({ type: "turn-cancelled" });
        session.turnActive = false;
      },
      async close() {
        await session.interrupt();
        session.closed = true;
      },
    };
    sessions.push(session);
    return session;
  };
  return { sessions, runtimeOptions: { createSession, agentCli: Object.assign(async () => ({ command: "/scripted/codex" }), { invalidate() {} }) } };
}
function openLive(bridge, projectPath, headers, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${bridge.url.replace(/^http/, "ws")}/live?projectPath=${encodeURIComponent(projectPath)}`, { headers, ...options });
    const messages = [];
    socket.on("message", (data) => messages.push(JSON.parse(String(data)).type));
    socket.once("open", () =>
      resolve({ socket, messages, closed: new Promise((done) => socket.once("close", (code, reason) => done({ code, reason: String(reason) }))) }),
    );
    socket.once("unexpected-response", (_req, res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    socket.once("error", reject);
  });
}
async function until(check, ms = 3000) {
  for (const start = Date.now(); Date.now() - start < ms; await delay(10)) if (check()) return;
  throw new Error("Timed out");
}

test("the live socket checks the token, Host, Origin and path before upgrading", async (t) => {
  const { project, bridge, token } = await fixture(t);
  const auth = { authorization: `Bearer ${token}` };
  assert.equal((await openLive(bridge, project, {})).status, 401);
  assert.equal((await openLive(bridge, project, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await openLive(bridge, project, { ...auth, origin: "https://evil.example" })).status, 403);
  assert.equal((await openLive(bridge, project, { ...auth, host: "evil.example" })).status, 403);
  assert.equal((await openLive(bridge, "relative/path", auth)).status, 400);
  const elsewhere = await new Promise((resolve) => {
    const socket = new WebSocket(`${bridge.url.replace(/^http/, "ws")}/snapshot`, { headers: auth });
    socket.once("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode);
    });
  });
  assert.equal(elsewhere, 404);
  // React Native always sends an Origin; the app's own is the one accepted.
  const phone = await openLive(bridge, project, { ...auth, origin: "milagre-app://phone" });
  assert.equal(phone.socket.readyState, WebSocket.OPEN);
  const bare = await openLive(bridge, project, auth);
  assert.equal(bare.socket.readyState, WebSocket.OPEN);
  // A plain request to the socket's path is not an endpoint.
  assert.equal((await fetch(bridge.url + "/live?projectPath=" + encodeURIComponent(project), { headers: auth })).status, 404);
  await bridge.close();
  assert.equal((await phone.closed).code, 1001);
  assert.equal((await bare.closed).code, 1001);
});

test("a live socket signals runs and state changes of its Project only, and /runs returns that Project's turns", async (t) => {
  const agent = scriptedAgent();
  const { project, bridge, rpc, request, token } = await fixture(t, { runtimeOptions: agent.runtimeOptions });
  const other = project + "-other";
  await fs.mkdir(other);
  execFileSync("git", ["init", "-b", "main", other], { stdio: "ignore" });
  const chatOf = async (path) => {
    await rpc("project:open", [path]);
    return Object.values((await (await request("/snapshot?projectPath=" + encodeURIComponent(path))).json()).result.project.state.sessions)[0].id;
  };
  const [chat, otherChat] = [await chatOf(project), await chatOf(other)];
  const auth = { authorization: `Bearer ${token}` };
  const mine = await openLive(bridge, project, auth);
  const theirs = await openLive(bridge, other, auth);

  // A state change elsewhere reaches only that Project's socket.
  await rpc("chat:patch", [other, otherChat, { title: "Elsewhere" }]);
  await until(() => theirs.messages.includes("project"));
  await delay(500);
  assert.deepEqual(mine.messages, []);
  await rpc("chat:patch", [project, chat, { title: "Here" }]);
  await until(() => mine.messages.length);
  assert.deepEqual(mine.messages, ["project"]);

  // Sending saves the user's message (a Project change) and starts a run.
  const send = (path, sessionId) => rpc("chat:send", [{ projectPath: path, sessionId, body: "hello", provider: "codex", model: "m", permissionMode: "ask" }]);
  assert.equal((await send(project, chat)).status, 200);
  await until(() => mine.messages.length === 2);
  await delay(300);
  assert.deepEqual(mine.messages, ["project", "project"]);
  // Streamed text is a burst of run events: one "runs" signal per window, and nothing for the other Project.
  const theirCount = theirs.messages.length;
  const session = agent.sessions[0];
  for (let i = 0; i < 5; i++) session.emit({ type: "text-delta", text: `part ${i} ` });
  await until(() => mine.messages.length === 3);
  await delay(300);
  assert.deepEqual(mine.messages.slice(2), ["runs"]);
  assert.equal(theirs.messages.length, theirCount);

  const runs = await (await request("/runs?projectPath=" + encodeURIComponent(project))).json();
  assert.match(runs.result.runs[`${project}#${chat}`].text, /part 4/);
  assert.ok(Number.isInteger(runs.result.seq));
  assert.deepEqual((await (await request("/runs?projectPath=" + encodeURIComponent(other))).json()).result.runs, {});
  assert.deepEqual(
    Object.keys((await (await request("/snapshot?projectPath=" + encodeURIComponent(other))).json()).result.runs.runs),
    [],
    "snapshots carry their own Project's turns only",
  );
  assert.equal((await request("/runs?projectPath=relative")).status, 400);
  assert.equal((await fetch(bridge.url + "/runs?projectPath=" + encodeURIComponent(project))).status, 401);
  // A question puts the chat on the attention list every Project's phone view polls.
  assert.deepEqual((await (await request("/attention")).json()).result, []);
  session.emit({ type: "question-request", requestId: "question-1", questions: [{ question: "Which branch?" }] });
  let attention = [];
  for (const start = Date.now(); !attention.length && Date.now() - start < 3000; await delay(10))
    attention = (await (await request("/attention")).json()).result;
  assert.deepEqual(attention, [`${project}#${chat}`]);

  // The turn's end saves its reply: one prompt "project" signal, so the reply never disappears between fetches.
  const started = Date.now();
  session.turnActive = false;
  session.emit({ type: "turn-completed" });
  await until(() => mine.messages.length === 4);
  assert.equal(mine.messages[3], "project");
  assert.ok(Date.now() - started < 400, "a turn's end is not held back like other Project changes");
  assert.deepEqual((await (await request("/runs?projectPath=" + encodeURIComponent(project))).json()).result.runs, {});
});

test("live sockets are pinged, capped, and the oldest gives way to a new one", async (t) => {
  const { project, bridge, token } = await fixture(t, { bridgeOptions: { pingMs: 40 } });
  const auth = { authorization: `Bearer ${token}` };
  const sockets = [];
  for (let i = 0; i < 8; i++) sockets.push(await openLive(bridge, project, auth));
  await until(() => sockets[0].messages.includes("ping"));
  // A socket that stops answering pings is ended.
  const silent = await openLive(bridge, project, auth, { autoPong: false });
  assert.equal((await sockets[0].closed).code, 1013, "the oldest socket made room");
  assert.equal(sockets[1].socket.readyState, WebSocket.OPEN);
  assert.equal((await silent.closed).code, 1006);
  assert.equal(sockets[1].socket.readyState, WebSocket.OPEN);
});

test("a Project over 16 MB reaches the phone: its snapshot, tool output on demand, and the signal at a turn's end", async (t) => {
  const agent = scriptedAgent();
  const { project, bridge, rpc, request, token } = await fixture(t, { runtimeOptions: agent.runtimeOptions });
  const messages = Array.from({ length: 900 }, (_, index) => ({
    id: 10 + index,
    session_id: 2,
    body: `Reply ${index}`,
    context: null,
    role: "assistant",
    steps: [{ id: `step-${index}`, kind: "shell", title: "Ran `npm test`", status: "done", detail: `${index} `.padEnd(20_000, "output line\n") }],
  }));
  await fs.mkdir(path.join(project, ".milagre"));
  await fs.writeFile(
    path.join(project, ".milagre/coordination.json"),
    JSON.stringify({
      next_id: 5000,
      projects: { 1: { id: 1, name: "project" } },
      worktrees: { 1: { id: 1, project_id: 1, path: project, name: "main" } },
      sessions: { 2: { id: 2, worktree_id: 1, agent_name: "main", status: "Created", provider: "codex", title: "Long chat" } },
      messages,
      tasks: {},
    }),
  );
  assert.equal((await rpc("project:open", [project])).status, 200);
  // The daemon moves the long tool output to sidecars; the phone gets the state without it, and asks for one message's.
  const snapshot = (await (await request("/snapshot?projectPath=" + encodeURIComponent(project))).json()).result;
  assert.equal(snapshot.project.state.messages.length, 900);
  assert.equal(snapshot.project.state.messages[0].steps[0].hasDetail, true);
  const message = (await (await request(`/message?projectPath=${encodeURIComponent(project)}&id=10`)).json()).result;
  assert.equal(message.steps[0].detail.length, 20_000);
  // The daemon leaves a state this size out of agent events; a turn's end still signals a prompt snapshot.
  const live = await openLive(bridge, project, { authorization: `Bearer ${token}` });
  assert.equal(
    (await rpc("chat:send", [{ projectPath: project, sessionId: 2, body: "one more", provider: "codex", model: "m", permissionMode: "ask" }])).status,
    200,
  );
  await until(() => live.messages.includes("project"));
  await delay(500);
  const before = live.messages.length;
  agent.sessions[0].turnActive = false;
  agent.sessions[0].emit({ type: "turn-completed" });
  await until(() => live.messages.length > before);
  assert.equal(live.messages.at(-1), "project");
});

test("push registration is authenticated, validated and removable through mobile RPC", async (t) => {
  const { rpc, bridge } = await fixture(t);
  const device = {
    deviceId: "b6e2df4b-972b-4e7b-bc65-6cda0a173798",
    token: "ExpoPushToken[test]",
    hostId: bridge.url,
    notifyWhenWaiting: true,
    notifyOnCompletion: true,
  };
  assert.equal((await rpc("push:register", [device])).status, 200);
  assert.equal((await rpc("push:register", [{ ...device, token: "secret" }])).status, 409);
  assert.equal((await rpc("push:focus", [{ deviceId: device.deviceId, chatId: "/project#1" }])).status, 200);
  assert.equal((await rpc("push:unregister", [{ deviceId: device.deviceId }])).status, 200);
  assert.equal((await rpc("push:focus", [{ deviceId: device.deviceId, chatId: null }])).status, 409);
  assert.equal(
    (
      await fetch(bridge.url + "/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ v: 1, method: "push:register", args: [device] }),
      })
    ).status,
    401,
  );
});

test("drawer projection preserves listing metadata and pending-send identity without transcript bodies", () => {
  const { forChatList } = require("./mobile-bridge.cjs");
  const messages = Array.from({ length: 1000 }, (_, id) => ({
    id,
    session_id: 2,
    role: id % 2 ? "assistant" : "user",
    context: null,
    body: `Message ${id}\n` + "Long transcript ".repeat(500),
    ...(id === 998 ? { clientMessageId: "pending-input" } : id === 500 ? { clientMessageId: "earlier-pending-input" } : {}),
    ...(id === 999 ? { outcome: "failed" } : {}),
    steps: [{ id: "step", detail: "Output".repeat(100) }],
  }));
  const project = {
    path: "/p",
    name: "p",
    state: {
      next_id: 1000,
      projects: {},
      worktrees: { 1: { id: 1, name: "main", path: "/p" } },
      sessions: {
        2: {
          id: 2,
          worktree_id: 1,
          agent_name: "Fallback",
          status: "Idle",
          unread: true,
          subagents: [{ transcript: ["large"] }],
          handoverDraft: "A long brief",
        },
      },
      messages,
      tasks: {},
    },
  };
  const runs = {
    seq: 3,
    runs: {
      "/p#2": {
        text: "Streaming".repeat(1000),
        steps: [{ detail: "large" }],
        approvals: [{ requestId: "approve" }],
        questions: [],
        model: "model",
        startedAt: 1,
        answered: {},
      },
    },
  };
  const copy = forChatList(project, runs);
  assert.equal(copy.previewOnly, true);
  assert.equal(copy.project.state.sessions[2].generatedTitle, undefined, "compact snapshots preserve the full snapshot title fields");
  assert.equal(copy.project.state.sessions[2].unread, true);
  assert.equal(copy.project.state.sessions[2].handoverDraft, "A long brief", "the phone gets the session as it is, minus subagents");
  assert.equal(copy.project.state.sessions[2].subagents, undefined);
  assert.deepEqual(
    copy.project.state.messages.map((message) => message.id),
    [0, 500, 998, 999],
  );
  assert.equal(
    copy.project.state.messages[1].clientMessageId,
    "earlier-pending-input",
    "another input arriving later must not hide an outstanding acknowledgement",
  );
  assert.equal(copy.project.state.messages[2].clientMessageId, "pending-input");
  assert.equal(copy.project.state.messages.at(-1).outcome, "failed");
  assert.ok(copy.project.state.messages.every((message) => !message.body && !message.steps));
  assert.equal(copy.runs.runs["/p#2"].approvals.length, 1);
  assert.equal(copy.runs.runs["/p#2"].text, "");
  assert.deepEqual(copy.runs.runs["/p#2"].steps, []);
  assert.equal(copy.runs.seq, 3);
  assert.ok(JSON.stringify(copy).length < 2000);
  assert.equal(project.state.messages.length, 1000, "the projection does not mutate the transcript");
  assert.equal(project.state.sessions[2].handoverDraft, "A long brief");
});

test("drawer projection does not turn an empty input or handover into an agent-name title", () => {
  const { forChatList } = require("./mobile-bridge.cjs");
  for (const extra of [{}, { handoverDraft: "Brief" }, { generatedTitle: "   " }]) {
    const session = { id: 2, worktree_id: 1, agent_name: "main", ...extra };
    const project = { state: { sessions: { 2: session }, messages: [{ id: 3, session_id: 2, role: "user", body: "" }], tasks: {} } };
    const copy = forChatList(project, { runs: {} });
    assert.equal(copy.project.state.sessions[2].generatedTitle?.trim() || "", "");
  }
});

test("drawer snapshots are marked and cached separately from full snapshots", async (t) => {
  const { project, request, rpc } = await fixture(t);
  await rpc("project:open", [project]);
  const route = "/snapshot?projectPath=" + encodeURIComponent(project);
  const original = (await (await request(route)).json()).result;
  const chat = Object.values(original.project.state.sessions)[0];
  await rpc("chat:patch", [project, chat.id, { title: "Drawer chat" }]);
  const response = await request(route + "&view=chats");
  const preview = (await response.json()).result;
  assert.equal(preview.previewOnly, true);
  assert.equal(preview.project.state.sessions[chat.id].title, "Drawer chat");
  assert.equal((await (await request(route)).json()).result.previewOnly, undefined);
  assert.equal((await request(route + "&view=chats", { headers: { "if-none-match": response.headers.get("etag") } })).status, 304);
});

test("phone:routes is answered by the phone hook, never forwarded to the daemon", async (t) => {
  const asked = [];
  const answer = { hostId: "h".repeat(22), key: "k".repeat(43), lan: ["ws://192.168.1.20:8798"] };
  const { rpc } = await fixture(t, { bridgeOptions: { phoneRoutes: async (key) => (asked.push(key), answer) } });
  const response = await rpc("phone:routes", [{ phoneKey: "p".repeat(43) }]);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result, answer);
  assert.deepEqual(asked, ["p".repeat(43)]);
  // A malformed call still reaches the hook, which owns the validation.
  assert.equal((await rpc("phone:routes", [])).status, 200);
  assert.deepEqual(asked, ["p".repeat(43), undefined]);
});

test("a failing phone:routes hook reports its own status", async (t) => {
  const { rpc } = await fixture(t, {
    bridgeOptions: {
      phoneRoutes: async () => {
        throw Object.assign(new Error("Expected this phone's key"), { status: 400 });
      },
    },
  });
  const response = await rpc("phone:routes", [{ phoneKey: "x" }]);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /key/);
});

test("phone:routes is refused without a hook", async (t) => {
  const { rpc } = await fixture(t);
  assert.equal((await rpc("phone:routes", [{ phoneKey: "p".repeat(43) }])).status, 403);
});

test("phone port RPCs preserve Chat scope and cannot stop an unowned process", async (t) => {
  const f = await fixture(t);
  const chatId = f.project + "#1";
  const list = await f.rpc("chat:ports", [chatId]);
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).result, { chatId, ports: [] });
  const stop = await f.rpc("agent:stop-port", [chatId, process.pid]);
  assert.equal(stop.status, 200);
  assert.equal((await stop.json()).result, false);
});

test("account assignment changes notify live phones independently of Project state signals", async (t) => {
  const { project, bridge, rpc, request, token } = await fixture(t);
  await rpc("project:open", [project]);
  const chat = Object.values((await (await request("/snapshot?projectPath=" + encodeURIComponent(project))).json()).result.project.state.sessions)[0].id;
  const phone = await openLive(bridge, project, { authorization: `Bearer ${token}` });
  await rpc("chat:patch", [project, chat, { title: "Changed while assigning" }]);
  const result = await rpc("accounts:assign", [project, "claude", null]);
  assert.equal(result.status, 200);
  await until(() => phone.messages.includes("accounts") && phone.messages.includes("project"));
  assert.equal(phone.messages.filter((type) => type === "accounts").length, 1);
});

test("a Link made or removed on the computer tells live phones to read the Links again", async (t) => {
  const { project, bridge, rpc, token } = await fixture(t);
  const commit = (folder) =>
    execFileSync("git", ["-C", folder, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Initial"], {
      stdio: "ignore",
    });
  commit(project);
  const other = path.join(path.dirname(project), "other");
  await fs.mkdir(other);
  execFileSync("git", ["init", "-b", "main", other], { stdio: "ignore" });
  commit(other);
  assert.equal((await rpc("project:open", [project])).status, 200);
  assert.equal((await rpc("project:open", [other])).status, 200);
  const registry = (await (await rpc("project:registry")).json()).result;
  const id = (folder) => registry.find((entry) => entry.path === folder).id;
  const phone = await openLive(bridge, project, { authorization: `Bearer ${token}` });
  const added = await rpc("canvas:link-add", [{ project_id: id(project) }, { project_id: id(other) }]);
  assert.equal(added.status, 200);
  await until(() => phone.messages.includes("links"));
  const [link] = (await added.json()).result;
  assert.equal((await rpc("canvas:link-remove", [link.id])).status, 200);
  await until(() => phone.messages.filter((type) => type === "links").length === 2);
});

test("an app that says what snapshot it holds gets the next one as a patch, kept current from the host's patches", async (t) => {
  const { applyStatePatch } = require("@milagre/shared/state-patch");
  const { project, request, rpc } = await fixture(t);
  assert.equal((await rpc("project:open", [project])).status, 200);
  const snapshot = async (since) =>
    (await (await request("/snapshot?projectPath=" + encodeURIComponent(project), { headers: { "x-milagre-snapshot-since": since } })).json()).result;
  const first = await snapshot("none");
  assert.equal(typeof first.epoch, "string");
  const session = Object.values(first.snapshot.project.state.sessions)[0];
  assert.equal(first.snapshot.project.path, project);
  assert.equal(first.snapshot.project.state.sessions[session.id].id, session.id);

  assert.equal((await rpc("chat:patch", [project, session.id, { title: "From the phone" }])).status, 200);
  const deadline = Date.now() + 2000;
  let next;
  // The bridge follows the change from the host's patch; the phone's snapshot shows it once that arrives.
  do next = await snapshot(`${first.epoch}:${first.version}`);
  while (
    applyStatePatch(first.snapshot, next.patch).project.state.sessions[session.id].title !== "From the phone" &&
    Date.now() < deadline &&
    (await delay(20), true)
  );
  assert.equal(next.base, first.version);
  assert.equal("snapshot" in next, false);
  assert.ok(JSON.stringify(next).length < 2000, "a renamed chat is a small patch");
  const patched = applyStatePatch(first.snapshot, next.patch);
  assert.equal(patched.project.state.sessions[session.id].title, "From the phone");
  assert.deepEqual(patched.project, (await (await request("/snapshot?projectPath=" + encodeURIComponent(project))).json()).result.project);

  // A number this bridge never gave, or no header at all, gets a whole snapshot.
  assert.ok("snapshot" in (await snapshot("another-bridge:3")));
  assert.equal("epoch" in (await (await request("/snapshot?projectPath=" + encodeURIComponent(project))).json()).result, false);
});

test("the phone's copy of a state keeps what didn't change, so snapshots share it", () => {
  const message = { id: 1, session_id: 1, body: "x", steps: [{ id: "s", kind: "shell", title: "Ran", status: "done", detail: "$ ls" }] };
  const session = { id: 1, subagents: [{ id: "a", transcript: [{ id: "t", text: "hi" }] }] };
  const state = { sessions: { 1: session }, messages: [message] };
  const first = forPhone({ path: "/p", state });
  const second = forPhone({ path: "/p", state: { ...state, messages: [...state.messages, { id: 2, session_id: 1, body: "y" }] } });
  assert.equal(second.state.messages[0], first.state.messages[0]);
  assert.equal(second.state.sessions[1], first.state.sessions[1]);
  assert.equal(first.state.messages[0].steps[0].hasDetail, true, "tool output is still left out");
});

test("an app that reads Chats as pages gets snapshots without messages, a Chat's messages as pages, and search", async (t) => {
  const { project, request, rpc } = await fixture(t);
  await fs.mkdir(path.join(project, ".milagre"));
  await fs.writeFile(
    path.join(project, ".milagre/coordination.json"),
    JSON.stringify({
      next_id: 20,
      projects: { 1: { id: 1, name: "project" } },
      worktrees: { 1: { id: 1, project_id: 1, path: project, name: "main" } },
      sessions: { 2: { id: 2, worktree_id: 1, agent_name: "main", status: "Created", provider: "codex", title: "Notes" } },
      messages: [
        { id: 10, session_id: 2, role: "user", body: "First note", context: null },
        { id: 11, session_id: 2, role: "assistant", body: "Second note with output", context: null },
      ],
      tasks: {},
    }),
  );
  assert.equal((await rpc("project:open", [project])).status, 200);
  const snapshot = async () =>
    (
      await (
        await request("/snapshot?projectPath=" + encodeURIComponent(project), { headers: { "x-milagre-chat-pages": "1", "x-milagre-snapshot-since": "none" } })
      ).json()
    ).result;
  const lean = await snapshot();
  const session = lean.snapshot.project.state.sessions[2];
  assert.deepEqual([lean.snapshot.project.state.messages, lean.snapshot.project.state.messagesInChats], [[], true]);
  assert.equal(lean.snapshot.project.state.sessions[session.id].summary.count, 2);
  const read = async (query) => (await (await request(`/chat-messages?projectPath=${encodeURIComponent(project)}&chatId=${session.id}${query}`)).json()).result;
  const latest = await read("&turns=1");
  assert.deepEqual(
    latest.messages.map((message) => message.body),
    ["First note", "Second note with output"],
  );
  assert.equal(latest.total, 2);
  const found = (await (await request(`/search?projectPath=${encodeURIComponent(project)}&q=${encodeURIComponent("second note")}`)).json()).result;
  assert.deepEqual(found[0].message, { id: latest.messages[1].id, session_id: session.id });
  // Without the header, the snapshot is whole, as an older app expects.
  const whole = (await (await request("/snapshot?projectPath=" + encodeURIComponent(project))).json()).result;
  assert.equal(whole.project.state.messages.length, 2);
});

// Lazy message memory (#321): the bridge holds no messages, and the host can unload a Chat's; the phone sees no change.
test("a phone reads a Chat the host unloaded: snapshots old and new, the chat list, pages, search, one message, PR refs", async (t) => {
  const { savedRows } = require("@milagre/core/message-store");
  const { daemon, dataDir, project, request, rpc } = await fixture(t, { runtimeOptions: { lazyMessages: { idleMs: 0, sweepMs: 0 } } });
  const url = "https://github.com/example/project/pull/7";
  await fs.mkdir(path.join(project, ".milagre"));
  await fs.writeFile(
    path.join(project, ".milagre/coordination.json"),
    JSON.stringify({
      next_id: 20,
      projects: { 1: { id: 1, name: "project" } },
      worktrees: { 1: { id: 1, project_id: 1, path: project, name: "main" } },
      sessions: { 2: { id: 2, worktree_id: 1, agent_name: "main", status: "Created", provider: "codex", title: "Notes" } },
      messages: [
        { id: 10, session_id: 2, role: "user", body: "Open a PR", context: null, clientMessageId: "client-10" },
        {
          id: 11,
          session_id: 2,
          role: "assistant",
          body: "Opened it, needle",
          context: null,
          outcome: "completed",
          steps: [{ id: "s1", kind: "shell", title: "Ran `gh pr create`", status: "done", detail: `$ gh pr create --fill\n${url}` }],
        },
      ],
      tasks: {},
    }),
  );
  assert.equal((await rpc("project:open", [project])).status, 200);
  const client = await connect({ dataDir });
  t.after(() => client.close());
  // Nothing leaves memory before chats.db holds it: the first save moves the messages out of coordination.json.
  const loaded = () => [...savedRows(project).values()].some((row) => row.chat === 2);
  await daemon.unloadIdle();
  assert.equal(savedRows(project), null, "no rows saved yet, so nothing was unloaded");
  await client.call("chat:patch", [project, 2, { title: "Notes again" }]);
  await client.call("daemon:flush");
  assert.equal(loaded(), true);
  await daemon.unloadIdle();
  assert.equal(loaded(), false, "the Chat left the host's memory");
  const json = async (route, headers = {}) => (await (await request(route, { headers })).json()).result;
  const at = encodeURIComponent(project);

  // An older app's snapshot has every message, as it had them, and no "read by Chat" flag.
  const older = await json(`/snapshot?projectPath=${at}`);
  assert.deepEqual(
    older.project.state.messages.map((message) => [message.id, message.body]),
    [
      [10, "Open a PR"],
      [11, "Opened it, needle"],
    ],
  );
  assert.equal(older.project.state.messagesInChats, undefined);
  assert.deepEqual(older.project.pullRequestRefs, { 2: [url] });
  // The bridge holds lean states, yet phones still get the Project's path and name, which key it on the phone.
  assert.deepEqual([older.project.path, older.project.name], [project, path.basename(project)]);
  // The chat list: each Chat's boundary messages and send identities, without bodies.
  const list = await json(`/snapshot?projectPath=${at}&view=chats`);
  assert.deepEqual(
    list.project.state.messages.map(({ id, role, body, clientMessageId }) => [id, role, body, clientMessageId]),
    [
      [10, "user", "", "client-10"],
      [11, "assistant", "", undefined],
    ],
  );
  assert.deepEqual(list.project.pullRequestRefs, { 2: [url] });
  // An app that reads pages: no messages in the snapshot, the PR refs from the Chat's summary.
  const paged = await json(`/snapshot?projectPath=${at}`, { "x-milagre-chat-pages": "1" });
  assert.deepEqual(paged.project.state.messages, []);
  assert.deepEqual([list.project.path, paged.project.path, paged.project.name], [project, project, path.basename(project)]);
  assert.deepEqual(paged.project.pullRequestRefs, { 2: [url] });
  const found = await json(`/search?projectPath=${at}&q=needle`);
  assert.deepEqual(found[0].message, { id: 11, session_id: 2 });
  const one = await json(`/message?projectPath=${at}&id=11`);
  assert.equal(one.steps[0].detail, `$ gh pr create --fill\n${url}`);
  assert.equal(loaded(), false, "none of that loaded it");
  const page = await json(`/chat-messages?projectPath=${at}&chatId=2&turns=5`);
  assert.deepEqual(
    page.messages.map((message) => message.id),
    [10, 11],
  );
  assert.equal(loaded(), true, "reading its page did");
});

test("a phone snapshot's Chats and messages come from one state, even when a Chat goes while the bridge reads", async (t) => {
  // A bridge whose host connection runs a change just before each read of every message: the Worktree of one Chat
  // goes away in between, so a bridge that put fresh messages into the state it held would mix the two.
  const clientModule = require("./client.cjs");
  const realConnect = clientModule.connect;
  let beforeRead = async () => {};
  clientModule.connect = async (options) => {
    const connection = await realConnect(options);
    const call = connection.call.bind(connection);
    connection.call = async (method, args) => {
      if (method === "chat:all-messages") await beforeRead();
      return call(method, args);
    };
    return connection;
  };
  const bridgePath = require.resolve("./mobile-bridge.cjs");
  const kept = require.cache[bridgePath];
  delete require.cache[bridgePath];
  const { startMobileBridge: startRacingBridge } = require("./mobile-bridge.cjs");
  require.cache[bridgePath] = kept;
  clientModule.connect = realConnect;
  t.after(() => {
    clientModule.connect = realConnect;
  });

  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-mobile-race-")));
  const dataDir = path.join(root, "profile");
  const project = path.join(root, "project");
  const side = path.join(root, "side");
  await fs.mkdir(project);
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-C", project, ...args], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  git("commit", "-q", "--allow-empty", "-m", "start");
  git("worktree", "add", "-q", "-b", "side", side);
  const daemon = await startDaemon({
    dataDir,
    version: "test",
    runtimeOptions: {
      environmentReady: Promise.resolve(),
      titleModels: {},
      worktreeRoot: path.join(root, "worktrees"),
      agentCli: Object.assign(async () => ({ command: null, problem: "Test has no provider" }), { invalidate() {} }),
    },
  });
  const token = randomBytes(32).toString("hex");
  const bridge = await startRacingBridge({ dataDir, port: 0, token });
  const host = await connect({ dataDir });
  t.after(async () => {
    host.close();
    await bridge.close();
    await daemon.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const opened = await host.call("project:open", [project]);
  const sideChat = Object.values(opened.state.sessions).find((session) => opened.state.worktrees[session.worktree_id]?.path === side);
  const mainChat = Object.values(opened.state.sessions).find((session) => session !== sideChat);
  await host.call("chat:git-note", [`${project}#${sideChat.id}`, "On the side"]);
  await host.call("chat:git-note", [`${project}#${mainChat.id}`, "On main"]);
  await host.call("daemon:flush");
  const json = async (route) => (await (await fetch(bridge.url + route, { headers: { authorization: `Bearer ${token}` } })).json()).result;
  const at = encodeURIComponent(project);
  // The bridge holds the state now, with both Chats.
  const before = await json(`/snapshot?projectPath=${at}`);
  assert.ok(before.project.state.sessions[sideChat.id]);
  const consistent = (state) => {
    for (const message of state.messages) assert.ok(state.sessions[message.session_id], `message ${message.id} has its Chat`);
    for (const [id, session] of Object.entries(state.sessions))
      if (session.summary?.count)
        assert.ok(
          state.messages.some((message) => String(message.session_id) === id),
          `Chat ${id} has its messages`,
        );
  };
  let removed = false;
  beforeRead = async () => {
    if (removed) return;
    removed = true;
    git("worktree", "remove", "--force", side);
    await host.call("project:open", [project]);
  };
  consistent((await json(`/snapshot?projectPath=${at}`)).project.state);
  // The same for the chat list: the Worktree comes back with a Chat that has a message, and goes again mid-read.
  git("worktree", "add", "-q", side, "side");
  const reopened = await host.call("project:open", [project]);
  const again = Object.values(reopened.state.sessions).find((session) => reopened.state.worktrees[session.worktree_id]?.path === side);
  await host.call("chat:git-note", [`${project}#${again.id}`, "Back on the side"]);
  await host.call("daemon:flush");
  assert.ok((await json(`/snapshot?projectPath=${at}`)).project.state.sessions[again.id]);
  removed = false;
  consistent((await json(`/snapshot?projectPath=${at}&view=chats`)).project.state);
  assert.equal(removed, true, "the Worktree went during the chat list's read");
});
