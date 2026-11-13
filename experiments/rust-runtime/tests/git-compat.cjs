// Real production client and Git query functions, only on the Rust process's fresh private repository.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { createHash } = require("node:crypto");
const { connect } = require("../../../apps/daemon/src/client.cjs");
const { createGitDiff } = require("../../../packages/core/src/git-diff.cjs");
const { createGitActions } = require("../../../packages/core/src/git-actions.cjs");
const { createGit } = require("../../../packages/core/src/git/client.cjs");
// The runtime must not read the machine's Git configuration, even when HOME is hostile.
const foreignHome = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "milagre-git-foreign-home-"));
fs.writeFileSync(path.join(foreignHome, ".gitconfig"), "[invalid configuration\n", { mode: 0o600 });
const child = spawn(process.argv[2], [], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, HOME: foreignHome, XDG_CONFIG_HOME: foreignHome },
});
const exit = once(child, "exit");
const lines = readline.createInterface({ input: child.stdout });
let stderr = "",
  metadata,
  client,
  other;
child.stderr.on("data", (data) => {
  stderr += data;
});
const deadline = setTimeout(() => {
  child.kill("SIGKILL");
  console.error("Isolated Git runtime timed out");
  process.exitCode = 1;
}, 30000);
function digest(root) {
  const hash = createHash("sha256");
  function visit(folder) {
    for (const entry of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, entry),
        stat = fs.lstatSync(file);
      assert.ok(!stat.isSymbolicLink(), "fixture never follows symlinks");
      hash.update(path.relative(root, file));
      if (stat.isDirectory()) visit(file);
      else {
        assert.ok(stat.isFile());
        hash.update(fs.readFileSync(file));
      }
    }
  }
  visit(root);
  return hash.digest("hex");
}
async function run() {
  const [line] = await once(lines, "line");
  metadata = JSON.parse(line);
  assert.equal(metadata.git.readOnly, true);
  assert.equal(path.dirname(metadata.git.root), fs.realpathSync("/tmp"));
  assert.ok(metadata.git.cwd.startsWith(metadata.git.root + path.sep));
  assert.ok(metadata.git.project.startsWith(metadata.profile + path.sep));
  client = await connect({ dataDir: metadata.profile, timeoutMs: 10000 });
  other = await connect({ dataDir: metadata.profile, timeoutMs: 10000 });
  const { cwd, project } = metadata.git;
  await assert.rejects(client.call("git:changes", [{ cwd }]), { code: "ISOLATED_GIT_SCOPE" });
  await client.call("project:open", [project]);
  const env = {
    PATH: process.env.PATH,
    HOME: path.join(metadata.git.root, "home"),
    LC_ALL: "C",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = createGit({ env, analysisOnly: true });
  const diff = createGitDiff({ env, git });
  const actions = createGitActions({ env, git, gh: "/nonexistent/milagre-fixture-gh" });
  const before = digest(cwd);
  const queries = [
    ["git:changes", {}, (args) => actions.readChanges(args)],
    ["git:history", {}, (args) => diff.history(args)],
    ["git:history", { limit: 1, base: "main" }, (args) => diff.history(args)],
    ["git:diff-files", { mode: "uncommitted" }, (args) => diff.listDiffFiles(args)],
    ...["README.md", "remove.txt", "unicode-é.txt", "binary.bin", ".env.local", "missing.txt"].map((file) => [
      "git:diff-file",
      { mode: "uncommitted", path: file, untracked: !["README.md", "remove.txt"].includes(file) },
      (args) => diff.readDiffFile(args),
    ]),
  ];
  for (const [method, fields, oracle] of queries) {
    const args = { cwd, ...fields };
    let expected;
    try {
      expected = { result: JSON.parse(JSON.stringify(await oracle(args))) };
    } catch (error) {
      expected = { error: error.message };
    }
    if (expected.error) await assert.rejects(client.call(method, [args]), { message: expected.error });
    else assert.deepEqual(await client.call(method, [args]), expected.result, method + JSON.stringify(fields));
  }
  assert.equal(digest(cwd), before, "neither Rust nor Node read queries change repository bytes");
  await assert.rejects(other.call("git:changes", [{ cwd }]), { code: "ISOLATED_GIT_SCOPE" });
  await other.call("project:open", [project]);
  assert.deepEqual(await other.call("git:diff-files", [{ cwd, mode: "uncommitted" }]), await client.call("git:diff-files", [{ cwd, mode: "uncommitted" }]));
  await assert.rejects(client.call("git:changes", [{ cwd: path.dirname(cwd) }]), { code: "GIT_SCOPE" });
  await assert.rejects(client.call("git:changes", [{ cwd: process.cwd() }]), { code: "GIT_SCOPE" });
  await assert.rejects(client.call("git:commit", [{ cwd, message: "never" }]), { code: "COMMAND_FAILED" });
  await assert.rejects(client.call("git:diff-file", [{ cwd, mode: "uncommitted", path: "../../outside" }]), { code: "INVALID_ARGUMENT" });
  assert.equal(digest(cwd), before);
  client.close();
  client = await connect({ dataDir: metadata.profile, timeoutMs: 10000 });
  await assert.rejects(client.call("git:changes", [{ cwd }]), { code: "ISOLATED_GIT_SCOPE" });
  await client.call("project:open", [project]);
  assert.deepEqual(await client.call("git:changes", [{ cwd }]), JSON.parse(JSON.stringify(await actions.readChanges({ cwd }))));
  // Replace only this fixture's lock, then restore its bytes. Lost ownership refuses reads.
  const lock = path.join(project, ".milagre/runtime.lock/owner.json");
  const original = fs.readFileSync(lock);
  try {
    fs.writeFileSync(lock, "{}");
    await assert.rejects(client.call("git:changes", [{ cwd }]), { code: "OWNERSHIP_LOST" });
  } finally {
    fs.writeFileSync(lock, original);
  }
  console.log(`Rust Git runtime conformance passed: ${queries.length} real Node queries, no repository writes, scoped reconnect and ownership checks`);
}
run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    client?.close();
    other?.close();
    child.stdin.end();
    const [code] = await exit;
    if (code !== 0) {
      console.error(stderr);
      process.exitCode = 1;
    }
    clearTimeout(deadline);
    lines.close();
    fs.rmSync(foreignHome, { recursive: true, force: true });
    for (const folder of [metadata?.profile, metadata?.git.root].filter(Boolean)) {
      if (fs.existsSync(folder)) {
        console.error("Fixture was not cleaned up: " + folder);
        process.exitCode = 1;
      }
    }
  });
