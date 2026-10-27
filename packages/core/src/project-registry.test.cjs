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

test("between writes a list reads the file as it is, and an open of the Project already first writes nothing", async (t) => {
  const root = await fixture(t);
  const first = await repository(root, "first", { coordination: false });
  const second = await repository(root, "second", { coordination: false });
  const file = path.join(root, "userData", "project-registry.json");
  let seconds = 0;
  const registry = createProjectRegistry(file, { roots: [], now: () => new Date(Date.UTC(2026, 9, 1, 10, 0, seconds++)) });
  await registry.add(await resolveProject(first.main));
  await registry.add(await resolveProject(second.main));
  // The first list scans and checks every entry with git; the next ones read the file.
  await registry.list();
  const saved = await fs.readFile(file, "utf8");
  const { mtimeMs } = await fs.stat(file);
  assert.deepEqual(
    (await registry.list()).map((entry) => entry.path),
    [second.main, first.main],
  );
  await registry.add(await resolveProject(second.main));
  assert.equal(await fs.readFile(file, "utf8"), saved, "only its openedAt would change");
  assert.equal((await fs.stat(file)).mtimeMs, mtimeMs);
  // Another Project moves up, with its canvas position.
  await registry.setPosition((await resolveProject(first.main)).id, { x: 5, y: 6 });
  await registry.add(await resolveProject(first.main));
  assert.deepEqual(
    (await registry.list()).map((entry) => [entry.path, entry.position]),
    [
      [first.main, { x: 5, y: 6 }],
      [second.main, null],
    ],
  );
});

test("an open drops an entry whose folder went away, its Links, and the same folder under another identity", async (t) => {
  const root = await fixture(t);
  const kept = await repository(root, "kept", { coordination: false });
  const gone = await repository(root, "gone", { coordination: false });
  const plain = path.join(root, "plain");
  await fs.mkdir(plain);
  const file = path.join(root, "userData", "project-registry.json");
  const registry = createProjectRegistry(file, { roots: [] });
  for (const folder of [gone.main, plain, kept.main]) await registry.add(await resolveProject(folder));
  const ids = Object.fromEntries((await registry.list()).map((entry) => [entry.path, entry.id]));
  await registry.addLink({ project_id: ids[gone.main] }, { project_id: ids[kept.main] }, {});
  assert.equal((await registry.snapshot()).links.length, 1);
  // The plain folder becomes a repository, and another Project's folder is deleted.
  git(plain, "init", "-q");
  await fs.rm(gone.main, { recursive: true });
  await registry.add(await resolveProject(plain));
  const saved = await registry.snapshot();
  assert.deepEqual(
    saved.projects.map((entry) => [entry.path, entry.git]),
    [
      [plain, true],
      [kept.main, true],
    ],
  );
  assert.deepEqual(saved.links, []);
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
