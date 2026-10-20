const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { activeWorktrees, resolveProject } = require("./project-identity.cjs");
const { createProjectRegistry } = require("./project-registry.cjs");

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-project-registry-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function repository(root, name, { coordination = true } = {}) {
  const main = path.join(root, "Developer", name);
  const linked = path.join(root, ".milagre", "worktrees", name, "feature");
  await fs.mkdir(main, { recursive: true });
  git(main, "init", "-q");
  git(main, "config", "user.name", "Test");
  git(main, "config", "user.email", "test@example.com");
  await fs.writeFile(path.join(main, "README.md"), name);
  git(main, "add", "README.md");
  git(main, "commit", "-qm", "Initial");
  await fs.mkdir(path.dirname(linked), { recursive: true });
  git(main, "worktree", "add", "-qb", `${name}-feature`, linked);
  if (coordination) {
    await fs.mkdir(path.join(main, ".milagre"));
    await fs.writeFile(path.join(main, ".milagre", "coordination.json"), "{}\n");
  }
  return { main, linked };
}

test("all worktrees resolve to the main checkout and the same common Git directory", async (t) => {
  const root = await fixture(t);
  const { main, linked } = await repository(root, "Milagre");
  const fromMain = await resolveProject(main);
  const fromLinked = await resolveProject(linked);
  assert.deepEqual(fromLinked, fromMain);
  assert.equal(fromLinked.path, main);
  assert.equal(fromLinked.id, await fs.realpath(path.join(main, ".git")));
  assert.deepEqual(
    (await activeWorktrees(main)).map((entry) => entry.path),
    [main, linked],
  );
  await fs.rm(linked, { recursive: true });
  assert.deepEqual(
    (await activeWorktrees(main)).map((entry) => entry.path),
    [main],
  );
});

test("the registry joins linked worktrees, keeps canvas positions and removes missing main checkouts", async (t) => {
  const root = await fixture(t);
  const { main, linked } = await repository(root, "Milagre");
  const file = path.join(root, "userData", "project-registry.json");
  const registry = createProjectRegistry(file, { roots: [] });
  await registry.add(await resolveProject(linked));
  const identity = await resolveProject(main);
  await registry.setPosition(identity.id, { x: 120, y: 35 });
  await registry.add(identity);
  assert.deepEqual(
    (await registry.list()).map((entry) => ({ id: entry.id, path: entry.path, position: entry.position })),
    [{ id: identity.id, path: main, position: { x: 120, y: 35 } }],
  );
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).scanned, true);
  await assert.rejects(registry.setPosition(identity.id, { x: Infinity, y: 0 }), /Invalid Project position/);
  await fs.rm(main, { recursive: true });
  assert.deepEqual(await registry.list(), []);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).projects, []);
});

test("the first registry list scans existing coordination files once", async (t) => {
  const root = await fixture(t);
  const first = await repository(root, "build");
  // A linked checkout can hold a legacy state file; it still resolves to the main Project.
  await fs.rm(path.join(first.main, ".milagre", "coordination.json"));
  await fs.mkdir(path.join(first.linked, ".milagre"));
  await fs.writeFile(path.join(first.linked, ".milagre", "coordination.json"), "{}\n");
  const file = path.join(root, "userData", "project-registry.json");
  const roots = [path.join(root, "Developer"), path.join(root, ".milagre", "worktrees")];
  const registry = createProjectRegistry(file, { roots });
  assert.deepEqual(
    (await registry.list()).map((entry) => entry.path),
    [first.main],
  );
  await repository(root, "second");
  assert.deepEqual(
    (await createProjectRegistry(file, { roots }).list()).map((entry) => entry.path),
    [first.main],
  );
  await registry.add(await resolveProject(path.join(root, "Developer", "second")));
  assert.equal((await registry.list()).length, 2);
});

test("Links and Worktree positions survive restart and removed Worktrees lose their Links", async (t) => {
  const root = await fixture(t);
  const first = await repository(root, "first");
  const second = await repository(root, "second");
  const file = path.join(root, "userData", "project-registry.json");
  const registry = createProjectRegistry(file, { roots: [] });
  const a = await resolveProject(first.main);
  const b = await resolveProject(second.main);
  await registry.add(a);
  await registry.add(b);
  const active = { [a.id]: [first.main, first.linked], [b.id]: [second.main, second.linked] };
  await registry.addLink({ project_id: a.id, worktree_path: first.linked }, { project_id: b.id }, active);
  await registry.setWorktreePosition(a.id, first.linked, { x: 24, y: 80 });
  const reopened = createProjectRegistry(file, { roots: [] });
  assert.equal((await reopened.snapshot()).links.length, 1);
  assert.deepEqual((await reopened.snapshot()).worktreePositions[a.id][first.linked], { x: 24, y: 80 });
  await reopened.pruneLinks({ ...active, [a.id]: [first.main] });
  assert.deepEqual((await reopened.snapshot()).links, []);
  assert.equal((await reopened.snapshot()).worktreePositions[a.id][first.linked], undefined);
});

test("resolveProject opens a folder outside Git as its own Project, but never a disk's root", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-not-git-"));
  try {
    const real = await fs.realpath(folder);
    assert.deepEqual(await resolveProject(real), { id: real, path: real, name: path.basename(real), git: false });
    await assert.rejects(resolveProject(path.parse(real).root), /not the whole disk/);
    await fs.writeFile(path.join(real, "file.txt"), "");
    await assert.rejects(resolveProject(path.join(real, "file.txt")), /isn't a folder/);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});
