const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createFileSearch } = require("./project-files.cjs");
test("searches tracked and untracked files, excludes ignored files, ranks names, and expires cache", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-files-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  await fs.mkdir(path.join(root, "src"));
  for (const [name, text] of [
    [".gitignore", "secret.txt"],
    ["secret.txt", "secret"],
    ["src/App.tsx", "app"],
    ["App.test.ts", "test"],
    ["a b.txt", "space"],
  ])
    await fs.writeFile(path.join(root, name), text);
  execFileSync("git", ["-C", root, "add", "src/App.tsx"]);
  let now = 0;
  const search = createFileSearch({ now: () => now, ttl: 10 });
  assert.deepEqual(await search(root, "app"), ["src/App.tsx", "App.test.ts"]);
  assert.deepEqual(await search(root, "src/"), ["src/App.tsx"]);
  assert.deepEqual(await search(root, "secret"), []);
  assert.deepEqual(await search(root, "a b"), ["a b.txt"]);
  await fs.writeFile(path.join(root, "new.txt"), "new");
  assert.deepEqual(await search(root, "new"), []);
  now = 11;
  assert.deepEqual(await search(root, "new"), ["new.txt"]);
  assert.equal((await search(root, "", 2)).length, 2);
  // Milagre's own state in a repository that doesn't ignore it is never offered; what people write there still is.
  await fs.mkdir(path.join(root, ".milagre", "runtime.lock"), { recursive: true });
  await fs.mkdir(path.join(root, ".milagre", "subagents"), { recursive: true });
  for (const [name, text] of [
    ["runtime.lock/owner.json", "{}"],
    ["coordination.json", "{}"],
    ["coordination.json.12.3.tmp", "{}"],
    ["chats.db", ""],
    ["chats.db-wal", ""],
    ["subagents/a.json", "{}"],
    ["worktree.json", '{"setup":"npm ci"}'],
    ["checkpoint-ignore", "dist\n"],
  ])
    await fs.writeFile(path.join(root, ".milagre", name), text);
  now = 22;
  assert.deepEqual(await search(root, "owner"), []);
  assert.deepEqual((await search.list(root)).filter((file) => file.startsWith(".milagre/")).sort(), [".milagre/checkpoint-ignore", ".milagre/worktree.json"]);
  assert.deepEqual(await search(root, "worktree.json"), [".milagre/worktree.json"]);
});
