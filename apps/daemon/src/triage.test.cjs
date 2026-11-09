const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { profileCandidates, parseTriageFlags } = require("./triage.cjs");
const exec = promisify(execFile);

test("triage looks in the desktop app's userData and the headless profile", () => {
  const home = "/home/u";
  assert.deepEqual(
    profileCandidates({ platform: "darwin", home, env: {} }).map((p) => p.dir),
    ["/home/u/Library/Application Support/Milagre", "/home/u/.milagre/server"],
  );
  assert.equal(profileCandidates({ platform: "linux", home, env: { XDG_CONFIG_HOME: "/x" } })[0].dir, "/x/Milagre");
  assert.deepEqual(profileCandidates({ dataDir: "/p" }), [{ label: "Selected profile", dir: "/p" }]);
  assert.deepEqual(parseTriageFlags([["agent", "codex"]]), { agent: "codex" });
  assert.throws(() => parseTriageFlags([["agent", true]]), /--agent claude/);
  assert.throws(() => parseTriageFlags([["model", "x"]]), /Unknown/);
});

test("with no agent CLI on PATH, triage still writes the playbook and machine facts for a manual run", async (t) => {
  const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-triage-")));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  await fs.mkdir(path.join(profile, "runtime.lock"));
  await fs.writeFile(path.join(profile, "runtime.lock", "owner.json"), JSON.stringify({ pid: 999999, startedAt: "2026-10-27T00:00:00.000Z" }));
  const { stdout } = await exec(process.execPath, [path.join(__dirname, "command.cjs"), "triage", "--data-dir", profile], {
    env: { ...process.env, PATH: "/nonexistent" },
  });
  assert.match(stdout, /No supported agent CLI/);
  const [session] = await fs.readdir(path.join(profile, "triage"));
  const dir = path.join(profile, "triage", session);
  const context = await fs.readFile(path.join(dir, "context.md"), "utf8");
  assert.match(context, /claude not found on PATH/);
  assert.match(context, /stale lock from pid 999999/);
  assert.match(context, /NEVER read these\): .*computer-keys\.json/);
  assert.equal(
    await fs.readFile(path.join(dir, "PLAYBOOK.md"), "utf8"),
    await fs.readFile(path.join(__dirname, "../../../packages/core/src/triage-playbook.md"), "utf8"),
  );
});
