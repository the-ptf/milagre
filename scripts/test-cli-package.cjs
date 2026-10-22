// Install the release tarball outside the checkout, then exercise the installed command.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const exec = promisify(execFile);

async function main() {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-cli-install-")));
  let child, exited;
  try {
    const { packageCli } = require("./package-cli.cjs");
    const archive = await packageCli({ outDir: path.join(temp, "release") });
    const prefix = path.join(temp, "installed");
    await exec("npm", ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", archive], {
      cwd: temp,
      timeout: 180000,
      maxBuffer: 4 * 1024 * 1024,
      shell: process.platform === "win32",
    });
    const bin = path.join(prefix, process.platform === "win32" ? "milagre.cmd" : "bin/milagre");
    const entry = path.join(prefix, process.platform === "win32" ? "node_modules" : "lib/node_modules", "milagre/src/command.cjs");
    const env = { ...process.env, MILAGRE_DATA_DIR: path.join(temp, "profile"), NODE_PATH: "" };
    const run = (args) => exec(bin, args, { cwd: temp, env, shell: process.platform === "win32" });
    const metadata = require("../apps/daemon/package.json");
    assert.equal((await run(["--version"])).stdout.trim(), metadata.cliVersion ?? metadata.version);
    assert.match((await run(["--help"])).stdout, /milagre serve/);
    assert.equal((await run(["help"])).stdout, (await run(["--help"])).stdout);
    assert.match((await run(["help", "serve"])).stdout, /--no-pair/);
    assert.match((await run(["help", "chat", "patch"])).stdout, /--session-id number/);
    // Loading the daemon alone does not load node-pty. Exercise the installed native addon and spawn-helper too.
    await exec(
      process.execPath,
      [
        "-e",
        `
      const assert = require("node:assert/strict");
      const installed = require("node:module").createRequire(process.argv[1]);
      assert.throws(() => installed.resolve("electron"), { code: "MODULE_NOT_FOUND" });
      const pty = installed("node-pty");
      const terminal = pty.spawn(process.execPath, ["-e", "process.stdout.write('CLI_PTY_READY')"], { cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
      let output = "";
      const timer = setTimeout(() => { terminal.kill(); throw new Error("Installed PTY timed out"); }, 10000);
      terminal.onData((data) => { output += data; });
      terminal.onExit(({ exitCode }) => { clearTimeout(timer); assert.equal(exitCode, 0); assert.match(output, /CLI_PTY_READY/); });
    `,
        entry,
      ],
      { cwd: temp, env, timeout: 15000 },
    );
    const project = path.join(temp, "project");
    await fs.mkdir(project);
    await exec("git", ["init", "-b", "main", project]);
    child = spawn(bin, ["serve", "--no-pair", "--project", project], {
      cwd: temp,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    exited = once(child, "exit");
    let output = "",
      errors = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    for (let i = 0; !output.includes("Milagre is running") && i < 1000; i++) {
      assert.equal(child.exitCode, null, errors);
      await delay(20);
    }
    assert.match(output, /Milagre is running/);
    assert.ok(JSON.parse((await run(["status"])).stdout).pid);
    const opened = JSON.parse((await run(["project", "current"])).stdout);
    assert.equal(opened.path, project);
    assert.ok(JSON.parse((await run(["command", "list"])).stdout).some((item) => item.name === "chat:send"));
    const chat = `${project}#${Object.values(opened.state.sessions)[0].id}`;
    assert.equal(JSON.parse((await run(["tasks", "read", "--chat", chat])).stdout).isError, false);
    assert.equal(JSON.parse((await run(["command", "describe", "tasks_set", "--chat", chat])).stdout).inputSchema.type, "object");
    await run(["computers", "setup-key", "--file", path.join(temp, "computer.key")]);
    await run([
      "chat",
      "patch",
      "--project-path",
      project,
      "--session-id",
      String(Object.values(opened.state.sessions)[0].id),
      "--patch",
      JSON.stringify({ title: "Packaged CLI" }),
    ]);
    await run(["computers", "enable"]);
    assert.equal(JSON.parse((await run(["computers", "list"])).stdout).enabled, true);
    await run(["stop"]);
    assert.equal((await exited)[0], 0, errors);
    console.log("PASS: installed milagre package runs a native PTY, serves, opens a Project, reports status and stops without the checkout or Electron");
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    if (exited) await exited;
    await fs.rm(temp, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
