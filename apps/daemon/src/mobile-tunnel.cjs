const { spawn: spawnProcess } = require("node:child_process");
const { ensureCloudflared } = require("./cloudflared.cjs");

const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const READY = /Registered tunnel connection/;

/**
 * Runs cloudflared until it registers with Cloudflare's edge. Logging stays at info: debug logs request headers, and
 * those carry the connection token.
 */
function runCloudflared({ args, quick, binary, spawn = spawnProcess, timeoutMs = 30000 }) {
  if (!binary) return ensureCloudflared().then((managed) => runCloudflared({ args, quick, binary: managed, spawn, timeoutMs }));
  const child = spawn(binary, ["tunnel", "--no-autoupdate", "--loglevel", "info", ...args], { stdio: ["ignore", "ignore", "pipe"] });
  const close = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
  return new Promise((resolve, reject) => {
    let url = "";
    let log = "";
    const fail = (error) => {
      clearTimeout(timer);
      void close();
      reject(error);
    };
    const timer = setTimeout(
      () =>
        fail(
          new Error(
            `cloudflared did not open a tunnel within ${Math.round(timeoutMs / 1000)} seconds.${log ? ` Last output: ${log.trim().split("\n").at(-1)}` : ""}`,
          ),
        ),
      timeoutMs,
    );
    child.once("error", (error) => fail(error.code === "ENOENT" ? new Error("Milagre couldn't start phone access. Restart Milagre and try again.") : error));
    child.once("exit", (code) => {
      if ((quick && !url) || !READY.test(log)) fail(new Error(`cloudflared stopped (exit ${code}) before the tunnel was ready.`));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      log = (log + chunk).slice(-4000);
      if (quick) url ||= QUICK_URL.exec(log)?.[0] || "";
      if ((!quick || url) && READY.test(log)) {
        clearTimeout(timer);
        resolve({ url, close });
      }
    });
  });
}

/**
 * A Cloudflare Quick Tunnel to the loopback bridge: no account, a random trycloudflare.com URL that lasts while it runs.
 * The bridge only accepts its own loopback Host, so cloudflared rewrites it.
 */
function startQuickTunnel({ port, ...options }) {
  return runCloudflared({ ...options, quick: true, args: ["--url", `http://127.0.0.1:${port}`, "--http-host-header", `127.0.0.1:${port}`] });
}

/** The named tunnel `mobile:cloudflare` set up. Its hostname, port and Host rewrite live in Cloudflare's remote config. */
async function startNamedTunnel({ hostname, connectorToken, ...options }) {
  const tunnel = await runCloudflared({ ...options, args: ["run", "--token", connectorToken] });
  return { ...tunnel, url: `https://${hostname}` };
}

module.exports = { startQuickTunnel, startNamedTunnel };
