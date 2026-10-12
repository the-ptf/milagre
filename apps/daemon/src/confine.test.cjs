const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { WebSocket } = require("ws");
const { startDaemon } = require("./server.cjs");
const { startMobileBridge, METHODS } = require("./mobile-bridge.cjs");
const { connect } = require("./client.cjs");
const { PATHS, REFUSED, MCP_REFUSED, NOTIFICATIONS_OFF, TOO_LONG, MAX_BODY, createConfinement } = require("./confine.cjs");
const { demoRuntimeOptions, DEMO_MODEL, NO_PULL_REQUESTS } = require("./demo-agent.cjs");

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("pretend image data")]);
const repo = (folder) => {
  execFileSync("git", ["init", "-b", "main", folder], { stdio: "ignore" });
  execFileSync("git", ["-C", folder, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Initial"], {
    stdio: "ignore",
  });
};

/**
 * A demo daemon with two projects: the allowed one (`demo`, inside `root`) and one outside it (`outside`), which the
 * owner's side opened first so it is in the recent list and its chats exist. A symlink inside the demo leads out.
 */
async function fixture(t, { allowedRoot = true, runtime = (options) => options, bridgeOptions = {} } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-confine-")));
  const dataDir = path.join(root, "profile");
  const demo = path.join(root, "demo");
  const outside = path.join(root, "outside");
  await fs.mkdir(demo);
  await fs.mkdir(outside);
  repo(demo);
  repo(outside);
  await fs.writeFile(path.join(outside, "secret.png"), PNG);
  await fs.writeFile(path.join(demo, "shot.png"), PNG);
  await fs.symlink(outside, path.join(demo, "link-out"));
  const daemon = await startDaemon({
    dataDir,
    version: "test",
    runtimeOptions: runtime(demoRuntimeOptions({ cwd: demo, worktreeRoot: path.join(demo, ".milagre", "worktrees") })),
  });
  const owner = await connect({ dataDir });
  await owner.call("project:open", [outside]);
  const token = randomBytes(32).toString("hex");
  const confinedTo = typeof allowedRoot === "function" ? allowedRoot({ demo, outside }) : allowedRoot ? demo : undefined;
  const bridge = await startMobileBridge({ dataDir, port: 0, token, ...(confinedTo ? { allowedRoot: confinedTo } : {}), ...bridgeOptions });
  t.after(async () => {
    owner.close();
    await bridge.close();
    await daemon.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const request = (route, options = {}) => fetch(bridge.url + route, { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers } });
  const rpc = async (method, args = []) => {
    const response = await request("/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ v: 1, method, args }) });
    return { status: response.status, body: await response.json() };
  };
  const live = (projectPath) =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(`${bridge.url.replace(/^http/, "ws")}/live?projectPath=${encodeURIComponent(projectPath)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      socket.once("open", () => {
        socket.close();
        resolve(101);
      });
      socket.once("unexpected-response", (_req, res) => {
        res.resume();
        resolve(res.statusCode);
      });
      socket.once("error", reject);
    });
  return { root, dataDir, demo, outside, owner, bridge, request, rpc, live };
}

const refusedBody = { v: 1, error: { message: REFUSED } };

test("a confined inbox excludes Chats and requests from other Projects in HTTP and RPC", async (t) => {
  const f = await fixture(t);
  for (const projectPath of [f.demo, f.outside]) {
    const opened = await f.owner.call("project:open", [projectPath]);
    const worktreeId = Object.values(opened.state.worktrees)[0].id;
    await f.owner.call("chat:send", [{ projectPath, worktreeId, body: "question", provider: "codex", model: "demo", permissionMode: "ask" }]);
  }
  let inbox;
  for (let i = 0; i < 100; i++) {
    inbox = await f.owner.call("chat:inbox");
    if (inbox.items.filter((item) => item.status === "question").length === 2) break;
    await delay(20);
  }
  assert.equal(inbox.items.length, 2);
  const http = (await (await f.request("/inbox")).json()).result;
  const rpc = (await f.rpc("chat:inbox")).body.result;
  for (const snapshot of [http, rpc]) {
    assert.equal(snapshot.items.length, 1);
    assert.equal(snapshot.agents.length, 1);
    assert.equal(snapshot.items[0].projectPath, f.demo);
    assert.equal(JSON.stringify(snapshot).includes(f.outside), false);
  }
});

// Every command the phone may call that names a path, with that path pointing at `target`.
const callsAt = (target, demo) => [
  ["project:open", [target]],
  ["project:branches", [target]],
  ["linear:worktree-issues", [target]],
  ["skills:list", [target]],
  ["skills:read", [target, path.join(target, "SKILL.md")]],
  ["chat:send", [{ projectPath: target, sessionId: 1, body: "hi", provider: "codex", model: "demo", permissionMode: "ask" }]],
  ["chat:send", [{ projectPath: demo, cwd: target, sessionId: 1, body: "hi", provider: "codex", model: "demo", permissionMode: "ask" }]],
  [
    "chat:send",
    [{ projectPath: demo, sessionId: 1, body: "hi", files: [path.join(target, "secret.png")], provider: "codex", model: "demo", permissionMode: "ask" }],
  ],
  ["chat:resume", [target, 1]],
  ["chat:patch", [target, 1, { title: "Renamed" }]],
  ["chat:archive-subagent", [target, 1, "child", true]],
  ["chat:archive-finished-subagents", [target, 1]],
  ["agent:interrupt", [`${target}#1`]],
  ["agent:respond-permission", [{ chatId: `${target}#1`, requestId: "x", decision: "allow" }]],
  ["agent:answer-question", [{ chatId: `${target}#1`, requestId: "x", answers: { next: ["A"] }, summary: "A" }]],
  ["agent:set-permission-mode", [{ chatId: `${target}#1`, mode: "auto" }]],
  ["worktree:pull-request", [target]],
  ["worktree:pull-requests", [target, ["246"]]],
  ["worktree:create", [{ projectPath: target, baseBranch: "main", prompt: "Escape" }]],
  ["worktree:link-issue", [{ projectPath: target, worktreeId: 1, key: "ENG-1" }]],
  ["worktree:unlink-issue", [{ projectPath: target, worktreeId: 1 }]],
  ["git:diff-files", [{ cwd: target, mode: "uncommitted" }]],
  ["git:diff-file", [{ cwd: target, mode: "uncommitted", path: "secret.png" }]],
  ["worktree:status", [target, "main"]],
  ["worktree:remove", [target, { force: true, base: "main", projectPath: demo, chatId: `${demo}#1`, seen: null }]],
  ["worktree:remove", [demo, { force: true, base: "main", projectPath: target, chatId: `${demo}#1`, seen: null }]],
  ["worktree:remove", [demo, { force: true, base: "main", projectPath: demo, chatId: `${target}#1`, seen: null }]],
];
const routesAt = (target, demo) => [
  `/snapshot?projectPath=${encodeURIComponent(target)}`,
  `/runs?projectPath=${encodeURIComponent(target)}`,
  `/message?projectPath=${encodeURIComponent(target)}&id=1`,
  `/media?projectPath=${encodeURIComponent(target)}&path=${encodeURIComponent(path.join(target, "secret.png"))}`,
  `/media?projectPath=${encodeURIComponent(demo)}&path=${encodeURIComponent(path.join(target, "secret.png"))}`,
];

async function assertRefusedEverywhere({ rpc, request, live, demo }, target) {
  for (const [method, args] of callsAt(target, demo)) {
    const { status, body } = await rpc(method, args);
    assert.equal(status, 403, `${method} ${JSON.stringify(args)} must be refused`);
    assert.deepEqual(body, refusedBody, method);
  }
  for (const route of routesAt(target, demo)) {
    const response = await request(route);
    assert.equal(response.status, 403, route);
    assert.deepEqual(await response.json(), refusedBody, route);
  }
  const upload = await request("/attachments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectPath: target, name: "a.txt", base64: Buffer.from("hi").toString("base64") }),
  });
  assert.equal(upload.status, 403);
  assert.equal(await live(target), 403);
}

test("a confined skill catalog excludes user skills, outside symlinks and warning paths", async (t) => {
  const f = await fixture(t);
  const insideFile = path.join(f.demo, "SKILL.md");
  const outsideFile = path.join(f.outside, "SKILL.md");
  await fs.writeFile(insideFile, "A local skill");
  await fs.writeFile(outsideFile, "An outside skill");
  const linkedFile = path.join(f.demo, "linked-SKILL.md");
  await fs.symlink(outsideFile, linkedFile);
  const confine = createConfinement({ allowedRoot: f.demo });
  const result = await confine.filterResult("skills:list", {
    skills: [
      { name: "local", description: "Local", path: insideFile, scope: "workspace", provider: "agents" },
      { name: "outside", description: "Private", path: outsideFile, scope: "workspace", provider: "agents" },
      { name: "linked", description: "Private", path: linkedFile, scope: "workspace", provider: "agents" },
      { name: "user", description: "Private", path: insideFile, scope: "user", provider: "agents" },
      { name: "bundled", description: "Public", path: "/app/internal/SKILL.md", scope: "bundled", provider: "milagre" },
    ],
    warnings: ["Cannot read /private/skill"],
  });
  assert.deepEqual(
    result.skills.map((skill) => skill.name),
    ["local", "bundled"],
  );
  assert.equal(result.skills[1].path, "");
  assert.deepEqual(result.warnings, []);
});

test("every command the phone may call has a confinement rule, and no rule names a command it may not call", () => {
  assert.deepEqual([...METHODS].sort(), Object.keys(PATHS).sort());
});

test("a confined bridge refuses a path outside its folder on every path-taking command and route", async (t) => {
  const f = await fixture(t);
  await f.rpc("project:open", [f.demo]);
  await assertRefusedEverywhere(f, f.outside);
  await assertRefusedEverywhere(f, "/");
  await assertRefusedEverywhere(f, os.homedir());
  // Nothing the refused calls asked for happened: the outside project kept its name.
  const outsideState = await f.owner.call("project:snapshot", [f.outside]);
  assert.ok(Object.values(outsideState.state.sessions).every((session) => session.title !== "Renamed"));
});

test(".. and symlinks cannot lead out of the folder", async (t) => {
  const f = await fixture(t);
  await f.rpc("project:open", [f.demo]);
  // Raw strings, so the `..` reaches the bridge as sent.
  await assertRefusedEverywhere(f, `${f.demo}/../outside`);
  await assertRefusedEverywhere(f, `${f.demo}/./../outside`);
  await assertRefusedEverywhere(f, path.join(f.demo, "link-out"));
  await assertRefusedEverywhere(f, `${f.demo}/link-out/../outside`);
  // A sibling whose name starts with the folder's is not inside it.
  await fs.mkdir(`${f.demo}-evil`);
  assert.equal((await f.rpc("project:open", [`${f.demo}-evil`])).status, 403);
  // Relative, missing and malformed paths are refused too.
  for (const target of ["demo", path.join(f.demo, "missing", "..", "..", "outside"), path.join(f.root, "missing"), null, 42, { path: f.demo }]) {
    assert.equal((await f.rpc("project:open", [target])).status, 403, JSON.stringify(target));
  }
  assert.equal((await f.request("/snapshot")).status, 403);
  assert.equal((await f.rpc("agent:interrupt", [42])).status, 403);
});

test("inside the folder the phone browses, reads changes, sends and sees images; recent lists only the demo", async (t) => {
  const f = await fixture(t);
  const confine = createConfinement({ allowedRoot: f.demo });
  for (const [method, args] of [
    ["chat:archive-subagent", [f.demo, 1, "child", true]],
    ["chat:archive-finished-subagents", [f.demo, 1]],
  ]) {
    assert.deepEqual((await confine.checkCall(method, args)).args, args);
  }
  const recentBefore = await f.owner.call("project:recent");
  assert.ok(
    recentBefore.some((entry) => entry.path === f.outside),
    "the owner side sees the other project",
  );
  assert.equal((await f.rpc("project:open", [f.demo])).status, 200);
  const recent = (await f.rpc("project:recent")).body.result;
  assert.deepEqual(
    recent.map((entry) => entry.path),
    [f.demo],
  );
  const snapshot = await (await f.request(`/snapshot?projectPath=${encodeURIComponent(f.demo)}`)).json();
  const chat = Object.values(snapshot.result.project.state.sessions)[0];
  assert.equal((await f.rpc("git:diff-files", [{ cwd: f.demo, mode: "uncommitted" }])).status, 200);
  assert.equal((await f.rpc("project:branches", [f.demo])).status, 200);
  assert.equal((await f.rpc("linear:worktree-issues", [f.demo])).status, 200);
  assert.equal((await f.rpc("chat:patch", [f.demo, chat.id, { title: "Inside" }])).status, 200);
  assert.equal((await f.request(`/media?projectPath=${encodeURIComponent(f.demo)}&path=${encodeURIComponent(path.join(f.demo, "shot.png"))}`)).status, 200);
  assert.equal(await f.live(f.demo), 101);
  // An upload stays the phone's own: it may be attached and shown, but not the files of another project.
  const upload = await (
    await f.request("/attachments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectPath: f.demo, name: "photo.png", base64: PNG.toString("base64") }),
    })
  ).json();
  assert.equal((await f.request(`/media?projectPath=${encodeURIComponent(f.demo)}&path=${encodeURIComponent(upload.result.path)}`)).status, 200);
  const sent = await f.rpc("chat:send", [
    {
      projectPath: f.demo,
      sessionId: chat.id,
      body: "hello",
      files: [upload.result.path, path.join(f.demo, "shot.png")],
      provider: "claude",
      model: "claude-opus-5-5",
      permissionMode: "ask",
    },
  ]);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const chatId = `${f.demo}#${chat.id}`;
  for (let i = 0; i < 200; i++) {
    const state = (await (await f.request(`/snapshot?projectPath=${encodeURIComponent(f.demo)}`)).json()).result;
    if (!state.runs.runs[chatId] && state.project.state.messages.some((message) => /scripted|Demo agent/.test(message.body ?? ""))) break;
    assert.ok(i < 199, "the demo agent answered");
    await delay(20);
  }
  // The turns of other projects are not listed either.
  const runs = (await f.rpc("chat:runs")).body.result;
  assert.ok(Object.keys(runs.runs).every((key) => key.startsWith(`${f.demo}#`)));
  // A worktree the phone creates lands inside the folder and is usable.
  const created = await f.rpc("worktree:create", [{ projectPath: f.demo, baseBranch: "main", prompt: "Try a worktree" }]);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const worktree = created.body.result.project.state.worktrees[created.body.result.worktreeId].path;
  assert.ok(worktree.startsWith(f.demo + path.sep));
  assert.equal((await f.rpc("git:diff-files", [{ cwd: worktree, mode: "uncommitted" }])).status, 200);
});

test("a confined phone archives with the worktree check: roots inside the folder only, status, and removal", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.rpc("project:open", [f.demo])).status, 200);
  const created = await f.rpc("worktree:create", [{ projectPath: f.demo, baseBranch: "main", prompt: "Archive me" }]);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const { project, worktreeId } = created.body.result;
  const worktree = project.state.worktrees[worktreeId];
  const chat = Object.values(project.state.sessions).find((session) => session.worktree_id === worktreeId);
  // Only the canonical root inside the folder comes back; the owner's side gets every root.
  const roots = (await f.rpc("worktree:roots")).body.result;
  assert.deepEqual(roots, [path.join(f.demo, ".milagre", "worktrees")]);
  assert.ok(worktree.path.startsWith(roots[0] + path.sep));
  const status = await f.rpc("worktree:status", [worktree.path, worktree.base]);
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(status.body.result.removable, true);
  const removed = await f.rpc("worktree:remove", [
    worktree.path,
    { force: false, base: worktree.base, projectPath: f.demo, chatId: `${f.demo}#${chat.id}`, seen: status.body.result },
  ]);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  await assert.rejects(fs.stat(worktree.path), { code: "ENOENT" });
});

test("a confined phone gets no worktree root outside its folder", async (t) => {
  const f = await fixture(t, { runtime: (options) => ({ ...options, worktreeRoot: path.join(path.dirname(options.cwd), "elsewhere") }) });
  await fs.mkdir(path.join(f.root, "elsewhere"));
  assert.deepEqual((await f.rpc("worktree:roots")).body.result, []);
  assert.equal((await f.owner.call("worktree:roots")).length > 0, true);
});

test("the demo daemon reports only the demo agent, whichever provider the phone picks", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.rpc("agent:models")).body.result, { codex: [DEMO_MODEL], claude: null, antigravity: null });
  const status = (await f.rpc("agent:cli-status")).body.result;
  assert.deepEqual(status.codex, { state: "ready" });
  assert.equal(status.claude.state, "missing");
  assert.deepEqual((await f.rpc("usage:read")).body.result, { providers: [] });
});

test("without allowedRoot the bridge opens any folder, as before", async (t) => {
  const f = await fixture(t, { allowedRoot: false });
  assert.equal((await f.rpc("project:open", [f.outside])).status, 200);
  assert.equal((await f.rpc("project:open", [f.demo])).status, 200);
  assert.deepEqual((await f.rpc("project:recent")).body.result.map((entry) => entry.path).sort(), [f.demo, f.outside].sort());
  assert.equal((await f.request(`/snapshot?projectPath=${encodeURIComponent(f.outside)}`)).status, 200);
  assert.equal((await f.rpc("git:diff-files", [{ cwd: f.outside, mode: "uncommitted" }])).status, 200);
  assert.equal(await f.live(f.outside), 101);
  // Unchanged errors too: a project that is not open is a 409 from the daemon, not a 403.
  assert.equal((await f.request(`/snapshot?projectPath=${encodeURIComponent(path.join(f.root, "nowhere"))}`)).status, 409);
});

test("a confinement needs an absolute folder that exists, and refuses commands it has no rule for", async () => {
  assert.throws(() => createConfinement({ allowedRoot: "relative" }), /absolute/);
  await assert.rejects(createConfinement({ allowedRoot: path.join(os.tmpdir(), `missing-${randomBytes(4).toString("hex")}`) }).root(), /does not exist/);
  const confine = createConfinement({ allowedRoot: os.tmpdir() });
  await assert.rejects(confine.checkCall("worktree:remove", [os.tmpdir()]), { status: 403, message: REFUSED });
  await assert.rejects(confine.checkCall("project:open", "not an array"), { status: 403 });
});

test("a confined path must already be canonical, even inside the folder", async (t) => {
  const f = await fixture(t);
  for (const target of [`${f.demo}/`, `${f.demo}/.`, `${f.demo}/.milagre/..`, `${f.demo}//`]) {
    assert.equal((await f.rpc("project:open", [target])).status, 403, target);
    assert.equal((await f.request(`/snapshot?projectPath=${encodeURIComponent(target)}`)).status, 403, target);
  }
  assert.equal((await f.rpc("project:open", [f.demo])).status, 200);
});

test("a project:open that resolves outside the folder is refused", async (t) => {
  // The folder is a subfolder of a repository: opening it opens the whole repository, which is not inside.
  const f = await fixture(t, {
    allowedRoot: ({ outside }) => {
      require("node:fs").mkdirSync(path.join(outside, "sub"));
      return path.join(outside, "sub");
    },
  });
  assert.deepEqual((await f.rpc("project:open", [path.join(f.outside, "sub")])).body, refusedBody);
  assert.equal((await f.request(`/snapshot?projectPath=${encodeURIComponent(f.outside)}`)).status, 403);
});

test("daemon:status says nothing about the Mac to a confined phone", async (t) => {
  const f = await fixture(t);
  const status = (await f.rpc("daemon:status")).body.result;
  for (const key of ["dataDir", "socketPath", "pid", "uid", "methods"]) assert.equal(key in status, false, key);
  assert.equal(status.version, "test");
  const open = await fixture(t, { allowedRoot: false });
  const full = (await open.rpc("daemon:status")).body.result;
  assert.equal(full.dataDir, open.dataDir);
  assert.ok(Array.isArray(full.methods));
});

test("a confined phone cannot register for push, and unregister and focus never reach the daemon", async (t) => {
  const f = await fixture(t);
  const device = { deviceId: "a".repeat(32), token: "ExponentPushToken[abcdefghijklmnop]", platform: "ios" };
  assert.deepEqual(await f.rpc("push:register", [device]), { status: 403, body: { v: 1, error: { message: NOTIFICATIONS_OFF } } });
  assert.deepEqual((await f.rpc("push:unregister", [{ deviceId: device.deviceId }])).body.result, { registered: false });
  for (let i = 0; i < 20; i++) assert.equal((await f.rpc("push:focus", [{ deviceId: `device-${i}`, chatId: `/anywhere/${i}#1` }])).body.result, null);
  await assert.rejects(fs.stat(path.join(f.dataDir, "mobile-push.json")), { code: "ENOENT" });
});

test("uploads stop at the quota with a 507, and a long message is refused", async (t) => {
  const f = await fixture(t, { bridgeOptions: { attachmentQuota: 1000 } });
  await f.rpc("project:open", [f.demo]);
  const upload = (bytes) =>
    f.request("/attachments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectPath: f.demo, name: "a.bin", base64: Buffer.alloc(bytes, 1).toString("base64") }),
    });
  assert.equal((await upload(600)).status, 200);
  // Two at once cannot both take the 400 bytes left.
  const [one, two] = await Promise.all([upload(300), upload(300)]);
  assert.deepEqual([one.status, two.status].sort(), [200, 507]);
  const full = await upload(200);
  assert.equal(full.status, 507);
  assert.deepEqual(await full.json(), { v: 1, error: { message: "This demo computer is full." } });
  assert.equal((await upload(100)).status, 200, "what still fits is taken");
  // A new bridge counts what is already there.
  const token = "b".repeat(64);
  const again = await startMobileBridge({ dataDir: f.dataDir, port: 0, token, allowedRoot: f.demo, attachmentQuota: 1000 });
  t.after(() => again.close());
  const retry = await fetch(`${again.url}/attachments`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ projectPath: f.demo, name: "a.bin", base64: Buffer.alloc(10, 1).toString("base64") }),
  });
  assert.equal(retry.status, 507);

  const chat = Object.values((await (await f.request(`/snapshot?projectPath=${encodeURIComponent(f.demo)}`)).json()).result.project.state.sessions)[0];
  const send = (body) => f.rpc("chat:send", [{ projectPath: f.demo, sessionId: chat.id, body, provider: "codex", model: "demo", permissionMode: "ask" }]);
  assert.deepEqual(await send("é".repeat(MAX_BODY / 2 + 1)), { status: 413, body: { v: 1, error: { message: TOO_LONG } } });
  assert.equal((await send("x".repeat(MAX_BODY))).status, 200);
});

test("without allowedRoot uploads have no quota and push registers as before", async (t) => {
  const f = await fixture(t, { allowedRoot: false, bridgeOptions: { attachmentQuota: 10 } });
  await f.rpc("project:open", [f.demo]);
  const upload = await f.request("/attachments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectPath: f.demo, name: "a.bin", base64: Buffer.alloc(100, 1).toString("base64") }),
  });
  assert.equal(upload.status, 200);
  assert.equal(
    (
      await f.rpc("push:register", [
        {
          deviceId: "b6e2df4b-972b-4e7b-bc65-6cda0a173798",
          token: "ExpoPushToken[test]",
          hostId: f.bridge.url,
          notifyWhenWaiting: true,
          notifyOnCompletion: true,
        },
      ])
    ).status,
    200,
  );
});

test("chat:send files must be a list of allowed paths, and images lose any Mac path", async (t) => {
  const f = await fixture(t);
  await f.rpc("project:open", [f.demo]);
  const chat = Object.values((await (await f.request(`/snapshot?projectPath=${encodeURIComponent(f.demo)}`)).json()).result.project.state.sessions)[0];
  const send = (extra) =>
    f.rpc("chat:send", [{ projectPath: f.demo, sessionId: chat.id, body: "look", provider: "codex", model: "demo", permissionMode: "ask", ...extra }]);
  for (const files of [path.join(f.outside, "secret.png"), { 0: path.join(f.outside, "secret.png") }, "x"])
    assert.equal((await send({ files })).status, 400, JSON.stringify(files));
  assert.equal((await send({ files: [path.join(f.outside, "secret.png")] })).status, 403);
  assert.equal((await send({ files: [42] })).status, 403);
  assert.equal((await send({ images: "not a list" })).status, 400);
  const dataUrl = `data:image/png;base64,${PNG.toString("base64")}`;
  assert.equal((await send({ images: [{ dataUrl, path: path.join(f.outside, "secret.png"), sourcePath: "/etc/hosts", name: "shot.png" }] })).status, 200);
  const state = await f.owner.call("project:snapshot", [f.demo]);
  const image = state.state.messages.findLast((message) => message.images?.length).images[0];
  assert.equal(image.sourcePath, undefined);
  assert.ok(image.path.startsWith(f.demo + path.sep), image.path);
});

test("the demo sends /skill as typed and never asks gh about pull requests", async (t) => {
  const prompts = [];
  const record = (options) => ({
    ...options,
    createSession: (provider, session) => {
      const created = options.createSession(provider, session);
      const start = created.startTurn;
      created.startTurn = (turn) => {
        prompts.push(turn.prompt);
        return start(turn);
      };
      return created;
    },
  });
  for (const expandSkills of [false, true]) {
    prompts.length = 0;
    const f = await fixture(t, { runtime: (options) => ({ ...record(options), ...(expandSkills ? { expandSkills } : {}) }) });
    await fs.mkdir(path.join(f.demo, ".claude", "skills", "some-skill"), { recursive: true });
    await fs.writeFile(
      path.join(f.demo, ".claude", "skills", "some-skill", "SKILL.md"),
      "---\nname: some-skill\ndescription: Private\n---\nPRIVATE SKILL TEXT\n",
    );
    await f.rpc("project:open", [f.demo]);
    const chat = Object.values((await (await f.request(`/snapshot?projectPath=${encodeURIComponent(f.demo)}`)).json()).result.project.state.sessions)[0];
    assert.equal(
      (
        await f.rpc("chat:send", [
          { projectPath: f.demo, sessionId: chat.id, body: "/some-skill approval", provider: "codex", model: "demo", permissionMode: "ask" },
        ])
      ).status,
      200,
    );
    for (let i = 0; !prompts.length; i++) {
      assert.ok(i < 200, "the turn started");
      await delay(20);
    }
    if (expandSkills) assert.match(prompts[0], /PRIVATE SKILL TEXT/, "the control: a runtime that expands skills");
    else assert.equal(prompts[0], "/some-skill approval");
    await f.rpc("agent:interrupt", [`${f.demo}#${chat.id}`]);
    if (!expandSkills) {
      const blocked = { status: 409, body: { v: 1, error: { message: NO_PULL_REQUESTS } } };
      assert.deepEqual(await f.rpc("worktree:pull-request", [f.demo]), blocked);
      assert.deepEqual(await f.rpc("worktree:pull-requests", [f.demo, ["246"]]), blocked);
    }
  }
});

test("a confined phone still gets streaming turns slimmed, on /runs and /snapshot", async (t) => {
  // A turn that ran ten tools with long output and is still going.
  const busy = (_provider, { emit }) => {
    const session = {
      closed: false,
      turnActive: false,
      nativeId: "busy",
      async startTurn() {
        session.turnActive = true;
        emit({ type: "session-started", nativeId: "busy" });
        emit({ type: "turn-started", turnId: "busy-1" });
        for (let i = 0; i < 10; i++) {
          emit({ type: "step-started", step: { id: `s${i}`, kind: "shell", title: `Step ${i}`, detail: "x".repeat(5000) } });
          emit({ type: "step-completed", id: `s${i}`, status: "done", detail: "x".repeat(5000) });
        }
        return { turnId: "busy-1" };
      },
      async interrupt() {
        if (session.turnActive) emit({ type: "turn-cancelled" });
        session.turnActive = false;
      },
      async close() {
        await session.interrupt();
        session.closed = true;
      },
    };
    return session;
  };
  const f = await fixture(t, { runtime: (options) => ({ ...options, createSession: busy }) });
  await f.rpc("project:open", [f.demo]);
  const chat = Object.values((await (await f.request(`/snapshot?projectPath=${encodeURIComponent(f.demo)}`)).json()).result.project.state.sessions)[0];
  const chatId = `${f.demo}#${chat.id}`;
  assert.equal(
    (await f.rpc("chat:send", [{ projectPath: f.demo, sessionId: chat.id, body: "go", provider: "codex", model: "demo", permissionMode: "ask" }])).status,
    200,
  );
  let steps;
  for (let i = 0; steps?.length !== 10; i++) {
    assert.ok(i < 200, "the turn streamed its steps");
    steps = (await (await f.request(`/runs?projectPath=${encodeURIComponent(f.demo)}`)).json()).result.runs[chatId]?.steps;
    await delay(20);
  }
  for (const route of [`/runs?projectPath=${encodeURIComponent(f.demo)}`, `/snapshot?projectPath=${encodeURIComponent(f.demo)}`]) {
    const body = (await (await f.request(route)).json()).result;
    const run = (body.runs.runs ?? body.runs)[chatId];
    assert.equal(run.steps[0].detail, undefined, route);
    assert.equal(run.steps[0].hasDetail, true, route);
    assert.ok(run.steps.at(-1).detail.length <= 4097, route);
  }
  await f.rpc("agent:interrupt", [chatId]);
});

test("the project search lists only repositories inside the folder, and a Project icon only for one inside", async (t) => {
  const f = await fixture(t, { runtime: (options) => ({ ...options, projectSearchRoot: path.dirname(options.cwd) }) });
  const found = await f.rpc("project:find", [""]);
  assert.equal(found.status, 200);
  assert.deepEqual(
    found.body.result.map((entry) => entry.path),
    [f.demo],
    "the outside repository stays hidden",
  );
  assert.equal(
    (await f.owner.call("project:find", [""])).some((entry) => entry.path === f.outside),
    true,
    "the owner side sees both",
  );
  assert.equal((await f.rpc("project:open", [f.demo])).status, 200);
  assert.equal((await f.rpc("project:image", [f.demo])).status, 200);
  assert.equal((await f.rpc("project:image", [f.outside])).status, 403);
});

test("a confined bridge refuses phone:routes even when it has the hook", async (t) => {
  const f = await fixture(t, { bridgeOptions: { phoneRoutes: async () => ({ hostId: "h", key: "k", lan: [] }) } });
  assert.equal((await f.rpc("phone:routes", [{ phoneKey: "p".repeat(43) }])).status, 403);
});

// The global default reaches every Project on the Mac, so a demo-confined phone can read it but not change it.
test("a confined phone reads the main sync default but can't change it", async () => {
  const confine = createConfinement({ allowedRoot: os.tmpdir() });
  await confine.checkCall("main-sync:default:read", []);
  await assert.rejects(confine.checkCall("main-sync:default:save", [true]), { status: 403, message: REFUSED });
});

// Linear is the Mac's connection: a confined phone sees whether it is on and connected, and changes nothing.
test("a confined phone reads Linear status and the switch but can't change it", async () => {
  const confine = createConfinement({ allowedRoot: os.tmpdir() });
  await confine.checkCall("linear:status", []);
  await confine.checkCall("linear:enabled:read", []);
  await assert.rejects(confine.checkCall("linear:enabled:save", [true]), { status: 403, message: REFUSED });
  await assert.rejects(confine.checkCall("linear:move-to-started:save", [true]), { status: 403, message: REFUSED });
});

test("a confined phone reads Linear issues, and only its own Project's worktree issues", async () => {
  const confine = createConfinement({ allowedRoot: os.tmpdir() });
  await confine.checkCall("linear:issues", [{ query: "ENG" }]);
  await assert.rejects(confine.checkCall("linear:worktree-issues", ["/not/a/project"]), { status: 403, message: REFUSED });
});

test("a confined phone links and unlinks an issue only in its own Project", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.rpc("project:open", [f.demo])).status, 200);
  // Linear is off in this fixture, so the call reaches the daemon and fails there: never refused by the confinement.
  const link = await f.rpc("worktree:link-issue", [{ projectPath: f.demo, worktreeId: 1, key: "ENG-1" }]);
  assert.notEqual(link.status, 403, JSON.stringify(link.body));
  const unlink = await f.rpc("worktree:unlink-issue", [{ projectPath: f.demo, worktreeId: 1 }]);
  assert.notEqual(unlink.status, 403, JSON.stringify(unlink.body));
  assert.equal((await f.rpc("worktree:link-issue", [{ projectPath: f.outside, worktreeId: 1, key: "ENG-1" }])).status, 403);
  assert.equal((await f.rpc("worktree:unlink-issue", [{ projectPath: f.outside, worktreeId: 1 }])).status, 403);
});

test("phones link chats with canvas Links, but a confined demo phone sees and changes none", async () => {
  const confine = createConfinement({ allowedRoot: os.tmpdir() });
  for (const [method, args] of [
    ["canvas:links", []],
    ["canvas:link-add", [{ project_id: "a" }, { project_id: "b" }]],
    ["canvas:link-remove", ["link-1"]],
    ["linked:grant", ["/p#1", "link-1"]],
  ]) {
    assert.ok(METHODS.has(method), method);
    await assert.rejects(confine.checkCall(method, args), { status: 403, message: REFUSED });
  }
});

test("phones can't connect or disconnect Linear", () => {
  assert.equal(METHODS.has("linear:connect"), false);
  assert.equal(METHODS.has("linear:disconnect"), false);
});

test("advisor controls are allowlisted and confined to the owning Project", async (t) => {
  const f = await fixture(t);
  for (const method of ["advisor:stop", "advisor:retry"]) {
    assert.ok(METHODS.has(method));
    assert.ok(PATHS[method]);
    const reply = await f.rpc(method, [`${f.outside}#1`, "advisor:foreign"]);
    assert.equal(reply.status, 403);
  }
});

test("device management is never a phone command, confined or not", async () => {
  const confine = createConfinement({ allowedRoot: os.tmpdir() });
  for (const method of [
    "devices:list",
    "devices:remove",
    "devices:pending",
    "devices:allow",
    "devices:deny",
    "devices:take-notices",
    "devices:confirm-notices",
    "devices:acknowledge",
  ]) {
    assert.equal(METHODS.has(method), false, method);
    assert.equal(PATHS[method], undefined, method);
    await assert.rejects(confine.checkCall(method, []), { status: 403, message: REFUSED });
  }
});

test("a confined phone cannot access machine-wide Live Activity targets", async () => {
  const confine = createConfinement({ allowedRoot: os.tmpdir() });
  for (const method of ["live-activity:state", "live-activity:open", "live-activity:answer", "live-activity:forget"]) {
    await assert.rejects(confine.checkCall(method, [{ deviceId: "b6e2df4b-972b-4e7b-bc65-6cda0a173798", target: "arbitrary" }]), {
      status: 403,
      message: REFUSED,
    });
  }
});

test("the demo computer's phone cannot list or check MCP servers", async () => {
  const confine = createConfinement({ allowedRoot: os.tmpdir() });
  for (const [method, args] of [
    ["mcp:accounts", []],
    ["mcp:check", ["claude", "default"]],
  ]) {
    assert.ok(METHODS.has(method), method);
    await assert.rejects(confine.checkCall(method, args), (error) => error.status === 403 && error.message === MCP_REFUSED);
  }
});
