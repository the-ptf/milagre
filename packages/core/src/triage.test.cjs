const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { prepareTriage } = require("./triage.cjs");

test("the in-app entry writes a session beside the host's profile and drafts a Chat that reads it", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-triage-app-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const { prompt } = await prepareTriage({ dataDir, version: "9.9.9", client: "Milagre for iPhone 1.0" });
  const playbook = /^Read (.+PLAYBOOK\.md) and follow it\. What went wrong: $/.exec(prompt)?.[1];
  assert.ok(playbook, prompt);
  assert.equal(path.dirname(path.dirname(playbook)), path.join(dataDir, "triage"));
  const context = await fs.readFile(path.join(path.dirname(playbook), "context.md"), "utf8");
  assert.match(context, /Started from: Milagre for iPhone 1\.0/);
  assert.match(context, /This session runs inside Milagre/);
  assert.match(context, new RegExp(`Host: running \\(pid ${process.pid}, version 9\\.9\\.9\\)`));
  assert.match(await fs.readFile(playbook, "utf8"), /^# Milagre triage playbook/);
});
