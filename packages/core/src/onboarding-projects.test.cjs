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
