const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createProjectSettings } = require("./project-settings.cjs");

async function store(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-settings-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "nested", "project-settings.json");
  return { file, settings: createProjectSettings(file) };
}

test("a project with no saved settings has no patterns", async (t) => {
  const { settings } = await store(t);
  assert.deepEqual(await settings.get("/work/shop"), { filesToCopy: [], setupCommand: "", icon: null });
});

test("patterns are saved per project and survive a restart", async (t) => {
  const { file, settings } = await store(t);
  await settings.setFilesToCopy("/work/shop", [".env", "  secrets/*.json  ", "", "   "]);
  await settings.setFilesToCopy("/work/blog", ["*.key"]);
  const reopened = createProjectSettings(file);
  assert.deepEqual(await reopened.get("/work/shop"), { filesToCopy: [".env", "secrets/*.json"], setupCommand: "", icon: null });
  assert.deepEqual(await reopened.get("/work/blog"), { filesToCopy: ["*.key"], setupCommand: "", icon: null });
});

test("saving an empty list brings the default back", async (t) => {
  const { settings } = await store(t);
  await settings.setFilesToCopy("/work/shop", [".env"]);
  await settings.setFilesToCopy("/work/shop", []);
  assert.deepEqual(await settings.get("/work/shop"), { filesToCopy: [], setupCommand: "", icon: null });
});

test("a damaged file reads as empty and is replaced by the next save", async (t) => {
  const { file, settings } = await store(t);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "{not json");
  assert.deepEqual(await settings.get("/work/shop"), { filesToCopy: [], setupCommand: "", icon: null });
  await settings.setFilesToCopy("/work/shop", [".env"]);
  assert.deepEqual(await settings.get("/work/shop"), { filesToCopy: [".env"], setupCommand: "", icon: null });
});

test("a file that can't be read fails the save and keeps the other projects' patterns", async (t) => {
  const { file, settings } = await store(t);
  await settings.setFilesToCopy("/work/shop", [".env"]);
  await settings.setFilesToCopy("/work/blog", ["*.key"]);
  const before = await fs.readFile(file, "utf8");
  // A directory where the file should be: reading it fails with EISDIR, not ENOENT.
  await fs.rm(file);
  await fs.mkdir(file);
  await assert.rejects(settings.setFilesToCopy("/work/shop", ["new"]), /EISDIR/);
  // Creating a worktree still works: reading is not strict.
  assert.deepEqual(await settings.get("/work/shop"), { filesToCopy: [], setupCommand: "", icon: null });
  await fs.rmdir(file);
  await fs.writeFile(file, before);
  assert.deepEqual(await settings.get("/work/blog"), { filesToCopy: ["*.key"], setupCommand: "", icon: null });
});

test("saves that overlap all land", async (t) => {
  const { settings } = await store(t);
  await Promise.all(["a", "b", "c", "d"].map((name) => settings.setFilesToCopy(`/work/${name}`, [`${name}.env`])));
  for (const name of ["a", "b", "c", "d"])
    assert.deepEqual(await settings.get(`/work/${name}`), { filesToCopy: [`${name}.env`], setupCommand: "", icon: null });
});

test("a setup command is saved per project, trimmed, and removed when empty", async (t) => {
  const { file, settings } = await store(t);
  await settings.setFilesToCopy("/work/shop", [".env"]);
  assert.deepEqual(await settings.setSetupCommand("/work/shop", "  npm ci  "), { setupCommand: "npm ci" });
  const reopened = createProjectSettings(file);
  assert.deepEqual(await reopened.get("/work/shop"), { filesToCopy: [".env"], setupCommand: "npm ci", icon: null });
  await reopened.setSetupCommand("/work/shop", "   ");
  assert.deepEqual(await reopened.get("/work/shop"), { filesToCopy: [".env"], setupCommand: "", icon: null });
  await reopened.setFilesToCopy("/work/shop", []);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).projects, {});
});

test("a chosen icon is saved per project and removed with null", async (t) => {
  const { file, settings } = await store(t);
  const icon = "data:image/png;base64,iVBORw0KGgo=";
  assert.deepEqual(await settings.setIcon("/work/shop", icon), { icon });
  assert.equal((await createProjectSettings(file).get("/work/shop")).icon, icon);
  await assert.rejects(settings.setIcon("/work/shop", "data:image/svg+xml;base64,PHN2Zz4="), /Choose a PNG/);
  await assert.rejects(settings.setIcon("/work/shop", `data:image/png;base64,${"A".repeat(600_000)}`), /Choose a PNG/);
  await settings.setIcon("/work/shop", null);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).projects, {});
});

test("a hidden project is listed until it is shown again", async (t) => {
  const { file, settings } = await store(t);
  await settings.setHidden("/work/shop", true);
  await settings.setFilesToCopy("/work/blog", [".env"]);
  assert.deepEqual([...(await createProjectSettings(file).hiddenPaths())], ["/work/shop"]);
  await settings.setHidden("/work/shop", false);
  assert.deepEqual([...(await settings.hiddenPaths())], []);
});

test("main sync follows the global default until a Project overrides it", async (t) => {
  const { settings } = await store(t);
  assert.deepEqual(await settings.getMainSync("/work/shop"), { override: null, defaultValue: false, enabled: false, last: null });
  assert.deepEqual(await settings.setMainSyncDefault(true), { syncMain: true });
  assert.equal((await settings.getMainSync("/work/shop")).enabled, true);
  assert.deepEqual(await settings.setMainSyncOverride("/work/shop", false), { override: false, defaultValue: true, enabled: false, last: null });
  await settings.setMainSyncOverride("/work/shop", null);
  assert.deepEqual(await settings.getMainSync("/work/shop"), { override: null, defaultValue: true, enabled: true, last: null });
});

test("the global default survives per-Project saves and a restart", async (t) => {
  const { file, settings } = await store(t);
  await settings.setMainSyncDefault(true);
  await settings.setFilesToCopy("/work/shop", [".env"]);
  const reopened = createProjectSettings(file);
  assert.deepEqual(await reopened.getMainSyncDefault(), { syncMain: true });
  assert.deepEqual(await reopened.get("/work/shop"), { filesToCopy: [".env"], setupCommand: "", icon: null });
});

test("clearing an override leaves no empty Project entry", async (t) => {
  const { file, settings } = await store(t);
  await settings.setMainSyncOverride("/work/shop", true);
  await settings.setMainSyncOverride("/work/shop", null);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).projects, {});
});

test("the last sync result is kept per Project, and a damaged one reads as none", async (t) => {
  const { file, settings } = await store(t);
  const last = { at: 1760000000000, outcome: "updated", branch: "main", commit: "a1b2c3d" };
  await settings.recordMainSync("/work/shop", last);
  assert.deepEqual((await settings.getMainSync("/work/shop")).last, last);
  assert.equal((await settings.getMainSync("/work/blog")).last, null);
  const data = JSON.parse(await fs.readFile(file, "utf8"));
  data.projects[path.resolve("/work/shop")].mainSync = { outcome: "exploded" };
  await fs.writeFile(file, JSON.stringify(data));
  assert.equal((await settings.getMainSync("/work/shop")).last, null);
});

test("damaged defaults read as off and keep Project entries", async (t) => {
  const { file, settings } = await store(t);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ defaults: "yes", projects: { [path.resolve("/work/shop")]: { setupCommand: "npm i" } } }));
  assert.deepEqual(await settings.getMainSyncDefault(), { syncMain: false });
  await settings.setMainSyncDefault(true);
  assert.deepEqual(await settings.get("/work/shop"), { filesToCopy: [], setupCommand: "npm i", icon: null });
  assert.deepEqual(await settings.getMainSyncDefault(), { syncMain: true });
});

test("dictation corrections survive a restart, stay in their Project, and can be replaced or removed", async (t) => {
  const { file, settings } = await store(t);
  await Promise.all([settings.setDictationCorrection("/one", "use queue", "useQueue"), settings.setDictationCorrection("/one", "open kit", "OpenKit")]);
  const saved = createProjectSettings(file);
  assert.equal((await saved.getDictationCorrections("/one")).length, 2);
  assert.deepEqual(await saved.getDictationCorrections("/two"), []);
  await saved.setDictationCorrection("/one", "Use Queue", "UseQueue");
  await saved.setDictationCorrection("/one", "Open Kit", "");
  assert.deepEqual(await saved.getDictationCorrections("/one"), [{ heard: "Use Queue", spelling: "UseQueue" }]);
});
