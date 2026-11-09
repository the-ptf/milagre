const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createOnboardingProjects } = require("./onboarding-projects.cjs");

// Git as a computer without it answers: the program isn't there.
const noGit = { run: async () => ({ ok: false, missing: true, message: "spawn git ENOENT" }) };

test("Start from scratch without Git on the computer makes a plain folder instead of failing", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-onboarding-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = createOnboardingProjects({ root, writer: noGit });
  const { path: folder } = await projects.create("first");
  assert.equal(folder, path.join(root, "first"));
  assert.ok((await fs.stat(folder)).isDirectory());
});

test("cloning or setting up Git without Git says to install it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-onboarding-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = createOnboardingProjects({ root, writer: noGit, plain: async () => true });
  await assert.rejects(projects.clone("https://github.com/owner/repo"), /Git isn't installed/);
  await assert.rejects(projects.initGit(root), /Git isn't installed/);
});

// A writer that makes the folder `git clone` would, and records what it was asked.
function cloneWriter(calls) {
  return {
    run: async (cwd, args) => {
      calls.push({ cwd, args });
      await fs.mkdir(args[3], { recursive: true });
      return { ok: true };
    },
  };
}

test("a clone goes into the folder the user chose, named after the repository", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-onboarding-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parent = path.join(root, "work");
  await fs.mkdir(parent);
  const calls = [];
  const projects = createOnboardingProjects({ root: path.join(root, "Code"), writer: cloneWriter(calls) });
  const { path: folder } = await projects.clone("https://github.com/owner/repo.git", parent);
  assert.equal(folder, path.join(parent, "repo"));
  assert.deepEqual(calls, [{ cwd: parent, args: ["clone", "--", "https://github.com/owner/repo.git", folder] }]);
  await assert.rejects(fs.access(path.join(root, "Code")), "the default folder is left alone");
});

test("a clone with no folder chosen goes into the default one, made when missing", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-onboarding-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = createOnboardingProjects({ root: path.join(root, "Code"), writer: cloneWriter([]) });
  const { path: folder } = await projects.clone("git@github.com:owner/repo.git", "  ");
  assert.equal(folder, path.join(root, "Code", "repo"));
});

test("a clone's folder starts from ~ and must be an existing folder", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-onboarding-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const projects = createOnboardingProjects({ root, writer: cloneWriter(calls) });
  await assert.rejects(projects.clone("https://github.com/owner/repo", "work"), /full path/);
  await assert.rejects(projects.clone("https://github.com/owner/repo", path.join(root, "missing")), /isn't a folder/);
  await fs.writeFile(path.join(root, "file"), "");
  await assert.rejects(projects.clone("https://github.com/owner/repo", path.join(root, "file")), /isn't a folder/);
  assert.deepEqual(calls, []);
});

test("a clone refuses a destination that already has the repository's folder", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-onboarding-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "repo"));
  const projects = createOnboardingProjects({ root, writer: cloneWriter([]) });
  await assert.rejects(projects.clone("https://github.com/owner/repo", root), /already exists/);
});
