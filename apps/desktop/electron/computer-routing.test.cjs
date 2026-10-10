const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { LOCAL_ONLY, LOCAL_ONLY_PREFIXES, isLocalOnly, ALIASES, stripComputer, qualifyEvent, qualifyResult } = require("./computer-routing.cjs");

const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const LINK = "f1713d69-569d-405b-a0b2-19bfdf565a76";

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
  assert.deepEqual(qualifyResult(ID, "project:recent", [{ path: "/p", name: "p" }]), [{ path: `${ID}|/p`, name: "p" }]);
  assert.deepEqual(qualifyResult(ID, "project:registry", [{ id: "/p/.git", path: "/p", name: "p" }]), [{ id: "/p/.git", path: `${ID}|/p`, name: "p" }]);
  assert.deepEqual(qualifyResult(ID, "link:list", [{ id: LINK, name: "L", projectIds: ["/p/.git"] }]), [
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
  ])
    assert.equal(isLocalOnly(channel), false, channel);
  assert.equal(ALIASES["project:open-at"], "project:open");
  const preload = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  const list = (name) => {
    const match = new RegExp(`const ${name} = (\\[[^\\]]*\\]);`).exec(preload);
    assert.ok(match, `preload.cjs declares ${name}`);
    return JSON.parse(match[1].replace(/,\s*\]$/, "]"));
  };
  assert.deepEqual(list("LOCAL_ONLY"), [...LOCAL_ONLY]);
  assert.deepEqual(list("LOCAL_ONLY_PREFIXES"), [...LOCAL_ONLY_PREFIXES]);
});
