const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { scanFolder } = require("./folder-scan.cjs");

async function tree(t, folders) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-folder-scan-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const folder of folders) await fs.mkdir(path.join(root, folder), { recursive: true });
  return root;
}

test("a folder's repositories, nested repositories and plain folders are offered, repositories checked", async (t) => {
  const root = await tree(t, ["api/.git", "web/.git", "services/billing/.git", "services/audit/.git", "docs", "node_modules/pkg/.git", ".hidden/.git"]);
  const scan = await scanFolder(root);
  assert.equal(scan.folder, root);
  assert.equal(scan.git, false);
  assert.deepEqual(
    scan.children.map((child) => [child.relative, child.git, child.chosen]),
    [
      ["api", true, true],
      ["docs", false, false],
      ["services/audit", true, true],
      ["services/billing", true, true],
      ["web", true, true],
    ],
  );
});

test("a repository says it is one, and a folder reached through a symlink is read under its real path", async (t) => {
  const root = await tree(t, [".git", "client/api/.git"]);
  assert.equal((await scanFolder(root)).git, true);
  await fs.symlink(path.join(root, "client"), path.join(root, "alias"));
  const scan = await scanFolder(path.join(root, "alias"));
  assert.equal(scan.folder, path.join(root, "client"));
  assert.deepEqual(
    scan.children.map((child) => child.path),
    [path.join(root, "client", "api")],
  );
});

test("a relative or unreadable folder is refused", async () => {
  await assert.rejects(scanFolder("relative/path"), /absolute/);
  await assert.rejects(scanFolder(path.join(os.tmpdir(), "milagre-missing-folder-for-test")), /can't read/);
});
