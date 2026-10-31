const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSimlockSettings, createSimlockHost, machineSimlock, catalogDevices, launcherScript, runCli } = require("./simlock.cjs");

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simlock-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const GATEWAY = "https://pool.example.ts.net:4700";
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, body: { cancel: async () => {} } });

test("machine token comes from agent-device's variables, else the local worker's profile", (t) => {
  const home = temp(t);
  assert.equal(machineSimlock({}, home), null);
  fs.mkdirSync(path.join(home, ".simlock"));
  fs.writeFileSync(
    path.join(home, ".simlock", "agent-device-profile.json"),
    JSON.stringify({ daemonBaseUrl: "http://127.0.0.1:4701/v1/agent-device", daemonAuthToken: "slk_local" }),
  );
  assert.deepEqual(machineSimlock({}, home), { gatewayUrl: "http://127.0.0.1:4701", agentToken: "slk_local", source: "worker" });
  assert.deepEqual(machineSimlock({ AGENT_DEVICE_DAEMON_BASE_URL: `${GATEWAY}/v1/agent-device/`, AGENT_DEVICE_DAEMON_AUTH_TOKEN: "slk_env" }, home), {
    gatewayUrl: GATEWAY,
    agentToken: "slk_env",
    source: "env",
  });
  // A daemon that is not a Simlock front is not a gateway.
  assert.equal(
    machineSimlock({ AGENT_DEVICE_DAEMON_BASE_URL: "https://cloud.example.com/agent", AGENT_DEVICE_DAEMON_AUTH_TOKEN: "x" }, temp(t))?.source,
    undefined,
  );
});

test("settings never show the token and keep it to the gateway it was saved for", (t) => {
  const dir = temp(t);
  const events = [];
  const settings = createSimlockSettings({ file: path.join(dir, "simlock.json"), emit: (...args) => events.push(args), env: {}, home: dir });
  assert.deepEqual(settings.read(), {
    enabled: false,
    gatewayUrl: "",
    maxLeases: 2,
    maxLeaseMinutes: 60,
    tokenSource: null,
    detected: null,
    savedGatewayUrl: "",
    hasToken: false,
  });
  const saved = settings.save({ enabled: true, gatewayUrl: `${GATEWAY}/`, agentToken: " slk_secret ", maxLeases: 3 });
  assert.equal(saved.gatewayUrl, GATEWAY);
  assert.equal(saved.hasToken, true);
  assert.equal(saved.tokenSource, "settings");
  assert.equal(JSON.stringify(saved).includes("slk_secret"), false);
  assert.equal(JSON.stringify(events).includes("slk_secret"), false);
  assert.equal(settings.resolved().agentToken, "slk_secret");
  assert.equal(fs.statSync(path.join(dir, "simlock.json")).mode & 0o777, 0o600);
  // Another gateway without a new token drops the old one.
  assert.equal(settings.save({ gatewayUrl: "https://other.example.com" }).hasToken, false);
  assert.throws(() => settings.save({ gatewayUrl: "https://pool.example.com/v1/agent-device" }), /gateway's origin/);
  assert.throws(() => settings.save([]), /object/);
  assert.throws(() => settings.save({ maxLeases: 99 }), /1 to 20/);
  assert.throws(() => settings.save({ maxLeaseMinutes: 1 }), /5 to 240/);
  assert.equal(settings.read().maxLeases, 3);
});

test("the catalog lists leasable phones and tablets with their newest OS", () => {
  const devices = catalogDevices({
    platforms: [
      {
        platform: "ios",
        modelRuntimes: { "iPhone 17": ["26.4", "27.0"], "Apple Watch Series 11 (46mm)": ["27.0"], "iPad Air": [], "iPhone Gone": ["27.0"] },
        modelClasses: { "iPhone 17": "phone", "Apple Watch Series 11 (46mm)": "watch", "iPhone Gone": "phone" },
        modelWorkers: { "iPhone 17": ["w1"], "iPhone Gone": [] },
      },
      { platform: "android", modelRuntimes: { "Pixel 9": ["15"] } },
      { platform: "tvos", modelRuntimes: { "Apple TV": ["27.0"] } },
    ],
  });
  assert.deepEqual(devices, [
    { platform: "ios", model: "iPhone 17", version: "27.0", kind: "phone" },
    { platform: "android", model: "Pixel 9", version: "15", kind: "phone" },
  ]);
});

test("the launcher binds the session and refuses commands that end Milagre's connection", () => {
  const script = launcherScript(
    { nodePath: "/App Support/node", entryPath: "/x/agent-device.mjs" },
    { session: "milagre-1", configPath: "/it's/agent-device.json", leaseId: "abc" },
  );
  assert.match(script, /connect\|disconnect\|close\)/);
  assert.match(script, /--session 'milagre-1' --config '\/it'\\''s\/agent-device.json'/);
  assert.match(script, /exec '\/App Support\/node' '\/x\/agent-device.mjs' "\$@"/);
  assert.match(script, /unset AGENT_DEVICE_DAEMON_BASE_URL/);
});

function hostFixture(t, { maxLeases = 2, failOpen = false, closeHangs = false, renew = () => json({}) } = {}) {
  const dir = temp(t);
  const settings = createSimlockSettings({ file: path.join(dir, "simlock.json"), env: {}, home: dir });
  settings.save({ enabled: true, gatewayUrl: GATEWAY, agentToken: "slk_t", maxLeases });
  const runs = [],
    requests = [];
  let leaseCount = 0;
  const host = createSimlockHost({
    settings,
    directory: path.join(dir, "leases"),
    env: { AGENT_DEVICE_SESSION: "theirs", PATH: "/bin" },
    agentDevice: () => ({ nodePath: "/node", entryPath: "/agent-device.mjs" }),
    renewIntervalMs: 5,
    fetch: async (url, init) => {
      requests.push({ url, method: init.method, auth: init.headers.authorization, body: init.body });
      if (url.endsWith("/renew")) return renew();
      if (url.endsWith("/v1/catalog")) return json({ platforms: [{ platform: "ios", modelRuntimes: { "iPhone 17": ["27.0"] } }] });
      return json({});
    },
    run: async (_cli, args, options) => {
      runs.push({ args, cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs });
      if (args[0] === "close" && closeHangs) return { code: null, signal: "SIGTERM", stdout: "" };
      const session = args[args.indexOf("--session") + 1];
      const config = JSON.parse(fs.readFileSync(args[args.indexOf("--config") + 1], "utf8"));
      if (args[0] === "open") {
        if (failOpen) return { code: 1, stdout: JSON.stringify({ error: { message: "timed out waiting for a device", hint: "nothing was leased" } }) };
        fs.mkdirSync(path.join(config.stateDir, "remote-connections"), { recursive: true });
        fs.writeFileSync(path.join(config.stateDir, "remote-connections", `${session}.json`), JSON.stringify({ leaseId: `lease${++leaseCount}` }));
        return { code: 0, stdout: JSON.stringify({ data: { lease: { device: { model: "iPhone 17", osVersion: "27.0" } } } }) };
      }
      return { code: 0, stdout: JSON.stringify({ data: {} }) };
    },
  });
  t.after(() => host.stop());
  return { host, runs, requests, dir };
}

test("a lease opens through agent-device in the Chat's folder and ends through it", async (t) => {
  const { host, runs, dir } = hostFixture(t);
  const lease = await host.lease({ platform: "ios", model: "iPhone 17", chatId: "/p#1", installDirectory: dir });
  assert.equal(lease.deviceId, "simlock:lease1");
  assert.equal(lease.name, "iPhone 17");
  assert.equal(lease.version, "27.0");
  assert.equal(lease.installDirectory, fs.realpathSync(dir));
  assert.deepEqual(
    runs.map((r) => r.args.slice(0, 3)),
    [
      ["connect", "proxy", "--daemon-base-url"],
      ["open", "--platform", "ios"],
    ],
  );
  assert.equal(runs[1].cwd, fs.realpathSync(dir));
  // The CLI never inherits another session or daemon.
  assert.equal(runs[0].env.AGENT_DEVICE_SESSION, undefined);
  assert.equal(runs[0].env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(fs.statSync(lease.launcher).mode & 0o777, 0o700);
  assert.deepEqual(host.upstream(lease.deviceId), {
    stream: `${GATEWAY}/v1/leases/lease1/stream`,
    input: `${GATEWAY.replace("https", "wss")}/v1/leases/lease1/input`,
    headers: { authorization: "Bearer slk_t" },
  });
  assert.equal(JSON.stringify(host.leases()).includes("slk_t"), false);
  await host.release(lease.deviceId);
  assert.deepEqual(runs.at(-1).args.slice(0, 1), ["close"]);
  assert.deepEqual(host.leases(), []);
  assert.equal(fs.existsSync(path.dirname(lease.launcher)), false);
  await assert.rejects(host.release(lease.deviceId), /already ended/);
});

test("leases stop at the limit and a failed open leaves nothing behind", async (t) => {
  const { host, dir } = hostFixture(t, { maxLeases: 1 });
  await host.lease({ platform: "ios", installDirectory: dir });
  await assert.rejects(host.lease({ platform: "ios", installDirectory: dir }), /limited to 1 device at once/);
  await assert.rejects(host.lease({ platform: "watchos", installDirectory: dir }), /ios or android/);

  const failing = hostFixture(t, { failOpen: true });
  await assert.rejects(failing.host.lease({ platform: "ios", installDirectory: failing.dir }), /timed out waiting for a device nothing was leased/);
  assert.equal(failing.runs.at(-1).args[0], "close");
  assert.deepEqual(failing.host.leases(), []);
});

test("renewals keep a lease, and a lease Simlock ended is forgotten", async (t) => {
  let status = 200;
  const { host, requests, dir } = hostFixture(t, { renew: () => json({}, status) });
  const lease = await host.lease({ platform: "ios", installDirectory: dir });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const renewal = requests.find((r) => r.url.endsWith("/renew"));
  assert.ok(renewal);
  assert.equal(renewal.auth, "Bearer slk_t");
  assert.deepEqual(JSON.parse(renewal.body), { ttlMs: 600000 });
  assert.equal(host.leases().length, 1);
  status = 404;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(host.leases(), []);
  assert.equal(host.get(lease.deviceId), null);
});

test("a disabled or unconfigured pool says what to set", async (t) => {
  const dir = temp(t);
  const settings = createSimlockSettings({ file: path.join(dir, "simlock.json"), env: {}, home: dir });
  const host = createSimlockHost({ settings, directory: path.join(dir, "leases") });
  await assert.rejects(host.models(), /Turn on Simlock devices/);
  settings.save({ enabled: true });
  await assert.rejects(host.lease({ platform: "ios" }), /Add a Simlock gateway/);
  settings.save({ gatewayUrl: GATEWAY });
  await assert.rejects(host.models(), /Add an agent token/);
});

test("identity checks a typed token without saving it, and a refused token says so", async (t) => {
  const dir = temp(t);
  const settings = createSimlockSettings({ file: path.join(dir, "simlock.json"), env: {}, home: dir });
  settings.save({ enabled: true, gatewayUrl: GATEWAY, agentToken: "slk_saved" });
  const seen = [];
  const host = createSimlockHost({
    settings,
    directory: path.join(dir, "leases"),
    fetch: async (url, init) => {
      seen.push({ url, auth: init.headers.authorization });
      return init.headers.authorization === "Bearer slk_bad" ? json({}, 401) : json({ name: "ui-agent", role: "agent", principal: "tok_1" });
    },
  });
  assert.deepEqual(await host.identity({}), { name: "ui-agent", role: "agent", gatewayUrl: GATEWAY });
  await assert.rejects(host.identity({ agentToken: "slk_bad" }), /refused the agent token/);
  // The saved token never goes to a gateway being typed in.
  await assert.rejects(host.identity({ gatewayUrl: "https://elsewhere.example.com" }), /Add an agent token/);
  assert.deepEqual(
    seen.map((s) => s.auth),
    ["Bearer slk_saved", "Bearer slk_bad"],
  );
});

test("a close that hangs on a frozen device falls back to ending the lease over HTTP", async (t) => {
  const { host, runs, requests, dir } = hostFixture(t, { closeHangs: true });
  const lease = await host.lease({ platform: "ios", installDirectory: dir });
  await host.release(lease.deviceId);
  const close = runs.find((r) => r.args[0] === "close");
  assert.equal(close.timeoutMs, 20000);
  assert.ok(requests.some((r) => r.method === "DELETE" && r.url.endsWith("/v1/leases/lease1") && r.auth === "Bearer slk_t"));
  assert.deepEqual(host.leases(), []);
});

test("a saved token goes only to the gateway in effect when it was saved, even when detection changes", (t) => {
  const home = temp(t);
  fs.mkdirSync(path.join(home, ".simlock"));
  const profile = (url, token) =>
    fs.writeFileSync(
      path.join(home, ".simlock", "agent-device-profile.json"),
      JSON.stringify({ daemonBaseUrl: `${url}/v1/agent-device`, daemonAuthToken: token }),
    );
  profile("http://127.0.0.1:4701", "slk_worker_a");
  const env = {};
  const settings = createSimlockSettings({ file: path.join(home, "simlock.json"), env, home });
  // Gateway left empty: the token is saved for the worker detected now, A.
  settings.save({ enabled: true, agentToken: "slk_saved_for_a" });
  assert.equal(settings.resolved().agentToken, "slk_saved_for_a");
  // The profile now points at B: A's token must not follow it; B's own profile token is used instead.
  profile("http://127.0.0.1:4801", "slk_worker_b");
  assert.equal(settings.resolved().gatewayUrl, "http://127.0.0.1:4801");
  assert.equal(settings.resolved().agentToken, "slk_worker_b");
  assert.equal(settings.read().tokenSource, "worker");
  // agent-device's variables take over with a gateway of their own: still not A's token.
  env.AGENT_DEVICE_DAEMON_BASE_URL = "https://gateway-c.example.com/v1/agent-device";
  env.AGENT_DEVICE_DAEMON_AUTH_TOKEN = "slk_env_c";
  assert.equal(settings.resolved().agentToken, "slk_env_c");
  // Without its token the variables don't count, and detection falls back to B's profile: still not A's token.
  delete env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
  assert.equal(settings.resolved().agentToken, "slk_worker_b");
  // Back on A, the saved token applies again.
  delete env.AGENT_DEVICE_DAEMON_BASE_URL;
  profile("http://127.0.0.1:4701", "slk_worker_a");
  assert.equal(settings.resolved().agentToken, "slk_saved_for_a");
  // With nothing detected and no gateway, a token has nowhere it belongs.
  fs.rmSync(path.join(home, ".simlock"), { recursive: true });
  assert.throws(() => settings.save({ agentToken: "slk_orphan" }), /gateway this token belongs to/);
});

test("a lease needs the Chat's own folder and never falls back to another", async (t) => {
  const { host, runs } = hostFixture(t);
  await assert.rejects(host.lease({ platform: "ios" }), /folder isn't available/);
  await assert.rejects(host.lease({ platform: "ios", installDirectory: "/nonexistent/worktree" }), /folder isn't available/);
  const file = path.join(temp(t), "file");
  fs.writeFileSync(file, "");
  await assert.rejects(host.lease({ platform: "ios", installDirectory: file }), /folder isn't available/);
  assert.equal(runs.filter((r) => r.args[0] === "open").length, 0);
  assert.deepEqual(host.leases(), []);
});

test("a command that ignores SIGTERM, or holds its pipes open, still settles at its deadline", async (t) => {
  const dir = temp(t);
  const stubborn = path.join(dir, "stubborn.cjs");
  fs.writeFileSync(stubborn, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  const started = Date.now();
  const result = await runCli({ nodePath: process.execPath, entryPath: stubborn }, [], { cwd: dir, env: process.env, timeoutMs: 100, killGraceMs: 200 });
  assert.equal(result.signal, "SIGKILL");
  assert.ok(Date.now() - started < 5000, "settled well within the bound");
  // A grandchild that inherits stdout keeps the pipe open past the child's exit; the call must not wait on it.
  const holder = path.join(dir, "holder.cjs");
  fs.writeFileSync(
    holder,
    "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'inherit', 'inherit'] }); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
  );
  const begun = Date.now();
  const held = await runCli({ nodePath: process.execPath, entryPath: holder }, [], { cwd: dir, env: process.env, timeoutMs: 100, killGraceMs: 200 });
  assert.equal(held.signal, "SIGKILL");
  assert.ok(Date.now() - begun < 5000, "a held pipe does not stall the call");
});
