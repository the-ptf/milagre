// Reopen a Rust-written throwaway profile in the production Node daemon, then stop it.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const readline = require("node:readline");
const repo = path.resolve(__dirname, "../../..");
const { connect } = require(path.join(repo, "apps/daemon/src/client.cjs"));
const root = fs.realpathSync(process.argv[2]);
assert(fs.existsSync(path.join(root, "MILAGRE-ISOLATED-COPY")));
const home = path.join(root, "node-home");
fs.mkdirSync(home, { recursive: true });
const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
const child = spawn(
  process.execPath,
  [
    path.join(repo, "apps/daemon/src/cli.cjs"),
    "serve",
    "--data-dir",
    path.join(root, "profile"),
    "--app-version",
    "cp4-rollback",
    "--cwd",
    "/",
    "--chats-home",
    path.join(root, "chats"),
    "--worktree-root",
    path.join(root, "worktrees"),
  ],
  { env, stdio: ["ignore", "pipe", "pipe"] },
);
const exited = once(child, "exit");
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr = (stderr + chunk).slice(-8192);
});
const deadline = setTimeout(() => {
  child.kill("SIGKILL");
}, 30000);
(async () => {
  let client;
  try {
    const lines = readline.createInterface({ input: child.stdout });
    const ready = await Promise.race([
      once(lines, "line").then(([line]) => JSON.parse(line)),
      exited.then(([code]) => {
        throw new Error(`Node exited ${code}: ${stderr}`);
      }),
    ]);
    assert.equal(ready.status, "ready");
    client = await connect({ dataDir: path.join(root, "profile") });
    const states = [];
    for (const name of ["alpha", "beta"]) {
      const project = await client.call("project:read", [path.join(root, name), { state: true }]);
      states.push(project.state);
    }
    assert.deepEqual(await client.call("daemon:stop", []), { stopping: true });
    client.close();
    client = null;
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    assert(!fs.existsSync(path.join(root, "profile/runtime.lock")));
    process.stdout.write(JSON.stringify(states));
  } finally {
    if (client) client.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    clearTimeout(deadline);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
