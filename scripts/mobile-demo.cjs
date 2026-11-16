const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { startDaemon } = require("../apps/daemon/src/server.cjs");
const { startMobileBridge } = require("../apps/daemon/src/mobile-bridge.cjs");
const { connect } = require("../apps/daemon/src/client.cjs");
const { startMetro } = require("./start-mobile.cjs");
const { printPairing } = require("./mobile-pairing.cjs");
const { demoRuntimeOptions } = require("../apps/daemon/src/demo-agent.cjs");

async function startDemo({ port = 8787 } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-mobile-demo-")));
  const dataDir = path.join(root, "profile");
  const project = path.join(root, "Mobile playground");
  let daemon, bridge, client;
  const close = async () => {
    await bridge?.close();
    client?.close();
    await daemon?.close();
  };
  try {
    await fs.mkdir(project);
    execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
    await fs.writeFile(path.join(project, "README.md"), "# Mobile playground\n\nA temporary Project for trying Milagre.\n");
    await fs.writeFile(path.join(project, ".gitignore"), ".milagre/\n");
    execFileSync("git", ["-C", project, "add", "README.md", ".gitignore"], { stdio: "ignore" });
    execFileSync("git", ["-C", project, "-c", "user.name=Milagre Demo", "-c", "user.email=demo@example.invalid", "commit", "-m", "Create mobile playground"], {
      stdio: "ignore",
    });
    await fs.appendFile(path.join(project, "README.md"), "\nThis change is ready to review from mobile.\n");
    daemon = await startDaemon({
      dataDir,
      version: "0.1.0-demo",
      runtimeOptions: demoRuntimeOptions({ cwd: project, worktreeRoot: path.join(root, "worktrees") }),
    });
    client = await connect({ dataDir });
    const opened = await client.call("project:open", [project]);
    const chat = Object.values(opened.state.sessions)[0];
    await client.call("chat:patch", [project, chat.id, { title: "Hello from your Mac" }]);
    await client.call("chat:git-note", [
      `${project}#${chat.id}`,
      "Welcome to the local mobile preview. Send a message to try the connection. This demo agent runs without a provider account.",
    ]);
    const token = randomBytes(32).toString("hex");
    bridge = await startMobileBridge({ dataDir, port, token });
    const details = { url: bridge.url, token, dataDir, project, root, pid: process.pid };
    await fs.writeFile(path.join(root, "connection.json"), JSON.stringify(details, null, 2), { mode: 0o600, flag: "wx" });
    return { ...details, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function main() {
  const demo = await startDemo({ port: Number(process.env.MILAGRE_MOBILE_PORT || 8787) });
  console.log(
    `Demo Project: ${demo.project}\nConnection details: ${path.join(demo.root, "connection.json")}\nBridge: ${demo.url}\nPress Shift+i to choose the Milagre Local simulator. Ctrl+C stops the demo and Metro.`,
  );
  printPairing({ address: demo.url, token: demo.token });
  const metro = startMetro({ ...process.env, EXPO_PUBLIC_DAEMON_URL: demo.url, EXPO_PUBLIC_DAEMON_TOKEN: demo.token, EXPO_PUBLIC_DEMO: "1" });
  let stopping;
  const stop = () =>
    (stopping ??= (async () => {
      metro.kill("SIGTERM");
      await demo.close();
    })());
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  metro.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
    void stop();
  });
  metro.once("exit", (code) => {
    if (!stopping && code) process.exitCode = code;
    void stop();
  });
}
if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { startDemo };
