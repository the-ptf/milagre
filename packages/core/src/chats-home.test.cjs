const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createGit } = require("./git/client.cjs");
const { createChatsHome } = require("./chats-home.cjs");

function tmp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "milagre-chats-home-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args])
    .toString()
    .trim();

test("exists is false before ensure", async (t) => {
  const home = createChatsHome({ root: path.join(tmp(t), "chats"), git: createGit() });
  assert.equal(await home.exists(), false);
  assert.equal(fs.existsSync(home.path), false);
});

test("ensure creates a git repo on main with one empty commit", async (t) => {
  const home = createChatsHome({ root: path.join(tmp(t), "chats"), git: createGit() });
  const made = await home.ensure();
  assert.equal(made, home.path);
  assert.equal(await home.exists(), true);
  assert.equal(git(made, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(git(made, "rev-parse", "--show-toplevel"), fs.realpathSync(made));
  assert.equal(git(made, "rev-list", "--count", "HEAD"), "1");
  assert.deepEqual(fs.readdirSync(made), [".git"]);
});

test("ensure is idempotent under concurrent calls", async (t) => {
  const home = createChatsHome({ root: path.join(tmp(t), "chats"), git: createGit() });
  const [a, b] = await Promise.all([home.ensure(), home.ensure()]);
  assert.equal(a, b);
  assert.equal(git(a, "rev-list", "--count", "HEAD"), "1");
  await home.ensure();
  assert.equal(git(a, "rev-list", "--count", "HEAD"), "1");
});

test("a second home over the same root keeps the commit", async (t) => {
  const root = path.join(tmp(t), "chats");
  const first = await createChatsHome({ root, git: createGit() }).ensure();
  await createChatsHome({ root, git: createGit() }).ensure();
  assert.equal(git(first, "rev-list", "--count", "HEAD"), "1");
});

test("isHome matches the root and not a child or sibling", async (t) => {
  const root = path.join(tmp(t), "chats");
  const home = createChatsHome({ root, git: createGit() });
  assert.equal(home.isHome(root), true);
  assert.equal(home.isHome(`${root}/`), true);
  assert.equal(home.isHome(path.join(root, "child")), false);
  assert.equal(home.isHome(`${root}-other`), false);
  assert.equal(home.isHome(path.dirname(root)), false);
  await home.ensure();
  assert.equal(home.isHome(root), true);
  assert.equal(home.isHome(path.join(root, "child")), false);
  assert.equal(home.isHome(path.join(root, "..", "chats-other")), false);
});

test("isHome follows a symlink to the real folder once it exists", async (t) => {
  const base = tmp(t);
  const root = path.join(base, "chats");
  const link = path.join(base, "link");
  const home = createChatsHome({ root, git: createGit() });
  await home.ensure();
  fs.symlinkSync(root, link);
  assert.equal(home.isHome(link), true);
});
