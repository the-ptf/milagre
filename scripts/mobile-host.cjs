const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { parseArgs } = require("node:util");
const { spawn } = require("node:child_process");
const { startDaemon } = require("../apps/daemon/src/server.cjs");
const { startMobileBridge } = require("../apps/daemon/src/mobile-bridge.cjs");
const { connect } = require("../apps/daemon/src/client.cjs");
const { ensureDaemon } = require("../apps/daemon/src/bootstrap.cjs");
const { version } = require("../package.json");
const { printPairing } = require("./mobile-pairing.cjs");
const { startNamedTunnel, startQuickTunnel } = require("./mobile-tunnel.cjs");
const { readCloudflare } = require("./mobile-cloudflare.cjs");

async function readToken(file) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") return randomBytes(32).toString("hex");
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid()))
      throw new Error("Connection file must be private to your account with permissions 0600. Remove it after the host stops to create a new token.");
    const value = JSON.parse(await handle.readFile("utf8"));
    if (!/^[a-f0-9]{64}$/i.test(value.token)) throw new Error("Connection file has an invalid token. Move it aside after the host stops to pair again.");
    return value.token;
  } finally {
    await handle.close();
  }
}

async function startMobileHost({
  dataDir,
  desktopDataDir,
  project,
  port = 8787,
  publicUrl,
  tunnel: tunnelMode,
  runtimeOptions,
  tunnels = { startNamedTunnel, startQuickTunnel },
} = {}) {
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error("Use an absolute data directory.");
  if (project && !path.isAbsolute(project)) throw new Error("Use an absolute Project path.");
  if (publicUrl) {
    const url = new URL(publicUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new Error("The public URL must be an HTTPS origin without credentials or a path.");
    publicUrl = url.origin;
  }
  if (tunnelMode && publicUrl) throw new Error("Use either a tunnel or --public-url, not both.");
  const cloudflare = tunnelMode === "cloudflare" ? await readCloudflare(dataDir) : null;
  if (cloudflare) port = cloudflare.port;
  if (desktopDataDir && !path.isAbsolute(desktopDataDir)) throw new Error("Use an absolute desktop data directory.");
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const runtimeDir = desktopDataDir || dataDir;
  const daemon = desktopDataDir
    ? await ensureDaemon({ dataDir: desktopDataDir, version, cwd: os.homedir() })
    : await startDaemon({ dataDir, version, runtimeOptions });
  const connectionFile = path.join(dataDir, "mobile-connection.json");
  let bridge, socket, tunnel, closing;
  const close = () =>
    (closing ??= (async () => {
      await tunnel?.close();
      await bridge?.close();
      socket?.close();
      await daemon.close();
    })());
  try {
    const token = await readToken(connectionFile);
    bridge = await startMobileBridge({ dataDir: runtimeDir, port, token });
    if (cloudflare) tunnel = await tunnels.startNamedTunnel({ hostname: cloudflare.hostname, connectorToken: cloudflare.connectorToken });
    else if (tunnelMode === "quick") tunnel = await tunnels.startQuickTunnel({ port: new URL(bridge.url).port });
    if (tunnel) publicUrl = tunnel.url;
    if (project) {
      socket = await connect({ dataDir: runtimeDir });
      await socket.call("project:open", [project]);
      socket.close();
      socket = null;
    }
    const temporary = `${connectionFile}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ url: publicUrl || bridge.url, token }, null, 2), { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, connectionFile);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return {
      url: publicUrl || bridge.url,
      localUrl: bridge.url,
      token,
      lost: bridge.lost,
      ...(cloudflare ? { access: cloudflare.access } : {}),
      connectionFile,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string", default: path.join(os.homedir(), ".milagre-mobile") },
      desktop: { type: "boolean" },
      "desktop-data-dir": { type: "string" },
      project: { type: "string" },
      port: { type: "string", default: "8787" },
      "public-url": { type: "string" },
      tunnel: { type: "boolean" },
      cloudflare: { type: "boolean" },
      "stay-awake": { type: "boolean" },
      "no-qr": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "npm run mobile:host -- [--data-dir /absolute/profile] [--project /absolute/Project] [--port 8787] [--public-url https://host.example | --tunnel | --cloudflare] [--desktop | --desktop-data-dir /absolute/userData] [--stay-awake] [--no-qr]\n--desktop shares the Milagre app's daemon and Projects (its data in ~/Library/Application Support/Milagre); --data-dir then only keeps the phone's token and tunnel secrets.\n--tunnel opens a temporary Cloudflare Quick Tunnel; --cloudflare runs the tunnel set up by mobile:cloudflare, so the phone reaches this Mac from any network.\nPrints a QR code and link for the app to pair; --no-qr prints only the link. Separate real-provider host; never opens the development Project by default. Ctrl+C stops it. Tokens stay in the private connection file and can be reused after restart.",
    );
    return;
  }
  const host = await startMobileHost({
    dataDir: values["data-dir"],
    project: values.project,
    port: Number(values.port),
    desktopDataDir: values["desktop-data-dir"] || (values.desktop ? path.join(os.homedir(), "Library/Application Support/Milagre") : undefined),
    publicUrl: values["public-url"],
    tunnel: values.cloudflare ? "cloudflare" : values.tunnel ? "quick" : undefined,
  });
  let awake;
  if (values["stay-awake"] && process.platform === "darwin") {
    awake = spawn("/usr/bin/caffeinate", ["-i"], { stdio: "ignore" });
    awake.on("error", (error) => console.error(`Keep awake unavailable: ${error.message}`));
  }
  let stopping = false;
  const stop = async () => {
    stopping = true;
    awake?.kill("SIGTERM");
    await host.close();
  };
  // A bridge that lost its daemon would leave the tunnel answering 502. Exit instead, so launchd (or the user) starts
  void host.lost.then(async () => {
    if (stopping) return;
    console.error("The host lost its connection to the Milagre daemon. Exiting so it can restart.");
    await stop().catch(() => {});
    process.exit(1);
  });
  process.once(
    "SIGINT",
    () =>
      void stop().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      }),
  );
  process.once(
    "SIGTERM",
    () =>
      void stop().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      }),
  );
  console.log(
    `Milagre host: ${host.url}\nConnection details: ${host.connectionFile}\nUses installed Codex and Claude. Close a Project in other Milagre hosts before opening it here. Ctrl+C stops this host.`,
  );
  printPairing({ address: host.url, token: host.token, access: host.access, qr: !values["no-qr"] });
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { startMobileHost };
