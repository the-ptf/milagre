const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { cleanSubprojects, createProjectTree, scanSubprojects, withSubprojects } = require("./subprojects.cjs");
const { createProjectSettings } = require("./project-settings.cjs");

async function tree(t, folders) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-subprojects-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const folder of folders) await fs.mkdir(path.join(root, folder), { recursive: true });
  return root;
}

test("a folder's repositories, nested repositories and plain folders are offered as Sub-projects", async (t) => {
  const root = await tree(t, ["api/.git", "web/.git", "services/billing/.git", "services/audit/.git", "docs", "node_modules/pkg/.git", ".hidden/.git"]);
  const scan = await scanSubprojects(root);
  assert.equal(scan.folder, root);
  assert.equal(scan.git, false);
  assert.deepEqual(
    scan.children.map((child) => [child.relative, child.git]),
    [
      ["api", true],
      ["docs", false],
      ["services/audit", true],
      ["services/billing", true],
      ["web", true],
    ],
  );
});

test("a repository with repositories inside says it is one", async (t) => {
  const root = await tree(t, [".git", "packages/one/.git"]);
  const scan = await scanSubprojects(root);
  assert.equal(scan.git, true);
  assert.deepEqual(
    scan.children.map((child) => child.relative),
    ["packages/one"],
  );
});

test("a folder reached through a symlink is scanned under its real path", async (t) => {
  const root = await tree(t, ["client/api/.git"]);
  await fs.symlink(path.join(root, "client"), path.join(root, "alias"));
  const scan = await scanSubprojects(path.join(root, "alias"));
  assert.equal(scan.folder, path.join(root, "client"));
  assert.deepEqual(
    scan.children.map((child) => child.path),
    [path.join(root, "client", "api")],
  );
});

test("a relative or unreadable folder is refused", async () => {
  await assert.rejects(scanSubprojects("relative/path"), /absolute/);
  await assert.rejects(scanSubprojects(path.join(os.tmpdir(), "milagre-missing-folder-for-test")), /can't read/);
});

test("only folders inside the parent are kept, each once", async () => {
  assert.deepEqual(await cleanSubprojects("/work/client", ["/work/client/api", "/work/client/api/", "/work/client/web"]), [
    "/work/client/api",
    "/work/client/web",
  ]);
  await assert.rejects(cleanSubprojects("/work/client", ["/work/client"]), /inside/);
  await assert.rejects(cleanSubprojects("/work/client", ["/work/other"]), /inside/);
  await assert.rejects(cleanSubprojects("/work/client", ["api"]), /absolute/);
  await assert.rejects(cleanSubprojects("/work/client", "nope"), /list/);
});

test("repositories start checked; a Parent Project's own Sub-projects do instead, a missing one offered too", async (t) => {
  const root = await tree(t, ["api/.git", "web/.git", "docs"]);
  assert.deepEqual(
    (await scanSubprojects(root)).children.map((child) => [child.relative, child.chosen]),
    [
      ["api", true],
      ["docs", false],
      ["web", true],
    ],
  );
  const scan = await scanSubprojects(root, { chosen: [path.join(root, "docs"), path.join(root, "moved")] });
  assert.deepEqual(
    scan.children.map((child) => [child.relative, child.chosen]),
    [
      ["api", false],
      ["docs", true],
      ["web", false],
      ["moved", true],
    ],
  );
});

test("Sub-projects follow their parent on the recent list and leave the top level", async () => {
  const recent = [
    { path: "/work/solo", name: "solo", openedAt: "3" },
    { path: "/work/client/api", name: "api", openedAt: "2" },
    { path: "/work/client", name: "client", openedAt: "1" },
  ];
  const subprojects = new Map([["/work/client", ["/work/client/web", "/work/client/api", "/work/client/gone"]]]);
  const listed = await withSubprojects(recent, subprojects, { exists: async (folder) => !folder.endsWith("gone") });
  assert.deepEqual(listed, [
    { path: "/work/solo", name: "solo", openedAt: "3" },
    { path: "/work/client", name: "client", openedAt: "1" },
    { path: "/work/client/web", name: "web", openedAt: "1", parent: "/work/client" },
    { path: "/work/client/api", name: "api", openedAt: "1", parent: "/work/client" },
  ]);
});

test("Sub-projects of a parent that isn't recent stay off the list", async () => {
  const recent = [{ path: "/work/solo", name: "solo", openedAt: "1" }];
  assert.deepEqual(await withSubprojects(recent, new Map([["/work/client", ["/work/client/api"]]]), { exists: async () => true }), recent);
});

test("Sub-projects and the detection switch are saved in the project settings", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-subprojects-settings-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settings = createProjectSettings(path.join(dir, "project-settings.json"));
  assert.deepEqual(await settings.getDetectSubprojects(), { detectSubprojects: true });
  await settings.setSubprojects("/work/client", ["/work/client/api"]);
  assert.deepEqual([...(await settings.subprojects())], [["/work/client", ["/work/client/api"]]]);
  await settings.setSubprojects("/work/client", []);
  assert.equal((await settings.subprojects()).size, 0);
  assert.deepEqual(await settings.setDetectSubprojects(false), { detectSubprojects: false });
  assert.deepEqual(await createProjectSettings(path.join(dir, "project-settings.json")).getDetectSubprojects(), { detectSubprojects: false });
});

test("a Parent Project and its Sub-projects each reach the others, and the parents are known", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-subprojects-family-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settings = createProjectSettings(path.join(dir, "project-settings.json"));
  await settings.setSubprojects("/work/client", ["/work/client/api", "/work/client/web"]);
  const tree = createProjectTree({ settings, open: async () => {}, assertRegistrable: () => {} });
  const families = await tree.families();
  assert.deepEqual(families.get("/work/client"), ["/work/client/api", "/work/client/web"]);
  assert.deepEqual(families.get("/work/client/api"), ["/work/client", "/work/client/web"]);
  assert.equal(families.get("/work/other"), undefined);
  assert.deepEqual(
    [...(await tree.parents())],
    [
      ["/work/client/api", "/work/client"],
      ["/work/client/web", "/work/client"],
    ],
  );
});
