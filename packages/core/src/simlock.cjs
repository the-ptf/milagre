const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes, randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");

// Experimental: devices leased from a Simlock worker or gateway (https://github.com/callstackincubator/simlock).
// Milagre never installs or runs Simlock; the user's own worker or gateway owns the devices. A lease is opened through
// Milagre's pinned agent-device so agents drive the same session (agent-device cannot adopt a lease it did not take).
// A lease Milagre stops renewing (a crash, a quit) ends on its own one TTL later, so nothing is kept across restarts.

const AGENT_DEVICE_PATH = "/v1/agent-device";
const CATALOG_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
// The gateway queues a lease request for up to five and a half minutes when every device is busy.
const OPEN_TIMEOUT_MS = 7 * 60_000;
const COMMAND_TIMEOUT_MS = 2 * 60_000;
const CLOSE_TIMEOUT_MS = 20_000;
const RENEW_INTERVAL_MS = 2 * 60_000;
const LEASE_TTL_MS = 10 * 60_000;
const DEFAULTS = { enabled: false, gatewayUrl: "", agentToken: "", maxLeases: 2, maxLeaseMinutes: 60 };
const DEVICE_PREFIX = "simlock:";

const origin = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};
const trimUrl = (url) => url.trim().replace(/\/+$/, "");
const validGatewayUrl = (url) => /^https?:\/\/[^\s/]+$/.test(url) && origin(url) !== null;

/**
 * The gateway and token this machine's agent-device already uses: agent-device's remote-daemon variables, which Simlock
 * tells clients to set, else the profile a standalone worker writes for agents on its own Mac. Null when neither exists.
 */
function machineSimlock(env = process.env, home = os.homedir()) {
  const fromBase = (base, agentToken, source) => {
    const trimmed = typeof base === "string" ? trimUrl(base) : "";
    if (!trimmed.endsWith(AGENT_DEVICE_PATH) || typeof agentToken !== "string" || !agentToken.trim()) return null;
    const gatewayUrl = trimmed.slice(0, -AGENT_DEVICE_PATH.length);
    return validGatewayUrl(gatewayUrl) ? { gatewayUrl, agentToken: agentToken.trim(), source } : null;
  };
  const fromEnv = fromBase(env.AGENT_DEVICE_DAEMON_BASE_URL, env.AGENT_DEVICE_DAEMON_AUTH_TOKEN, "env");
  if (fromEnv) return fromEnv;
  try {
    const profile = JSON.parse(fs.readFileSync(path.join(home, ".simlock", "agent-device-profile.json"), "utf8"));
    return fromBase(profile?.daemonBaseUrl, profile?.daemonAuthToken, "worker");
  } catch {
    return null;
  }
}

function normalize(value) {
  const input = value && typeof value === "object" ? value : {};
  const int = (number, min, max, fallback) => (Number.isInteger(number) && number >= min && number <= max ? number : fallback);
  return {
    enabled: input.enabled === true,
    gatewayUrl: typeof input.gatewayUrl === "string" && validGatewayUrl(trimUrl(input.gatewayUrl)) ? trimUrl(input.gatewayUrl) : "",
    agentToken: typeof input.agentToken === "string" ? input.agentToken.trim().slice(0, 4096) : "",
    // The gateway origin the token was saved for; it is sent nowhere else, even when detection later finds another.
    tokenOrigin: typeof input.tokenOrigin === "string" ? input.tokenOrigin : "",
    maxLeases: int(input.maxLeases, 1, 20, DEFAULTS.maxLeases),
    maxLeaseMinutes: int(input.maxLeaseMinutes, 5, 240, DEFAULTS.maxLeaseMinutes),
  };
}

/**
 * The pool's settings, kept by the host in a private file. Clients read everything but the token, which only the host
 * sends, and only to the gateway it was saved for.
 */
function createSimlockSettings({ file, emit = () => {}, env = process.env, home = os.homedir() }) {
  function stored() {
    try {
      return normalize(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      return normalize(null);
    }
  }
  function resolved() {
    const value = stored();
    const machine = machineSimlock(env, home);
    const gatewayUrl = value.gatewayUrl || machine?.gatewayUrl || "";
    const saved = value.agentToken && value.tokenOrigin && value.tokenOrigin === origin(gatewayUrl) ? value.agentToken : "";
    const agentToken = saved || (machine && origin(machine.gatewayUrl) === origin(gatewayUrl) ? machine.agentToken : "");
    const tokenSource = saved ? "settings" : agentToken ? machine.source : null;
    const { tokenOrigin: _origin, ...rest } = value;
    return { ...rest, gatewayUrl, agentToken, tokenSource, detected: machine ? { gatewayUrl: machine.gatewayUrl, source: machine.source } : null };
  }
  function read() {
    const { agentToken, ...rest } = resolved();
    return { ...rest, savedGatewayUrl: stored().gatewayUrl, hasToken: !!agentToken };
  }
  function save(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Simlock settings must be an object.");
    if (patch.gatewayUrl !== undefined) {
      if (typeof patch.gatewayUrl !== "string") throw new Error("The Simlock gateway URL must be text.");
      const url = trimUrl(patch.gatewayUrl);
      if (url && !validGatewayUrl(url)) throw new Error("Enter the gateway's origin, such as https://gateway.example.ts.net:4700.");
    }
    if (patch.agentToken !== undefined && typeof patch.agentToken !== "string") throw new Error("The Simlock agent token must be text.");
    if (patch.maxLeases !== undefined && !(Number.isInteger(patch.maxLeases) && patch.maxLeases >= 1 && patch.maxLeases <= 20))
      throw new Error("Devices at once must be a whole number from 1 to 20.");
    if (patch.maxLeaseMinutes !== undefined && !(Number.isInteger(patch.maxLeaseMinutes) && patch.maxLeaseMinutes >= 5 && patch.maxLeaseMinutes <= 240))
      throw new Error("A lease's longest time must be a whole number of minutes from 5 to 240.");
    const current = stored();
    const next = normalize({ ...current, ...patch });
    // A token belongs to the gateway in effect when it was entered: the saved one, else the one detected on this Mac then.
    // A new gateway without a new token drops the old one.
    if (patch.gatewayUrl !== undefined && origin(next.gatewayUrl) !== origin(current.gatewayUrl) && patch.agentToken === undefined) next.agentToken = "";
    if (patch.agentToken !== undefined)
      next.tokenOrigin = next.agentToken ? (origin(next.gatewayUrl || machineSimlock(env, home)?.gatewayUrl || "") ?? "") : "";
    if (!next.agentToken) next.tokenOrigin = "";
    if (next.agentToken && !next.tokenOrigin) throw new Error("Enter the gateway this token belongs to, or start a Simlock worker on this Mac.");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    const view = read();
    emit("simlock:settings", view);
    return view;
  }
  return { read, save, resolved };
}

// agent-device's exports leave out its package.json; find it where Node would resolve the package.
function agentDevicePackage() {
  for (const directory of require.resolve.paths("agent-device") ?? []) {
    const candidate = path.join(directory, "agent-device", "package.json");
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("agent-device is not installed.");
}

/** Milagre's own agent-device CLI, run with the host's Node so a lease never depends on the npm registry. */
function resolveAgentDevice(packagePath = agentDevicePackage()) {
  const root = path.dirname(packagePath.replace(/\.asar([/\\])/, ".asar.unpacked$1"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["agent-device"];
  if (typeof bin !== "string") throw new Error("agent-device has no command.");
  return { nodePath: process.execPath, entryPath: path.join(root, bin), version: manifest.version };
}

// The variables that would point the CLI at another daemon or session than the lease's own.
const AGENT_DEVICE_OVERRIDES = /^AGENT_DEVICE_(DAEMON_BASE_URL|DAEMON_AUTH_TOKEN|CONFIG|STATE_DIR|SESSION)$/;
function cliEnvironment(env) {
  return {
    ...Object.fromEntries(Object.entries(env).filter(([name]) => !AGENT_DEVICE_OVERRIDES.test(name))),
    ELECTRON_RUN_AS_NODE: "1",
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
}

// Past its deadline a command gets SIGTERM, then SIGKILL after this grace; the call settles at the kill either way,
// so a child that ignores signals or a grandchild holding its pipes can never stall a release or host shutdown.
const KILL_GRACE_MS = 3000;
function runCli({ nodePath, entryPath }, args, { cwd, env, timeoutMs, killGraceMs = KILL_GRACE_MS }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(nodePath, [entryPath, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "",
      stderr = "",
      settled = false,
      killTimer = null;
    const settle = (result, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (error) reject(error);
      else resolve(result);
    };
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 1_048_576) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 65_536) stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        settle({ code: null, signal: "SIGKILL", stdout, stderr });
      }, killGraceMs);
    }, timeoutMs);
    child.on("error", (error) => settle(null, error));
    child.on("close", (code, signal) => settle({ code, signal, stdout, stderr }));
  });
}

/** The CLI's own failure message, without its log paths. */
function cliFailure(result, command) {
  try {
    const error = JSON.parse(result.stdout)?.error;
    if (typeof error?.message === "string") return error.hint ? `${error.message} ${error.hint}` : error.message;
  } catch {}
  if (result.signal) return `agent-device ${command} timed out.`;
  return `agent-device ${command} failed (exit code ${result.code ?? "none"}).`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * The command an agent runs to drive one lease: the pinned CLI bound to the lease's session and config, refusing the
 * commands that would end or replace Milagre's connection (simulator_release ends a lease).
 */
function launcherScript({ nodePath, entryPath }, { session, configPath, leaseId }) {
  return [
    "#!/bin/sh",
    `# Milagre: agent-device bound to Simlock lease ${leaseId}. Generated; do not edit.`,
    'case "$1" in',
    "  connect|disconnect|close)",
    '    echo "This command is bound to a Milagre Simlock lease. Use simulator_release to return the device; Milagre keeps the connection." >&2',
    "    exit 2",
    "    ;;",
    "esac",
    "unset AGENT_DEVICE_DAEMON_BASE_URL AGENT_DEVICE_DAEMON_AUTH_TOKEN AGENT_DEVICE_CONFIG AGENT_DEVICE_STATE_DIR AGENT_DEVICE_SESSION",
    "export ELECTRON_RUN_AS_NODE=1 AGENT_DEVICE_NO_UPDATE_NOTIFIER=1",
    `exec ${shellQuote(nodePath)} ${shellQuote(entryPath)} "$@" --session ${shellQuote(session)} --config ${shellQuote(configPath)}`,
    "",
  ].join("\n");
}

function gatewayFailure(error, gatewayUrl) {
  if (error?.status === 401 || error?.status === 403) return "The Simlock gateway refused the agent token.";
  if (error?.status) return `The Simlock gateway at ${gatewayUrl} answered HTTP ${error.status}.`;
  if (error?.invalid) return `The Simlock gateway at ${gatewayUrl} sent an answer Milagre could not read.`;
  return `Could not reach the Simlock gateway at ${gatewayUrl}.`;
}

/** Catalog models agents and people can lease: phones and tablets with a runtime and, through a gateway, a worker. */
function catalogDevices(catalog) {
  const devices = [];
  for (const entry of Array.isArray(catalog?.platforms) ? catalog.platforms : []) {
    if (entry?.platform !== "ios" && entry?.platform !== "android") continue;
    for (const [model, runtimes] of Object.entries(entry.modelRuntimes ?? {})) {
      if (!Array.isArray(runtimes) || runtimes.length === 0 || typeof model !== "string" || model.length > 200) continue;
      const kind = entry.modelClasses?.[model];
      if (kind !== undefined && kind !== "phone" && kind !== "tablet") continue;
      const workers = entry.modelWorkers?.[model];
      if (workers !== undefined && (!Array.isArray(workers) || workers.length === 0)) continue;
      devices.push({ platform: entry.platform, model, version: String(runtimes.at(-1)).slice(0, 40), kind: kind ?? "phone" });
    }
  }
  return devices;
}

/** Leases from the configured pool: open, keep alive, return. Device ids are `simlock:<leaseId>`. */
function createSimlockHost({
  settings,
  directory,
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  agentDevice = () => resolveAgentDevice(),
  run = runCli,
  now = Date.now,
  log = () => {},
  renewIntervalMs = RENEW_INTERVAL_MS,
}) {
  // Folders a previous run left: their leases end on their own one TTL after it stopped renewing them.
  fs.rmSync(directory, { recursive: true, force: true });
  const leases = new Map();
  let starting = 0,
    stops = 0,
    catalog = null,
    stopped = false;

  function config() {
    const value = settings.resolved();
    if (!value.enabled) throw new Error("Turn on Simlock devices in Settings › Experimental first.");
    if (!value.gatewayUrl) throw new Error("Add a Simlock gateway in Settings › Experimental, or start a Simlock worker on this Mac.");
    if (!value.agentToken) throw new Error("Add an agent token for the Simlock gateway in Settings › Experimental.");
    return value;
  }

  async function request(value, method, route, body) {
    let response;
    try {
      response = await fetchImpl(`${value.gatewayUrl}${route}`, {
        method,
        headers: { authorization: `Bearer ${value.agentToken}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw Object.assign(new Error(gatewayFailure(null, value.gatewayUrl)), { cause });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new Error(gatewayFailure({ status: response.status }, value.gatewayUrl)), { status: response.status });
    }
    try {
      return await response.json();
    } catch {
      throw new Error(gatewayFailure({ invalid: true }, value.gatewayUrl));
    }
  }

  async function models() {
    const value = config();
    const key = `${value.gatewayUrl}\n${value.agentToken}`;
    if (catalog && catalog.key === key && now() - catalog.at < CATALOG_TTL_MS) return structuredClone(catalog.devices);
    const devices = catalogDevices(await request(value, "GET", "/v1/catalog"));
    // An empty platform is usually its workers reconnecting; caching that would hide it for the TTL.
    catalog = devices.length > 0 ? { key, at: now(), devices } : null;
    return structuredClone(devices);
  }

  /** Who a gateway says a token is. A URL or token given here is checked without saving it. */
  async function identity(input = {}) {
    const value = settings.resolved();
    const gatewayUrl = typeof input.gatewayUrl === "string" && input.gatewayUrl.trim() ? trimUrl(input.gatewayUrl) : value.gatewayUrl;
    if (!validGatewayUrl(gatewayUrl)) throw new Error("Enter the gateway's origin, such as https://gateway.example.ts.net:4700.");
    // A saved token goes only to the gateway it was saved for.
    const agentToken =
      typeof input.agentToken === "string" && input.agentToken.trim()
        ? input.agentToken.trim()
        : origin(gatewayUrl) === origin(value.gatewayUrl)
          ? value.agentToken
          : "";
    if (!agentToken) throw new Error("Add an agent token for this gateway.");
    const answer = await request({ gatewayUrl, agentToken }, "GET", "/v1/identity");
    if (typeof answer?.name !== "string" || typeof answer?.role !== "string") throw new Error(gatewayFailure({ invalid: true }, gatewayUrl));
    return { name: answer.name.slice(0, 200), role: answer.role.slice(0, 40), gatewayUrl };
  }

  function view(lease) {
    return {
      deviceId: lease.deviceId,
      leaseId: lease.leaseId,
      platform: lease.platform,
      name: lease.name,
      version: lease.version,
      chatId: lease.chatId,
      startedAt: lease.startedAt,
      endsAt: lease.endsAt,
    };
  }

  async function cli(lease, args, options = {}) {
    const result = await run(lease.cli, [...args, "--session", lease.session, "--config", lease.configPath, "--json"], {
      cwd: options.cwd ?? lease.dir,
      env: cliEnvironment(env),
      timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    });
    if (result.code !== 0) throw new Error(cliFailure(result, args[0]));
    try {
      return JSON.parse(result.stdout)?.data ?? {};
    } catch {
      return {};
    }
  }

  function forget(lease) {
    clearTimeout(lease.timer);
    leases.delete(lease.deviceId);
    fs.rmSync(lease.dir, { recursive: true, force: true });
  }

  async function end(lease, value = settings.resolved()) {
    if (!leases.has(lease.deviceId)) return;
    clearTimeout(lease.timer);
    try {
      // A frozen device can hold close for minutes; past this, the HTTP release below ends the lease at once.
      await cli(lease, ["close"], { timeoutMs: CLOSE_TIMEOUT_MS });
    } catch (error) {
      // The session is gone (a restarted worker, a deleted folder) or close timed out: end the lease over HTTP instead.
      await request(
        { gatewayUrl: lease.gatewayUrl, agentToken: lease.agentToken ?? value.agentToken },
        "DELETE",
        `/v1/leases/${encodeURIComponent(lease.leaseId)}`,
      ).catch((cause) =>
        log("simlock release failed", { leaseId: lease.leaseId, error: String(error?.message ?? error), cause: String(cause?.message ?? cause) }),
      );
    }
    forget(lease);
  }

  function scheduleRenewal(lease) {
    const left = lease.endsAt - now();
    if (left <= 0) {
      log("simlock lease reached its maximum age", { leaseId: lease.leaseId });
      void end(lease);
      return;
    }
    lease.timer = setTimeout(
      async () => {
        if (!leases.has(lease.deviceId)) return;
        if (now() >= lease.endsAt) return scheduleRenewal(lease);
        try {
          await request(lease, "POST", `/v1/leases/${encodeURIComponent(lease.leaseId)}/renew`, { ttlMs: LEASE_TTL_MS });
        } catch (error) {
          // Simlock ended it (lost device, its TTL, a close from elsewhere): stop listing it.
          if (error.status === 404) return forget(lease);
          log("simlock renew failed", { leaseId: lease.leaseId, error: String(error.message) });
        }
        if (leases.has(lease.deviceId)) scheduleRenewal(lease);
      },
      Math.min(left, renewIntervalMs),
    );
    lease.timer.unref?.();
  }

  /** Takes a lease of `model` on `platform`. `installDirectory` is the folder agent-device accepts installs from. */
  async function openLease({ platform, model, chatId = null, installDirectory } = {}) {
    if (stopped) throw new Error("Simlock is stopping.");
    if (platform !== "ios" && platform !== "android") throw new Error("Choose ios or android.");
    if (model !== undefined && (typeof model !== "string" || !model.trim() || model.length > 200)) throw new Error("Invalid Simlock device model.");
    const value = config();
    if (leases.size + starting >= value.maxLeases)
      throw new Error(
        `Simlock is limited to ${value.maxLeases} ${value.maxLeases === 1 ? "device" : "devices"} at once. Return one first, or raise the limit in Settings › Experimental.`,
      );
    let tool;
    try {
      tool = agentDevice();
    } catch {
      throw new Error("Milagre's agent-device is missing. Reinstall Milagre.");
    }
    starting++;
    const stopsAtOpen = stops;
    const suffix = randomBytes(6).toString("hex");
    const dir = path.join(directory, suffix);
    const pending = {
      cli: tool,
      session: `milagre-${suffix}`,
      dir,
      configPath: path.join(dir, "agent-device.json"),
    };
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        pending.configPath,
        JSON.stringify({ daemonBaseUrl: `${value.gatewayUrl}${AGENT_DEVICE_PATH}`, daemonAuthToken: value.agentToken, stateDir: dir }),
        { mode: 0o600 },
      );
      // agent-device accepts installs only from the folder `open` ran in: the Chat's own, never a fallback.
      let cwd;
      try {
        cwd = fs.realpathSync(installDirectory);
        if (!fs.statSync(cwd).isDirectory()) throw new Error("not a folder");
      } catch {
        throw new Error("This Chat's folder isn't available on this Mac, so a leased device couldn't install its builds.");
      }
      await cli(pending, ["connect", "proxy", "--daemon-base-url", `${value.gatewayUrl}${AGENT_DEVICE_PATH}`]);
      const opened = await cli(pending, ["open", "--platform", platform, ...(model ? ["--device", model.trim()] : [])], {
        cwd,
        timeoutMs: OPEN_TIMEOUT_MS,
      });
      let leaseId;
      try {
        leaseId = JSON.parse(fs.readFileSync(path.join(dir, "remote-connections", `${pending.session}.json`), "utf8"))?.leaseId;
      } catch {}
      if (typeof leaseId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(leaseId)) throw new Error("agent-device recorded no Simlock lease.");
      if (stops !== stopsAtOpen || stopped) throw new Error("Simlock stopped while the device was opening.");
      const leased = opened?.lease?.device ?? {};
      const launcher = path.join(dir, "agent-device");
      fs.writeFileSync(launcher, launcherScript(tool, { session: pending.session, configPath: pending.configPath, leaseId }), { mode: 0o700 });
      const record = {
        ...pending,
        deviceId: `${DEVICE_PREFIX}${leaseId}`,
        leaseId,
        platform,
        name: typeof leased.model === "string" ? leased.model.slice(0, 200) : (model ?? (platform === "ios" ? "iPhone" : "Android device")),
        version: typeof leased.osVersion === "string" ? leased.osVersion.slice(0, 40) : "",
        chatId,
        installDirectory: cwd,
        launcher,
        gatewayUrl: value.gatewayUrl,
        agentToken: value.agentToken,
        startedAt: now(),
        endsAt: now() + value.maxLeaseMinutes * 60_000,
        timer: null,
      };
      leases.set(record.deviceId, record);
      scheduleRenewal(record);
      return { ...view(record), launcher, installDirectory: cwd };
    } catch (error) {
      // A failed or interrupted open may still hold a lease: close the session either way.
      await cli(pending, ["close"]).catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    } finally {
      starting--;
    }
  }

  return {
    models,
    identity,
    lease: openLease,
    isDevice: (deviceId) => typeof deviceId === "string" && deviceId.startsWith(DEVICE_PREFIX),
    leases: () => [...leases.values()].map(view),
    get: (deviceId) => {
      const found = leases.get(deviceId);
      return found ? { ...view(found), launcher: found.launcher, installDirectory: found.installDirectory } : null;
    },
    /** Where a lease's screen and input are, with the header that admits them. Never leaves the host. */
    upstream(deviceId) {
      const found = leases.get(deviceId);
      if (!found) return null;
      const base = `${found.gatewayUrl}/v1/leases/${encodeURIComponent(found.leaseId)}`;
      return { stream: `${base}/stream`, input: `${base}/input`.replace(/^http/, "ws"), headers: { authorization: `Bearer ${found.agentToken}` } };
    },
    async release(deviceId) {
      const found = leases.get(deviceId);
      if (!found) throw new Error("That Simlock lease has already ended.");
      await end(found);
      return { released: deviceId };
    },
    async stop() {
      stopped = true;
      stops++;
      await Promise.all([...leases.values()].map((found) => end(found)));
    },
  };
}

module.exports = {
  createSimlockSettings,
  runCli,
  createSimlockHost,
  machineSimlock,
  catalogDevices,
  launcherScript,
  resolveAgentDevice,
  DEVICE_PREFIX,
};
