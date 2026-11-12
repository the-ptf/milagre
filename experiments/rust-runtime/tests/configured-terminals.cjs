// Actual Node client, dedicated Rust owner and real PTYs. No model turn or live profile.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { connect } = require("../../../apps/daemon/src/client.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rust-configured-terminal-"));
const data = path.join(root, "data");
const child = spawn(path.resolve(process.argv[2]), ["fixture-create", data], { stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (b) => {
  stderr += b;
});
const exit = new Promise((r, j) => {
  child.once("exit", (code, signal) => r({ code, signal }));
  child.once("error", j);
});
let client, second;
let succeeded = false;
function deadline(p, what, ms = 10000) {
  let timer;
  return Promise.race([p, new Promise((_, j) => (timer = setTimeout(() => j(Error("Timed out: " + what)), ms)))]).finally(() => clearTimeout(timer));
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const lines = readline.createInterface({ input: child.stdout });
  const receipt = await deadline(new Promise((r) => lines.once("line", (l) => r(JSON.parse(l)))), "receipt");
  lines.close();
  const project = receipt.actor.project,
    chatId = project + "#1";
  client = await connect({ dataDir: receipt.profile, timeoutMs: 10000 });
  for (const method of ["terminal:profiles", "terminal:list", "terminal:open", "git:changes", "pr:diff-files", "pr:diff-file"])
    await assert.rejects(client.call(method, [{ chatId, cwd: project }]), { code: "ISOLATED_SCOPE_ONLY" });
  await client.call("project:open", [project]);
  assert.equal((await client.call("project:current")).git, false);
  assert.equal((await client.call("git:changes", [{ cwd: project }])).isRepo, false);
  for (const foreign of ["/foreign#1", project + "#999"]) await assert.rejects(client.call("terminal:open", [{ chatId: foreign }]));
  await assert.rejects(client.call("terminal:open", [{ chatId, cwd: "/tmp" }]));
  const terminal = await client.call("terminal:open", [{ chatId, cols: 80, rows: 24 }]);
  assert.equal(terminal.cwd, project);
  await client.call("terminal:input", [{ terminalId: terminal.id, data: "printf '\\162\\165\\163\\164\\055\\167\\151\\162\\145\\055\\160\\164\\171\\012'\n" }]);
  let read;
  const end = Date.now() + 5000;
  do {
    read = await client.call("terminal:read", [{ terminalId: terminal.id, after: 0 }]);
    if (read.data.includes("rust-wire-pty\r\n")) break;
    await pause(10);
  } while (Date.now() < end);
  assert.ok(read.data.includes("rust-wire-pty\r\n"));
  let settled = false;
  const waiting = client.call("terminal:read", [{ terminalId: terminal.id, after: read.offset }]).then((v) => {
    settled = true;
    return v;
  });
  await pause(80);
  assert.equal(settled, false, "read must be waiting on actual output");
  await deadline(client.call("state:read", [project]), "actor read while PTY long-polls", 1000);
  second = await connect({ dataDir: receipt.profile, timeoutMs: 10000 });
  await second.call("project:open", [project]);
  const catchup = await second.call("terminal:read", [{ terminalId: terminal.id, after: 0 }]);
  assert.ok(catchup.data.includes("rust-wire-pty\r\n"));
  await second.call("terminal:resize", [{ terminalId: terminal.id, cols: 119, rows: 37 }]);
  let list = await second.call("terminal:list", [{ chatId }]);
  assert.equal(list.terminals[0].cols, 119);
  assert.equal(list.terminals[0].rows, 37);
  await deadline(waiting, "pending read released by resize");
  // A repository appears only through this explicit user terminal command, never runtime startup.
  await second.call("terminal:input", [
    {
      terminalId: terminal.id,
      data: "export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1; /usr/bin/git init -q && printf 'before\\n' > terminal.txt && /usr/bin/git add terminal.txt && /usr/bin/git -c user.name=Synthetic -c user.email=synthetic@example.invalid -c core.hooksPath=/dev/null commit -q -m baseline && printf 'after\\n' > terminal.txt && printf '\\147\\151\\164\\055\\162\\145\\141\\144\\171\\012'\n",
    },
  ]);
  const gitUntil = Date.now() + 5000;
  let gitOutput;
  do {
    gitOutput = await second.call("terminal:read", [{ terminalId: terminal.id, after: 0 }]);
    if (gitOutput.data.includes("git-ready\r\n")) break;
    await pause(10);
  } while (Date.now() < gitUntil);
  assert.ok(gitOutput.data.includes("git-ready\r\n"));
  assert.equal((await second.call("project:current")).git, true);
  assert.equal((await second.call("project:known"))[0].git, true);
  assert.equal((await second.call("canvas:snapshot")).projects[0].git, true);
  const changes = await second.call("git:changes", [{ cwd: project }]);
  assert.equal(changes.isRepo, true);
  assert.ok(changes.files.some((f) => f.path === "terminal.txt"));
  const files = await second.call("git:diff-files", [{ cwd: project }]);
  assert.ok(files.files.some((f) => f.path === "terminal.txt"));
  const diff = await second.call("git:diff-file", [{ cwd: project, path: "terminal.txt" }]);
  assert.ok(diff.patch.includes("+after"));
  const history = await second.call("git:history", [{ cwd: project }]);
  assert.equal(typeof history.head, "string");
  const commits = { cwd: project, base: history.head, head: history.head };
  assert.deepEqual((await second.call("pr:diff-files", [commits])).files, []);
  assert.equal((await second.call("pr:diff-file", [{ ...commits, path: "terminal.txt" }])).patch, "");
  assert.equal((await second.call("pr:diff-files", [{ ...commits, head: "0".repeat(40) }])).message, "Fetch this PR's commits to see its diff here.");
  await assert.rejects(second.call("pr:diff-files", [{ ...commits, cwd: "/tmp" }]), { code: "GIT_SCOPE" });
  assert.equal((await second.call("pr:diff-file", [{ ...commits, path: "../escape" }])).ok, false);

  await assert.rejects(second.call("git:changes", [{ cwd: "/tmp" }]), { code: "GIT_SCOPE" });
  await second.call("terminal:close", [{ terminalId: terminal.id }]);
  assert.equal((await second.call("terminal:read", [{ terminalId: terminal.id, after: read.offset }])).ended, true);
  list = await second.call("terminal:list", [{ chatId }]);
  assert.deepEqual(list.terminals, []);
  // Stop with another real PTY still open. Pending cleanup must precede owner lock release.
  const last = await second.call("terminal:open", [{ chatId }]);
  assert.ok(last.id);
  await second.call("terminal:input", [
    { terminalId: last.id, data: "trap '' HUP TERM; printf '\\150\\145\\154\\144\\055\\143\\154\\145\\141\\156\\165\\160\\012'\n" },
  ]);
  let held;
  const heldUntil = Date.now() + 5000;
  do {
    held = await second.call("terminal:read", [{ terminalId: last.id, after: 0 }]);
    if (held.data.includes("held-cleanup\r\n")) break;
    await pause(10);
  } while (Date.now() < heldUntil);
  assert.ok(held.data.includes("held-cleanup\r\n"));
  let pendingCleanup = 0;
  const stopUntil = Date.now() + 10000;
  for (;;) {
    try {
      await second.call("daemon:stop");
      break;
    } catch (error) {
      if (error.code !== "QUIT_PENDING" || Date.now() > stopUntil) throw error;
      pendingCleanup++;
      assert.ok(fs.existsSync(path.join(project, ".milagre/runtime.lock")));
      await pause(20);
    }
  }
  assert.ok(pendingCleanup > 0, "the signal-ignoring shell must retain owner shutdown");
  client.close();
  second.close();
  child.stdin.end();
  assert.deepEqual(await deadline(exit, "process exit"), { code: 0, signal: null });
  assert.equal(stderr, "");
  assert.equal(fs.existsSync(receipt.profile), false);
  assert.equal(fs.existsSync(receipt.socket), false);
  assert.equal(fs.existsSync(path.join(project, ".milagre/runtime.lock")), false);
  assert.equal(fs.existsSync(project), true);
  succeeded = true;
  console.log(JSON.stringify({ configuredTerminal: true, realPty: true, reconnect: true, longPollOutsideActor: true, cleanup: true }));
})()
  .catch((e) => {
    console.error(e.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    client?.close();
    second?.close();
    child.stdin.end();
    try {
      await deadline(exit, "failure teardown", 12000);
    } catch {
      child.kill("SIGKILL");
      await exit;
    }
    if (succeeded) fs.rmSync(root, { recursive: true, force: true });
  });
