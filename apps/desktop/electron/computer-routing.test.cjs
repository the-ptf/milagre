const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { LOCAL_ONLY, LOCAL_ONLY_PREFIXES, isLocalOnly, ALIASES, stripComputer, qualifyEvent, qualifyResult } = require("./computer-routing.cjs");

const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const LINK = "f1713d69-569d-405b-a0b2-19bfdf565a76";

test("remote simulator discovery and attachment results retain the Chat's computer", () => {
  const device = { id: "simulator-1", name: "iPhone", platform: "ios", version: "27" };
  for (const [chatId, remoteChat] of [
    ["/p#2", `${ID}|/p#2`],
    [`milagre-link:${LINK}#3`, `milagre-link:${ID}|${LINK}#3`],
  ]) {
    for (const method of ["simulator:list", "simulator:attach", "simulator:detach"]) {
      const response = { chatId, devices: [device], attached: [device], available: [], supported: true };
      const result = qualifyResult(ID, method, response);
      // SimulatorTrack rejects discovery when its returned Chat differs from the one on screen.
      assert.equal(result.chatId, remoteChat, method);
      assert.deepEqual(result.devices, [device]);
      assert.deepEqual(stripComputer(ID, result), response);
      assert.equal(response.chatId, chatId);
    }
  }
  assert.equal(qualifyResult(ID, "simulator:list", null), null);
  const viewer = { viewerId: "private-viewer", device, iceServers: [] };
  assert.deepEqual(qualifyResult(ID, "simulator:open", viewer), viewer);
});

test("inbox actions retain the owning computer for Project and Link Chats", () => {
  const rows = [
    { key: "/p#2", projectPath: "/p", status: "question" },
    { key: `milagre-link:${LINK}#3`, projectPath: `milagre-link:${LINK}`, status: "approval" },
  ];
  const result = qualifyResult(ID, "chat:inbox", { agents: rows, items: rows });
  assert.equal(result.items[0].key, `${ID}|/p#2`);
  assert.equal(result.items[1].projectPath, `milagre-link:${ID}|${LINK}`);
  assert.deepEqual(stripComputer(ID, result), { agents: rows, items: rows });
  assert.equal(isLocalOnly("floating-inbox:snapshot"), true);
});

test("a call to a computer loses that computer's id everywhere in its arguments, and only that one", () => {
  assert.deepEqual(
    stripComputer(ID, [
      { projectPath: `${ID}|/p`, chatId: `${ID}|/p#2`, nested: [`milagre-link:${ID}|${LINK}`], images: ["data:image/png;base64,AAAA"] },
      `${ID}|${LINK}`,
      7,
      null,
    ]),
    [{ projectPath: "/p", chatId: "/p#2", nested: [`milagre-link:${LINK}`], images: ["data:image/png;base64,AAAA"] }, LINK, 7, null],
  );
  assert.equal(stripComputer(ID, `${OTHER}|/p`), `${OTHER}|/p`);
});

test("a computer's events and results come back naming it", () => {
  assert.deepEqual(qualifyEvent(ID, "project:state", { path: "/p", patch: [] }), { path: `${ID}|/p`, patch: [] });
  assert.deepEqual(qualifyEvent(ID, "link:state", { linkId: LINK, state: {} }), { linkId: `${ID}|${LINK}`, state: {} });
  assert.deepEqual(qualifyEvent(ID, "agent:event", { chatId: "/p#2", event: { type: "turn-started" } }), {
    chatId: `${ID}|/p#2`,
    event: { type: "turn-started" },
  });
  assert.deepEqual(qualifyEvent(ID, "terminal:changed", { chatId: "/p#2" }), { chatId: `${ID}|/p#2` });
  assert.deepEqual(qualifyEvent(ID, "worktree:renamed", { projectPath: "/p", path: "/w", from: "a", name: "b" }), {
    projectPath: `${ID}|/p`,
    path: "/w",
    from: "a",
    name: "b",
  });
  assert.deepEqual(qualifyEvent(ID, "notification:waiting", { chatId: "/p#2", title: "t" }), { chatId: `${ID}|/p#2`, title: "t" });
  assert.deepEqual(qualifyEvent(ID, "agent:ports", { "/p#2": [{ port: 3000 }] }), { [`${ID}|/p#2`]: [{ port: 3000 }] });
  assert.deepEqual(
    qualifyEvent(ID, "runtime:snapshot", {
      projects: [{ path: "/p", name: "p", state: {} }],
      links: [{ linkId: LINK, state: {} }],
      runs: { runs: { "/p#2": { text: "" } }, seq: 4 },
      ports: { "/p#2": [] },
      eventSeq: 9,
    }),
    {
      projects: [{ path: `${ID}|/p`, name: "p", state: {} }],
      links: [{ linkId: `${ID}|${LINK}`, state: {} }],
      runs: { runs: { [`${ID}|/p#2`]: { text: "" } }, seq: 4 },
      ports: { [`${ID}|/p#2`]: [] },
      eventSeq: 9,
    },
  );
  assert.deepEqual(qualifyEvent(ID, "main-sync:status", { projectPath: "/p", last: null }), { projectPath: `${ID}|/p`, last: null });
  assert.deepEqual(qualifyEvent(ID, "runtime:snapshot", { eventSeq: 1 }), { eventSeq: 1 });
  assert.deepEqual(qualifyResult(ID, "project:snapshot", { path: "/p" }), { path: `${ID}|/p` });
  assert.deepEqual(qualifyResult(ID, "chat:ports", { chatId: "/p#2" }), { chatId: `${ID}|/p#2` });
  assert.deepEqual(qualifyEvent(ID, "agent:cli-progress", { provider: "codex" }), { provider: "codex" });

  assert.deepEqual(qualifyResult(ID, "project:switch", { path: "/p", name: "p", state: {} }), { path: `${ID}|/p`, name: "p", state: {} });
  assert.deepEqual(qualifyResult(ID, "project:recent", [{ path: "/p", name: "p", hidden: true }]), [{ path: `${ID}|/p`, name: "p" }]);
  assert.deepEqual(qualifyResult(ID, "project:registry", [{ id: "/p/.git", path: "/p", name: "p" }]), [{ id: "/p/.git", path: `${ID}|/p`, name: "p" }]);
  assert.deepEqual(qualifyResult(ID, "link:list", [{ id: LINK, name: "L", projectIds: ["/p/.git"], hidden: true }]), [
    { id: `${ID}|${LINK}`, name: "L", projectIds: ["/p/.git"] },
  ]);
  assert.deepEqual(qualifyResult(ID, "link:open", { link: { id: LINK }, state: {}, projects: [{ id: "/p/.git", path: "/p", name: "p" }] }), {
    link: { id: `${ID}|${LINK}` },
    state: {},
    projects: [{ id: "/p/.git", path: `${ID}|/p`, name: "p" }],
  });
  assert.deepEqual(qualifyResult(ID, "link:snapshot", { link: { id: LINK }, state: {} }), { link: { id: `${ID}|${LINK}` }, state: {} });
  assert.deepEqual(qualifyResult(ID, "agent:ports", { "/p#2": [{ port: 3000 }] }), { [`${ID}|/p#2`]: [{ port: 3000 }] });
  assert.deepEqual(qualifyResult(ID, "chat:runs", { runs: { "/p#2": {} }, seq: 1 }), { runs: { [`${ID}|/p#2`]: {} }, seq: 1 });
  assert.deepEqual(qualifyResult(ID, "worktree:create", { project: { path: "/p", state: {} }, worktreeId: 2 }), {
    project: { path: `${ID}|/p`, state: {} },
    worktreeId: 2,
  });
  assert.deepEqual(qualifyResult(ID, "terminal:list", { terminals: [{ id: "t", chatId: "/p#2" }] }), { terminals: [{ id: "t", chatId: `${ID}|/p#2` }] });
  assert.deepEqual(qualifyResult(ID, "terminal:open", { id: "t", chatId: "/p#2" }), { id: "t", chatId: `${ID}|/p#2` });
  assert.deepEqual(qualifyResult(ID, "accounts:scopes", [{ key: "/p", projects: [{ path: "/p" }] }]), [{ key: `${ID}|/p`, projects: [{ path: `${ID}|/p` }] }]);
  assert.equal(qualifyResult(ID, "project:switch", null), null);
  assert.deepEqual(qualifyResult(ID, "state:read", { state: { x: 1 }, version: 2, epoch: "e" }), { state: { x: 1 }, version: 2, epoch: "e" });
});

test("this Mac's own actions are local-only, and the preload refuses the same ones", () => {
  for (const channel of [
    "editor:open",
    "project:reveal",
    "skills:open",
    "skills:reveal",
    "project:open",
    "project:set-hidden",
    "image:menu",
    "update:install",
    "notification:state",
    "settings:notify-when-waiting",
    "phone:status",
    "devices:list",
    "canvas:snapshot",
    "computers:list",
    "app:version",
    "accounts:add",
    "chat:limit-switch",
    "app:open-keybindings-file",
  ])
    assert.equal(isLocalOnly(channel), true, channel);
  for (const channel of [
    "project:open-at",
    "project:switch",
    "chat:send",
    "git:push",
    "skills:list",
    "attachment:preview",
    "fs:list-dirs",
    "media:read",
    "accounts:scope",
    "accounts:assign",
    "babysit:settings:read",
    "babysit:settings:save",
    "done:settings:read",
    "done:settings:save",
    "keybindings:read",
    "keybindings:set-command",
    "keybindings:reset-command",
    "keybindings:reset",
    "routines:list",
    "routines:enabled:save",
    "routines:create",
    "routines:hook",
    // A paired computer's desktop app update, on its Computer page; this Mac's own stays update:*.
    "app-update:state",
    "app-update:check",
    "app-update:install",
  ])
    assert.equal(isLocalOnly(channel), false, channel);
  assert.equal(ALIASES["project:open-at"], "project:open");
  const preload = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  const list = (name) => {
    const match = new RegExp(`const ${name} = (?:new Set\\()?(\\[[^\\]]*\\])\\)?;`).exec(preload);
    assert.ok(match, `preload.cjs declares ${name}`);
    return JSON.parse(match[1].replace(/,\s*\]$/, "]"));
  };
  assert.deepEqual(list("LOCAL_ONLY"), [...LOCAL_ONLY]);
  assert.deepEqual(list("LOCAL_ONLY_PREFIXES"), [...LOCAL_ONLY_PREFIXES]);
});

test("command servers and MCP sign-in stay on this Mac", () => {
  for (const name of ["mcp:save", "mcp:signIn", "mcp:cancelSignIn"]) assert.equal(isLocalOnly(name), true, name);
  for (const name of ["mcp:saveUrl", "mcp:toggle", "mcp:remove", "mcp:definition"]) assert.equal(isLocalOnly(name), false, name);
});

test("another computer's Routines, Runs and targets come back naming it, and its ids go back bare", () => {
  const routine = {
    id: "abcd1234",
    name: "Check CI",
    target: { kind: "chat", chatId: "/p#3" },
    createdBy: { kind: "agent", chatId: "/p#2" },
    runs: [{ id: "run00001", routineId: "abcd1234", chatId: "/p#7", worktreeId: "5", status: "acted" }],
  };
  const named = qualifyResult(ID, "routines:list", {
    routines: [
      routine,
      { ...routine, id: "ffff0000", target: { kind: "new-chat", projectPath: "/p", workspace: "worktree" }, createdBy: { kind: "user" }, runs: [] },
    ],
  });
  assert.deepEqual(named.routines[0], {
    id: `${ID}|abcd1234`,
    name: "Check CI",
    target: { kind: "chat", chatId: `${ID}|/p#3` },
    createdBy: { kind: "agent", chatId: `${ID}|/p#2` },
    runs: [{ id: "run00001", routineId: `${ID}|abcd1234`, chatId: `${ID}|/p#7`, worktreeId: "5", status: "acted" }],
  });
  assert.deepEqual(named.routines[1].target, { kind: "new-chat", projectPath: `${ID}|/p`, workspace: "worktree" });
  assert.deepEqual(named.routines[1].createdBy, { kind: "user" });
  assert.equal(qualifyResult(ID, "routines:create", { routine, hookUrl: "https://h" }).routine.id, `${ID}|abcd1234`);
  assert.equal(qualifyResult(ID, "routines:create", { routine, hookUrl: "https://h" }).hookUrl, "https://h");
  assert.equal(qualifyResult(ID, "routines:update", routine).target.chatId, `${ID}|/p#3`);
  assert.deepEqual(qualifyResult(ID, "routines:run-now", { id: "r", routineId: "abcd1234", chatId: "/p#9" }), {
    id: "r",
    routineId: `${ID}|abcd1234`,
    chatId: `${ID}|/p#9`,
  });
  assert.equal(qualifyResult(ID, "routines:run-now", undefined), undefined);
  assert.deepEqual(qualifyResult(ID, "routines:targets", { projects: [{ path: "/p", name: "p", chats: [{ chatId: "/p#3", title: "t", lastAt: 1 }] }] }), {
    projects: [{ path: `${ID}|/p`, name: "p", chats: [{ chatId: `${ID}|/p#3`, title: "t", lastAt: 1 }] }],
  });
  // The window's calls carry those ids back; the computer gets its own.
  assert.deepEqual(stripComputer(ID, [`${ID}|abcd1234`, { target: { kind: "chat", chatId: `${ID}|/p#3` } }]), [
    "abcd1234",
    { target: { kind: "chat", chatId: "/p#3" } },
  ]);
});

test("remote usage can select a saved Project account while sign-ins and computer defaults stay local", () => {
  for (const method of ["usage:read", "usage:cached", "accounts:scope", "accounts:assign"]) assert.equal(isLocalOnly(method), false, method);
  for (const method of ["accounts:add", "accounts:select", "accounts:login", "accounts:cancel", "accounts:remove", "chat:limit-switch"])
    assert.equal(isLocalOnly(method), true, method);
  assert.deepEqual(qualifyEvent(ID, "usage:changed", { scopeKey: "/p" }), { scopeKey: `${ID}|/p` });
  for (const method of ["accounts:scope", "accounts:assign"])
    for (const scopeKey of ["/p", `milagre-link:${LINK}`])
      assert.deepEqual(qualifyResult(ID, method, { scopeKey, providers: [{ accountId: "account-id", effectiveId: "account-id" }] }), {
        scopeKey: scopeKey === "/p" ? `${ID}|/p` : `milagre-link:${ID}|${LINK}`,
        providers: [{ accountId: "account-id", effectiveId: "account-id" }],
      });
  assert.deepEqual(stripComputer(ID, [`${ID}|/p`, "claude", "account-id"]), ["/p", "claude", "account-id"]);
});

test("a remote Project's PR change names that computer's Project", () => {
  assert.deepEqual(qualifyEvent(ID, "pull-requests:changed", { projectPath: "/p" }), { projectPath: `${ID}|/p` });
});

test("chats:ensure result path is rewritten for a remote computer", () => {
  const home = "/Users/a/.milagre/chats";
  assert.deepEqual(qualifyResult(ID, "chats:ensure", { path: home, name: "chats", kind: "chats", state: {} }), {
    path: `${ID}|${home}`,
    name: "chats",
    kind: "chats",
    state: {},
  });
  assert.deepEqual(qualifyResult(ID, "chats:home", { path: home, exists: false }), { path: `${ID}|${home}`, exists: false });
  // Each computer has its own home, so another computer's is reached like any of its Projects.
  assert.equal(isLocalOnly("chats:home"), false);
  assert.equal(isLocalOnly("chats:ensure"), false);
});
