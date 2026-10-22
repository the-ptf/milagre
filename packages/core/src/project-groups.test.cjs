const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createProjectRegistry } = require("./project-registry.cjs");
const { resolveProject } = require("./project-identity.cjs");

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-groups-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = [];
  for (const name of ["api", "merchant"]) {
    const folder = path.join(root, name);
    await fs.mkdir(folder);
    const git = (...args) => execFileSync("git", ["-C", folder, ...args], { stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("commit", "--allow-empty", "-qm", "Initial");
    projects.push(await resolveProject(folder));
  }
  const file = path.join(root, "registry.json");
  const registry = createProjectRegistry(file, { roots: [] });
  for (const project of projects) await registry.add(project);
  return { root, file, registry, projects };
}

test("named Links survive registry reload without changing canvas edges", async (t) => {
  const { file, registry, projects } = await fixture(t);
  assert.equal(typeof registry.createProjectGroup, "function", "registry can create a named Link");
  await registry.addLink({ project_id: projects[0].id }, { project_id: projects[1].id }, {});
  const edges = (await registry.snapshot()).links;
  const group = await registry.createProjectGroup({ name: "  RDFood  ", projectIds: projects.map((p) => p.id) });
  assert.equal(group.name, "RDFood");
  assert.deepEqual(
    group.projectIds,
    projects.map((p) => p.id),
  );
  assert.match(group.id, /^[0-9a-f-]{36}$/);
  const reopened = createProjectRegistry(file, { roots: [] });
  assert.deepEqual(await reopened.listProjectGroups(), [group]);
  assert.deepEqual((await reopened.snapshot()).links, edges);
});

test("named Links reject invalid and repeated membership", async (t) => {
  const { registry, projects } = await fixture(t);
  assert.equal(typeof registry.createProjectGroup, "function");
  for (const request of [
    { name: "", projectIds: projects.map((p) => p.id) },
    { name: "Link", projectIds: [projects[0].id] },
    { name: "Link", projectIds: [projects[0].id, projects[0].id] },
    { name: "Link", projectIds: [projects[0].id, "/unknown/.git"] },
  ])
    await assert.rejects(registry.createProjectGroup(request));
  await registry.createProjectGroup({ name: "RDFood", projectIds: projects.map((p) => p.id) });
  await assert.rejects(registry.createProjectGroup({ name: "Again", projectIds: projects.map((p) => p.id).toReversed() }), /already/i);
  assert.equal((await registry.listProjectGroups()).length, 1);
});

test("Link visibility survives a registry reload and a rename, then can be restored", async (t) => {
  const { file, registry, projects } = await fixture(t);
  const group = await registry.createProjectGroup({ name: "Checkout", projectIds: projects.map((project) => project.id) });
  await registry.updateProjectGroup({ ...group, hidden: true });
  const reopened = createProjectRegistry(file, { roots: [] });
  assert.equal((await reopened.listProjectGroups())[0].hidden, true);
  const renamed = await reopened.updateProjectGroup({ id: group.id, name: "Checkout renamed", projectIds: group.projectIds });
  assert.equal(renamed.hidden, true);
  await reopened.updateProjectGroup({ ...renamed, hidden: false });
  assert.equal((await createProjectRegistry(file, { roots: [] }).listProjectGroups())[0].hidden, undefined);
});

test("another checkout of one repository is not a second Link member", async (t) => {
  const { root, registry, projects } = await fixture(t);
  const linked = path.join(root, "checkout");
  execFileSync("git", ["-C", projects[0].path, "worktree", "add", "-qb", "feature", linked], { stdio: "ignore" });
  const same = await resolveProject(linked);
  await registry.add(same);
  assert.equal(typeof registry.createProjectGroup, "function");
  await assert.rejects(registry.createProjectGroup({ name: "Same", projectIds: [projects[0].id, same.id] }), /distinct|two/i);
});

test("missing member Projects do not delete a named Link", async (t) => {
  const { registry, file, projects } = await fixture(t);
  assert.equal(typeof registry.createProjectGroup, "function");
  const group = await registry.createProjectGroup({ name: "RDFood", projectIds: projects.map((p) => p.id) });
  await fs.rm(projects[1].path, { recursive: true });
  await registry.list();
  assert.deepEqual(await createProjectRegistry(file, { roots: [] }).listProjectGroups(), [group]);
});

test("concurrent duplicate creation persists only one named Link", async (t) => {
  const { registry, projects } = await fixture(t);
  assert.equal(typeof registry.createProjectGroup, "function");
  const results = await Promise.allSettled(["First", "Second"].map((name) => registry.createProjectGroup({ name, projectIds: projects.map((p) => p.id) })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await registry.listProjectGroups()).length, 1);
});

test("editing a named Link renames it and changes members, keeping an unavailable one only if it was already there", async (t) => {
  const { root, file, registry, projects } = await fixture(t);
  const folder = path.join(root, "admin");
  await fs.mkdir(folder);
  execFileSync("git", ["-C", folder, "init", "-q", "-b", "main"], { stdio: "ignore" });
  execFileSync("git", ["-C", folder, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "Initial"], {
    stdio: "ignore",
  });
  const admin = await resolveProject(folder);
  await registry.add(admin);
  const group = await registry.createProjectGroup({ name: "RDFood", projectIds: projects.map((p) => p.id) });
  const other = await registry.createProjectGroup({ name: "Admin", projectIds: [projects[0].id, admin.id] });
  await fs.rm(projects[1].path, { recursive: true });
  await registry.list();
  const kept = await registry.updateProjectGroup({ id: group.id, name: "RDFood", projectIds: [...group.projectIds, admin.id] });
  assert.deepEqual(kept.projectIds, [...group.projectIds, admin.id]);
  await assert.rejects(registry.updateProjectGroup({ id: other.id, name: "Admin", projectIds: [admin.id, projects[1].id] }), /Open each member/);
  await assert.rejects(registry.updateProjectGroup({ id: group.id, name: "RDFood", projectIds: [admin.id, projects[0].id] }), /already/);
  await assert.rejects(
    registry.updateProjectGroup({ id: "00000000-0000-4000-8000-000000000000", name: "X", projectIds: other.projectIds }),
    /no longer exists/,
  );
  const renamed = await registry.updateProjectGroup({ id: group.id, name: "Food", projectIds: [projects[0].id, admin.id].toReversed().concat(projects[1].id) });
  assert.deepEqual(await createProjectRegistry(file, { roots: [] }).listProjectGroups(), [{ ...group, name: "Food", projectIds: renamed.projectIds }, other]);
});
