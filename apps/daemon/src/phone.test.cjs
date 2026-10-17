const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createPhone, LOCAL_PORT, RETIRED_MS } = require("./phone.cjs");
const { createDevices } = require("./devices.cjs");
const { b64url } = require("@milagre/shared/relay-crypto");
const { readIdentity } = require("./relay-identity.cjs");
const { parsePairing } = require("@milagre/shared/pairing-link");

const PAIRING_WINDOW_MS = 10 * 60 * 1000;

const ACCESS = { id: `${"a".repeat(32)}.access`, secret: "b".repeat(40) };

async function waitFor(read) {
  for (let i = 0; i < 400; i++) {
    const value = await read();
    if (value) return value;
    await delay(5);
  }
  throw new Error("Timed out waiting for the phone");
}

/** A bridge and tunnel that only record what the phone asks of them. */
async function fixture(
  t,
  {
    cloudflare = false,
    failBridge,
    failTunnel,
    failLan,
    lanPort = 8798,
    onPaired = () => {},
    retryDelaysMs = [1, 1, 1],
    clock = { now: 0 },
    phoneOptions = {},
  } = {},
) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-phone-")));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  if (cloudflare)
    await fs.writeFile(
      path.join(dataDir, "cloudflare.json"),
      JSON.stringify({ hostname: "mac.example.com", port: 8801, connectorToken: "connector", access: ACCESS }),
      { mode: 0o600 },
    );
  const log = [];
  const bridges = [];
  const startBridge = async ({ dataDir: dir, port, token }) => {
    assert.equal(dir, dataDir);
    if (failBridge?.()) throw new Error("Address already in use");
    let lose;
    const lost = new Promise((resolve) => {
      lose = resolve;
    });
    const bridge = {
      url: `http://127.0.0.1:${port}`,
      port,
      token,
      lose,
      lost,
      closed: false,
      close: async () => {
        bridge.closed = true;
        log.push(`bridge:close:${bridges.indexOf(bridge)}`);
        lose();
      },
    };
    bridges.push(bridge);
    log.push(`bridge:start:${port}`);
    return bridge;
  };
  const tunnelsStarted = [];
  const tunnels = {
    startNamedTunnel: async (options) => {
      if (failTunnel?.()) throw new Error("cloudflared is not installed.");
      const tunnel = {
        url: `https://${options.hostname}`,
        options,
        closed: false,
        close: async () => {
          tunnel.closed = true;
          log.push("tunnel:close");
        },
      };
      tunnelsStarted.push(tunnel);
      log.push("tunnel:start");
      return tunnel;
    },
  };
  const relays = [];
  // Hosts that only hold a room a reset retired, kept apart from the Mac's own.
  const retired = [];
  const startRelay = (options) => {
    const relay = {
      options,
      closed: false,
      state: "connecting",
      status: () => relay.state,
      close: async () => {
        relay.closed = true;
        log.push(options.retired ? "retired:close" : "relay:close");
      },
    };
    (options.retired ? retired : relays).push(relay);
    log.push(options.retired ? "retired:start" : "relay:start");
    return relay;
  };
  // No test may bind a real port on the LAN: every phone gets this fake.
  const lans = [];
  const startLan = async (options) => {
    if (failLan?.()) throw new Error("listen EADDRINUSE: address already in use 0.0.0.0:8798");
    const lan = {
      options,
      port: options.port,
      closed: false,
      close: async () => {
        lan.closed = true;
        log.push("lan:close");
      },
    };
    lans.push(lan);
    log.push(`lan:start:${options.port}`);
    return lan;
  };
  const changes = [];
  const paired = [];
  const create = () =>
    createPhone({
      dataDir,
      tunnels,
      startBridge,
      startRelay,
      now: () => clock.now,
      retryDelaysMs,
      name: () => "Test Mac",
      onChange: (status) => changes.push(status.state),
      onPaired: (info) => {
        paired.push(info);
        onPaired(info);
      },
      startLan,
      lanPort,
      addresses: () => ["192.168.1.20"],
      ...phoneOptions,
    });
  const phone = create();
  t.after(() => phone.close());
  return { dataDir, phone, create, log, bridges, tunnelsStarted, relays, retired, lans, paired, clock, changes, file: path.join(dataDir, "mobile.json") };
}

test("a phone that was never enabled is off and starts nothing", async (t) => {
  const { phone, log, file } = await fixture(t);
  await phone.start();
  await phone.settled();
  assert.deepEqual(phone.status(), { enabled: false, state: "off", remote: "none", lan: { enabled: true, addresses: [] } });
  assert.deepEqual(log, []);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
});

test("without a tunnel the phone pairs through the relay", async (t) => {
  const { phone, log, bridges, tunnelsStarted, relays, changes } = await fixture(t);
  const started = await phone.setEnabled(true);
  assert.equal(started.state, "starting");
  await phone.settled();
  const status = phone.status();
  assert.equal(status.enabled, true);
  assert.equal(status.state, "on");
  assert.equal(status.remote, "relay");
  assert.equal(status.relay, "connecting");
  assert.equal(status.pairingUntil, PAIRING_WINDOW_MS);
  assert.equal(status.localUrl, `http://127.0.0.1:${LOCAL_PORT}`);
  assert.equal(status.publicUrl, undefined);
  assert.match(
    status.pairingLink,
    /^milagre:\/\/pair\?relay=wss%3A%2F%2Frelay\.milagre\.cloud&host=[A-Za-z0-9_-]{22}&key=[A-Za-z0-9_-]{43}&token=[a-f0-9]{64}&name=Test%20Mac$/,
  );
  assert.equal(new URL(status.pairingLink).searchParams.get("token"), bridges[0].token);
  assert.match(status.qrSvg, /^<svg[^>]*viewBox=/);
  assert.equal(relays.length, 1);
  assert.equal(relays[0].options.relayUrl, "wss://relay.milagre.cloud");
  assert.equal(relays[0].options.bridgeUrl, `http://127.0.0.1:${LOCAL_PORT}`);
  assert.equal(relays[0].options.token, bridges[0].token);
  assert.equal(new URL(status.pairingLink).searchParams.get("host"), relays[0].options.identity.hostId);
  assert.deepEqual(log, [`bridge:start:${LOCAL_PORT}`, "relay:start", "lan:start:8798"]);
  assert.equal(tunnelsStarted.length, 0);
  relays[0].state = "online";
  relays[0].options.onStatus("online");
  assert.equal(phone.status().relay, "online");
  assert.deepEqual(changes, ["starting", "on", "on"]);
});

test("the pairing window closes after 10 minutes and opens again on openPairing", async (t) => {
  const { phone, relays, clock } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  const { canPair } = relays[0].options;
  assert.equal(canPair(), true);
  clock.now = PAIRING_WINDOW_MS - 1;
  assert.equal(canPair(), true);
  clock.now = PAIRING_WINDOW_MS + 1;
  assert.equal(canPair(), false);
  assert.equal(phone.status().pairingUntil, PAIRING_WINDOW_MS);
  const reopened = await phone.openPairing();
  assert.equal(canPair(), true);
  assert.equal(reopened.pairingUntil, PAIRING_WINDOW_MS + 1 + PAIRING_WINDOW_MS);
  assert.equal(phone.status().pairingUntil, reopened.pairingUntil);
});

test("openPairing while the phone is off opens nothing", async (t) => {
  const { phone, clock } = await fixture(t);
  clock.now = 5;
  assert.deepEqual(await phone.openPairing(), { enabled: false, state: "off", remote: "none", lan: { enabled: true, addresses: [] } });
});

test("reset opens the pairing window again and forgets relay phones", async (t) => {
  const { phone, dataDir, relays, clock } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  const phones = createDevices(dataDir);
  await phones.add("phoneA");
  clock.now = PAIRING_WINDOW_MS * 3;
  assert.equal(relays[0].options.canPair(), false);
  await phone.reset();
  await phone.settled();
  const after = createDevices(dataDir);
  await after.load();
  assert.equal(after.isKnown("phoneA"), false);
  assert.equal(relays.length, 2);
  assert.equal(relays[0].closed, true);
  assert.equal(relays[1].options.canPair(), true);
  assert.equal(relays[1].options.token, JSON.parse(await fs.readFile(path.join(dataDir, "mobile.json"), "utf8")).token);
});

test("reset closes the old relay host before it changes the token, the phones or the pairing window", async (t) => {
  const { phone, dataDir, relays, clock, file } = await fixture(t);
  await createDevices(dataDir).add("phoneA");
  await phone.setEnabled(true);
  await phone.settled();
  const old = relays[0];
  const oldToken = JSON.parse(await fs.readFile(file, "utf8")).token;
  clock.now = PAIRING_WINDOW_MS * 3;
  const seen = {};
  old.close = async () => {
    // A hello still in flight on the old host: it may pair only if the window is open.
    seen.canPair = old.options.canPair();
    seen.knowsPhoneA = old.options.phones.isKnown("phoneA");
    seen.token = JSON.parse(await fs.readFile(file, "utf8")).token;
    if (old.options.canPair()) await old.options.phones.add("intruder");
    old.closed = true;
  };
  await phone.reset();
  await phone.settled();
  assert.deepEqual(seen, { canPair: false, knowsPhoneA: true, token: oldToken });
  assert.equal(relays.length, 2);
  assert.equal(relays[1].options.phones.isKnown("intruder"), false);
  assert.equal(relays[1].options.phones.isKnown("phoneA"), false);
  const after = createDevices(dataDir);
  await after.load();
  assert.equal(after.isKnown("intruder"), false);
  assert.equal(after.isKnown("phoneA"), false);
});

test("a reset that fails part way leaves no old host running and reports an error", async (t) => {
  const { phone, dataDir, relays, bridges, file } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  const oldToken = JSON.parse(await fs.readFile(file, "utf8")).token;
  // A directory where the phone list lives: clearing it cannot be written.
  await fs.mkdir(path.join(dataDir, "devices.json"));
  const status = await phone.reset();
  await phone.settled();
  assert.equal(status.state, "error");
  assert.equal(phone.status().state, "error");
  assert.equal(phone.status().pairingLink, undefined);
  assert.equal(relays.length, 1);
  assert.equal(relays[0].closed, true);
  assert.equal(bridges.length, 1);
  assert.equal(bridges[0].closed, true);
  assert.notEqual(JSON.parse(await fs.readFile(file, "utf8")).token, oldToken);
});

test("reset gives the Mac a new relay identity, so the link carries a new host and key", async (t) => {
  const { phone, relays } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  const before = new URL(phone.status().pairingLink).searchParams;
  await phone.reset();
  await phone.settled();
  const after = new URL(phone.status().pairingLink).searchParams;
  assert.notEqual(after.get("host"), before.get("host"));
  assert.notEqual(after.get("key"), before.get("key"));
  assert.equal(relays[1].options.identity.hostId, after.get("host"));
  assert.notEqual(relays[1].options.identity.hostId, relays[0].options.identity.hostId);
});

test("reset while off rotates the relay identity too", async (t) => {
  const { phone, dataDir } = await fixture(t);
  const { readIdentity } = require("./relay-identity.cjs");
  const before = await readIdentity(dataDir);
  await phone.reset();
  assert.notEqual((await readIdentity(dataDir)).hostId, before.hostId);
});

test("reset while off forgets relay phones too", async (t) => {
  const { phone, dataDir } = await fixture(t);
  await createDevices(dataDir).add("phoneA");
  await phone.reset();
  const after = createDevices(dataDir);
  await after.load();
  assert.equal(after.isKnown("phoneA"), false);
});

test("status counts the paired phones, and a first pairing is announced once", async (t) => {
  const { phone, relays, paired, changes } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  assert.equal(phone.status().pairedPhones, 0);
  const before = changes.length;
  // The relay host adds a phone only when it pairs for the first time.
  await relays[0].options.phones.add("phoneA");
  assert.equal(relays[0].options.phones.isKnown("phoneA"), true);
  assert.equal(phone.status().pairedPhones, 1);
  assert.deepEqual(paired, [{ pairedPhones: 1, kind: "phone" }]);
  assert.equal(changes.length, before + 1, "Settings hears the new count");
  await relays[0].options.phones.add("phoneB");
  assert.deepEqual(paired, [
    { pairedPhones: 1, kind: "phone" },
    { pairedPhones: 2, kind: "phone" },
  ]);
  await phone.reset();
  await phone.settled();
  assert.equal(phone.status().pairedPhones, 0, "a reset forgets them");
});

test("a phone the old host pairs while a reset tears it down is not announced", async (t) => {
  const { phone, relays, paired, clock } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  const old = relays[0];
  old.close = async () => {
    await old.options.phones.add("late");
    old.closed = true;
  };
  clock.now = 1;
  await phone.reset();
  await phone.settled();
  assert.deepEqual(paired, []);
  assert.equal(phone.status().pairedPhones, 0);
});

test("reset keeps the old room answering, only to say the Mac was reset", async (t) => {
  const { phone, relays, retired, log } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  await relays[0].options.phones.add("phoneA");
  const old = relays[0].options.identity;
  log.length = 0;
  await phone.reset();
  await phone.settled();
  assert.equal(retired.length, 1);
  assert.equal(retired[0].options.retired, true);
  assert.equal(retired[0].options.identity.hostId, old.hostId);
  assert.deepEqual(retired[0].options.identity.sign.publicKey, old.sign.publicKey);
  // It holds no token, bridge or phone list: it can let nobody in.
  for (const key of ["token", "bridgeUrl", "phones", "canPair"]) assert.equal(retired[0].options[key], undefined, key);
  assert.notEqual(relays[1].options.identity.hostId, old.hostId);
  assert.deepEqual(log, ["lan:close", "relay:close", "bridge:close:0", `bridge:start:${LOCAL_PORT}`, "relay:start", "retired:start", "lan:start:8798"]);
  // Turning the phone off lets the old room go too.
  await phone.setEnabled(false);
  await phone.settled();
  assert.equal(retired[0].closed, true);
});

test("a reset with no paired phones retires nothing", async (t) => {
  const { phone, retired } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  await phone.reset();
  await phone.settled();
  assert.equal(retired.length, 0);
});

test("an old room is let go once its time is up", async (t) => {
  const { phone, relays, retired, clock } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  await relays[0].options.phones.add("phoneA");
  await phone.reset();
  await phone.settled();
  assert.equal(retired.length, 1);
  clock.now = RETIRED_MS - 1;
  await phone.setEnabled(false);
  await phone.setEnabled(true);
  await phone.settled();
  assert.equal(retired.length, 2, "still held after a restart");
  clock.now = RETIRED_MS;
  await phone.setEnabled(false);
  await phone.setEnabled(true);
  await phone.settled();
  assert.equal(retired.length, 2, "not held any more");
});

test("a reset that fails while the phone is off stays off and says it failed", async (t) => {
  const { phone, dataDir, changes } = await fixture(t);
  await fs.mkdir(path.join(dataDir, "devices.json"));
  await assert.rejects(phone.reset());
  assert.deepEqual(phone.status(), { enabled: false, state: "off", remote: "none", lan: { enabled: true, addresses: [] } });
  assert.equal(changes.includes("error"), false);
});

test("reset needs neither a phone nor the relay: it finishes while the relay is unreachable", async (t) => {
  const { phone, relays, file } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  relays[0].options.onStatus("offline");
  const before = JSON.parse(await fs.readFile(file, "utf8")).token;
  await phone.reset();
  await phone.settled();
  assert.equal(phone.status().state, "on");
  assert.notEqual(JSON.parse(await fs.readFile(file, "utf8")).token, before);
});

test("disabling stops the relay before the bridge", async (t) => {
  const { phone, log } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  await phone.setEnabled(false);
  await phone.settled();
  assert.deepEqual(log.slice(3), ["lan:close", "relay:close", "bridge:close:0"]);
  assert.equal(phone.status().relay, "offline");
});

test("a relay phone that paired before the daemon restarted is still known", async (t) => {
  const { phone, dataDir, relays } = await fixture(t);
  await createDevices(dataDir).add("phoneA");
  await phone.setEnabled(true);
  await phone.settled();
  assert.equal(relays[0].options.phones.isKnown("phoneA"), true);
});

test("with cloudflare.json the bridge uses its port, a named tunnel runs and the link carries the Access token", async (t) => {
  const { phone, log, bridges, tunnelsStarted, relays } = await fixture(t, { cloudflare: true });
  await phone.setEnabled(true);
  await phone.settled();
  const status = phone.status();
  assert.equal(status.state, "on");
  assert.equal(status.remote, "cloudflare");
  assert.equal(status.publicUrl, "https://mac.example.com");
  assert.equal(status.localUrl, "http://127.0.0.1:8801");
  assert.deepEqual(log, ["bridge:start:8801", "tunnel:start", "relay:start", "lan:start:8798"]);
  assert.equal(relays.length, 1);
  assert.deepEqual(tunnelsStarted[0].options, { hostname: "mac.example.com", connectorToken: "connector" });
  const link = new URL(status.pairingLink);
  assert.equal(link.searchParams.get("address"), "https://mac.example.com");
  assert.equal(link.searchParams.get("token"), bridges[0].token);
  assert.equal(link.searchParams.get("cfId"), ACCESS.id);
  assert.equal(link.searchParams.get("cfSecret"), ACCESS.secret);
});

test("behind a Cloudflare tunnel the relay runs too, so another Mac can pair with the computer link", async (t) => {
  const { phone, relays } = await fixture(t, { cloudflare: true });
  await phone.setEnabled(true);
  await phone.settled();
  const status = phone.status();
  assert.equal(status.relay, "connecting");
  assert.equal(typeof status.pairingUntil, "number");
  assert.equal(relays[0].options.canPair("computerA"), true);
  const pairing = parsePairing(status.computerLink);
  assert.equal(pairing.relay.hostId, relays[0].options.identity.hostId);
  assert.equal(pairing.token, relays[0].options.token);
  assert.equal(new URL(status.pairingLink).searchParams.get("relay"), null, "the QR stays the tunnel's");
});

test("disabling stops the tunnel before the bridge and keeps the setting off", async (t) => {
  const { phone, log, bridges, tunnelsStarted, changes, file } = await fixture(t, { cloudflare: true });
  await phone.setEnabled(true);
  await phone.settled();
  const disabled = await phone.setEnabled(false);
  assert.equal(disabled.state, "off");
  await phone.settled();
  assert.deepEqual(log.slice(4), ["lan:close", "tunnel:close", "relay:close", "bridge:close:0"]);
  assert.equal(tunnelsStarted[0].closed && bridges[0].closed, true);
  assert.deepEqual(phone.status(), {
    enabled: false,
    state: "off",
    remote: "cloudflare",
    relay: "offline",
    pairingUntil: PAIRING_WINDOW_MS,
    pairedPhones: 0,
    lan: { enabled: true, addresses: [] },
  });
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).enabled, false);
  assert.deepEqual(changes, ["starting", "on", "off"]);
});

test("the setting is a private file, written atomically and kept across disable", async (t) => {
  const { phone, dataDir, file } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(saved.enabled, true);
  assert.match(saved.token, /^[a-f0-9]{64}$/);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(
    (await fs.readdir(dataDir)).filter((name) => name.includes(".tmp")),
    [],
  );
  await phone.setEnabled(false);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).token, saved.token);
});

test("an enabled phone starts again when the daemon starts, with the same token", async (t) => {
  const { phone, create, bridges, file } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  const token = bridges[0].token;
  await phone.close();
  // close() only stops it: the setting stays on for the next boot.
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).enabled, true);
  const next = create();
  t.after(() => next.close());
  assert.equal(next.status().state, "off");
  await next.start();
  await next.settled();
  assert.equal(next.status().state, "on");
  assert.equal(bridges.at(-1).token, token);
  assert.equal(bridges.at(-1).closed, false);
});

test("a phone left disabled stays off at start", async (t) => {
  const { phone, create, log } = await fixture(t);
  await phone.setEnabled(true);
  await phone.setEnabled(false);
  await phone.settled();
  log.length = 0;
  const next = create();
  await next.start();
  await next.settled();
  assert.equal(next.status().state, "off");
  assert.deepEqual(log, []);
});

test("reset writes a new token and restarts, so paired phones must scan again", async (t) => {
  const { phone, bridges, file } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  const before = JSON.parse(await fs.readFile(file, "utf8")).token;
  const link = phone.status().pairingLink;
  const reset = await phone.reset();
  assert.equal(reset.state, "starting");
  await phone.settled();
  const after = JSON.parse(await fs.readFile(file, "utf8")).token;
  assert.notEqual(after, before);
  assert.equal(bridges.length, 2);
  assert.equal(bridges[0].closed, true);
  assert.equal(bridges[1].token, after);
  assert.equal(phone.status().state, "on");
  assert.notEqual(phone.status().pairingLink, link);
  assert.match(phone.status().pairingLink, new RegExp(`token=${after}`));
});

test("reset while off only changes the token", async (t) => {
  const { phone, log, file } = await fixture(t);
  await phone.setEnabled(true);
  await phone.setEnabled(false);
  await phone.settled();
  const before = JSON.parse(await fs.readFile(file, "utf8")).token;
  log.length = 0;
  assert.equal((await phone.reset()).state, "off");
  await phone.settled();
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.notEqual(saved.token, before);
  assert.equal(saved.enabled, false);
  assert.deepEqual(log, []);
});

test("a bridge that loses the daemon is started again, tunnel included", async (t) => {
  const { phone, bridges, tunnelsStarted, changes } = await fixture(t, { cloudflare: true });
  await phone.setEnabled(true);
  await phone.settled();
  bridges[0].lose();
  await waitFor(() => bridges.length === 2 && phone.status().state === "on");
  assert.equal(tunnelsStarted.length, 2);
  assert.equal(tunnelsStarted[0].closed, true);
  assert.equal(bridges[0].closed, true);
  assert.equal(bridges[1].token, bridges[0].token);
  assert.deepEqual(changes, ["starting", "on", "starting", "on"]);
});

test("restarts after a lost bridge are bounded and then end in an error", async (t) => {
  let fail = false;
  const { phone, bridges } = await fixture(t, { failBridge: () => fail, retryDelaysMs: [1, 1] });
  await phone.setEnabled(true);
  await phone.settled();
  fail = true;
  bridges[0].lose();
  await waitFor(() => phone.status().state === "error");
  assert.equal(phone.status().error, "Address already in use");
  assert.equal(phone.status().enabled, true);
  assert.equal(phone.status().pairingLink, undefined);
  assert.equal(bridges.length, 1);
  // Turning it off and on again tries from scratch.
  fail = false;
  await phone.setEnabled(true);
  await phone.settled();
  assert.equal(phone.status().state, "on");
});

test("a bridge that fails to start is an error state and leaves nothing running", async (t) => {
  const { phone, bridges, log } = await fixture(t, { failBridge: () => true });
  assert.equal((await phone.setEnabled(true)).state, "starting");
  await phone.settled();
  assert.deepEqual({ state: phone.status().state, error: phone.status().error }, { state: "error", error: "Address already in use" });
  assert.deepEqual(log, []);
  assert.equal(bridges.length, 0);
});

test("a tunnel that fails to start closes the bridge it opened", async (t) => {
  const { phone, bridges } = await fixture(t, { cloudflare: true, failTunnel: () => true });
  await phone.setEnabled(true);
  await phone.settled();
  assert.equal(phone.status().state, "error");
  assert.match(phone.status().error, /cloudflared is not installed/);
  assert.equal(bridges[0].closed, true);
});

test("a Cloudflare file with loose permissions is reported instead of falling back to local only", async (t) => {
  const { phone, dataDir, bridges } = await fixture(t, { cloudflare: true });
  await fs.chmod(path.join(dataDir, "cloudflare.json"), 0o644);
  await phone.setEnabled(true);
  await phone.settled();
  assert.equal(phone.status().state, "error");
  assert.match(phone.status().error, /permissions 0600/);
  assert.equal(bridges.length, 0);
});

test("enabling twice does not restart, and quick toggles end in the last choice", async (t) => {
  const { phone, bridges } = await fixture(t);
  await phone.setEnabled(true);
  await phone.setEnabled(true);
  await phone.settled();
  assert.equal(bridges.length, 1);
  await phone.setEnabled(false);
  await phone.setEnabled(true);
  await phone.setEnabled(false);
  await phone.setEnabled(true);
  await phone.settled();
  assert.equal(phone.status().state, "on");
  assert.equal(bridges.filter((bridge) => !bridge.closed).length, 1);
  await assert.rejects(phone.setEnabled("yes"), /true or false/);
});

test("closing stops the bridge, tunnel and any pending restart", async (t) => {
  const { phone, bridges, tunnelsStarted } = await fixture(t, { cloudflare: true, retryDelaysMs: [50] });
  await phone.setEnabled(true);
  await phone.settled();
  bridges[0].lose();
  await waitFor(() => phone.status().state === "starting");
  await phone.close();
  await delay(80);
  assert.equal(bridges.length, 1);
  assert.equal(tunnelsStarted.length, 1);
  assert.equal(tunnelsStarted[0].closed, true);
});

test("allowedRoot reaches the bridge only when it is set", async (t) => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-phone-")));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const seen = [];
  const startBridge = async (options) => {
    seen.push(options);
    return { url: `http://127.0.0.1:${options.port}`, lost: new Promise(() => {}), close: async () => {} };
  };
  const startRelay = () => ({ status: () => "connecting", close: async () => {} });
  for (const extra of [{ allowedRoot: "/demo/project" }, {}]) {
    const phone = createPhone({ dataDir, startBridge, startRelay, lanPort: null, name: () => "Test Mac", ...extra });
    // The second phone finds the setting already on and starts from it.
    await phone.start();
    await phone.setEnabled(true);
    await phone.settled();
    await phone.close();
  }
  assert.equal(seen[0].allowedRoot, "/demo/project");
  assert.equal("allowedRoot" in seen[1], false);
});

test("phone access starts the LAN host with the relay identity and reports its addresses", async (t) => {
  const { phone, lans } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  assert.equal(lans.length, 1);
  assert.equal(lans[0].port, 8798);
  assert.equal(lans[0].options.hostname, "0.0.0.0");
  assert.match(lans[0].options.identity.hostId, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(phone.status().lan, { enabled: true, addresses: ["192.168.1.20"] });
});

test("a Cloudflare Mac also gets a relay identity and a LAN host", async (t) => {
  const { phone, lans } = await fixture(t, { cloudflare: true });
  await phone.setEnabled(true);
  await phone.settled();
  assert.equal(phone.status().remote, "cloudflare");
  assert.equal(lans.length, 1);
});

test("a LAN port that is taken leaves phone access on, with the error in lan", async (t) => {
  const { phone } = await fixture(t, { failLan: () => true });
  await phone.setEnabled(true);
  await phone.settled();
  assert.equal(phone.status().state, "on");
  assert.equal(phone.status().lan.enabled, true);
  assert.deepEqual(phone.status().lan.addresses, []);
  assert.match(phone.status().lan.error, /EADDRINUSE/);
});

test("setLan(false) closes the LAN host, is saved, and survives a restart", async (t) => {
  const { phone, lans, dataDir } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  const status = await phone.setLan(false);
  assert.equal(lans[0].closed, true);
  assert.deepEqual(status.lan, { enabled: false, addresses: [] });
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, "mobile.json"), "utf8")).lan, false);
  await phone.setLan(true);
  assert.equal(lans.length, 2);
  assert.equal(phone.status().lan.enabled, true);
});

test("a saved lan:false is still off after a restart", async (t) => {
  const { phone, create, lans } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  await phone.setLan(false);
  await phone.close();
  const next = create();
  t.after(() => next.close());
  await next.start();
  await next.settled();
  assert.equal(next.status().state, "on");
  assert.equal(lans.length, 1, "no second LAN host");
  assert.equal(next.status().lan.enabled, false);
});

test("a failed LAN start does not leak, and turning it on again retries", async (t) => {
  let fail = true;
  const { phone, lans } = await fixture(t, { failLan: () => fail });
  await phone.setEnabled(true);
  await phone.settled();
  assert.match(phone.status().lan.error, /EADDRINUSE/);
  fail = false;
  await phone.setLan(false);
  assert.equal(phone.status().lan.error, undefined);
  await phone.setLan(true);
  assert.equal(lans.length, 1);
  assert.deepEqual(phone.status().lan, { enabled: true, addresses: ["192.168.1.20"] });
});

test("the LAN host closes before the bridge when phone access turns off", async (t) => {
  const { phone, log } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  await phone.setEnabled(false);
  await phone.settled();
  assert.ok(log.indexOf("lan:close") !== -1);
  assert.ok(log.indexOf("lan:close") < log.indexOf("bridge:close:0"));
});

test("routes registers the phone's key without announcing a pairing, and lists the LAN endpoints", async (t) => {
  const paired = [];
  const { phone, dataDir } = await fixture(t, { onPaired: (info) => paired.push(info) });
  await phone.setEnabled(true);
  await phone.settled();
  const phoneKey = "k".repeat(43);
  const answer = await phone.routes(phoneKey);
  assert.match(answer.hostId, /^[A-Za-z0-9_-]{22}$/);
  assert.match(answer.key, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(answer.lan, ["ws://192.168.1.20:8798"]);
  assert.deepEqual(paired, []);
  const phones = createDevices(dataDir);
  await phones.load();
  assert.equal(phones.isKnown(phoneKey), true);
  await phone.setLan(false);
  assert.deepEqual((await phone.routes(phoneKey)).lan, []);
  await assert.rejects(phone.routes("short"), /key/);
});

test("routes before phone access is running is a 409", async (t) => {
  const { phone } = await fixture(t);
  await assert.rejects(phone.routes("k".repeat(43)), { status: 409 });
});

test("lanPort null never starts a LAN host", async (t) => {
  const { phone, lans } = await fixture(t, { lanPort: null });
  await phone.setEnabled(true);
  await phone.settled();
  assert.equal(lans.length, 0);
  assert.deepEqual(phone.status().lan, { enabled: false, addresses: [] });
});

test("a confined phone (allowedRoot) never starts a LAN host", async (t) => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-phone-")));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const started = [];
  const phone = createPhone({
    dataDir,
    allowedRoot: "/demo/project",
    startBridge: async (options) => ({ url: `http://127.0.0.1:${options.port}`, lost: new Promise(() => {}), close: async () => {} }),
    startRelay: () => ({ status: () => "connecting", close: async () => {} }),
    startLan: async (options) => started.push(options),
    name: () => "Test Mac",
  });
  t.after(() => phone.close());
  await phone.setEnabled(true);
  await phone.settled();
  assert.equal(started.length, 0);
  assert.equal(phone.status().lan.enabled, false);
});

test("devices lists what paired, with the route each is connected on now", async (t) => {
  const { phone, relays, lans } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  const key = "k".repeat(43);
  await relays[0].options.phones.add(key, { kind: "phone", name: "Victor's iPhone" });
  assert.deepEqual(
    (await phone.devices()).map((device) => [device.key, device.kind, device.name, device.route]),
    [[key, "phone", "Victor's iPhone", null]],
  );
  relays[0].connectedKeys = () => [key];
  assert.equal((await phone.devices())[0].route, "relay");
  lans[0].connectedKeys = () => [key];
  assert.equal((await phone.devices())[0].route, "lan", "the local network wins when both carry it");
});

test("the device list reads the saved devices while phone access is off", async (t) => {
  const { phone, dataDir } = await fixture(t);
  await createDevices(dataDir).add("k".repeat(43), { name: "iPad mini" });
  assert.deepEqual(
    (await phone.devices()).map((device) => [device.name, device.route]),
    [["iPad mini", null]],
  );
});

test("removing a device forgets it, closes its channels, and lets it pair again only in a window opened later", async (t) => {
  const { phone, relays, lans, clock, changes } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  const dropped = [];
  relays[0].drop = (key) => dropped.push(`relay:${key}`);
  lans[0].drop = (key) => dropped.push(`lan:${key}`);
  const key = "k".repeat(43);
  await relays[0].options.phones.add(key, { name: "Victor's iPhone" });
  clock.now = 1000;
  const before = changes.length;
  assert.deepEqual(await phone.removeDevice(key), []);
  assert.deepEqual(dropped, [`relay:${key}`, `lan:${key}`]);
  assert.ok(changes.length > before, "a removal is announced as a phone status, so Settings reads the list again");
  assert.equal(relays[0].options.canPair(key), false, "the window it was removed in stays closed to it");
  assert.equal(relays[0].options.canPair("o".repeat(43)), true, "other new devices still pair");
  clock.now = 2000;
  await phone.openPairing();
  assert.equal(relays[0].options.canPair(key), true);
  await assert.rejects(phone.removeDevice("short"), /device key/);
});

test("a removed phone reaching routes through a trusted route is not added back", async (t) => {
  const { phone, relays, dataDir } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  const key = "k".repeat(43);
  await relays[0].options.phones.add(key);
  await phone.removeDevice(key);
  await phone.routes(key);
  const after = createDevices(dataDir);
  await after.load();
  assert.equal(after.isKnown(key), false);
});

test("a computer's first pairing is announced with its kind", async (t) => {
  const { phone, relays, paired } = await fixture(t);
  await phone.setEnabled(true);
  await phone.settled();
  await relays[0].options.phones.add("deskA", { kind: "computer", name: "studio" });
  assert.deepEqual(paired, [{ pairedPhones: 1, kind: "computer" }]);
  assert.equal(relays[0].options.phones.kindOf("deskA"), "computer");
});

test("the relay and LAN hosts get openPeer and allowComputer, and a confined phone never hosts a desktop", async (t) => {
  const openPeer = () => ({ receive() {}, invalid() {}, close() {} });
  const open = await fixture(t, { phoneOptions: { openPeer } });
  await open.phone.setEnabled(true);
  await open.phone.settled();
  assert.equal(open.relays[0].options.openPeer, openPeer);
  assert.equal(typeof open.relays[0].options.allowComputer, "function");
  assert.equal(open.lans[0].options.openPeer, openPeer);
  const confined = await fixture(t, { phoneOptions: { openPeer, allowedRoot: "/tmp/milagre-demo" } });
  await confined.phone.setEnabled(true);
  await confined.phone.settled();
  assert.equal(confined.relays[0].options.openPeer, undefined);
  assert.equal(confined.relays[0].options.allowComputer, undefined);
  assert.equal(confined.lans.length, 0);
});

test("peerRoutes names this Mac's relay identity and LAN routes, and refuses while phone access is off", async (t) => {
  const { phone, dataDir } = await fixture(t);
  assert.throws(() => phone.peerRoutes(), /starting/);
  await phone.setEnabled(true);
  await phone.settled();
  const identity = await readIdentity(dataDir);
  assert.deepEqual(phone.peerRoutes(), { hostId: identity.hostId, key: b64url(identity.box.publicKey), lan: ["ws://192.168.1.20:8798"] });
});

/** Phone access on, with every pending list it announced, and a way to ask as a computer's hello does. */
async function asking(t, options = {}) {
  const announced = [];
  const fixed = await fixture(t, { ...options, phoneOptions: { openPeer: () => ({}), onPending: (list) => announced.push(list) } });
  await fixed.phone.setEnabled(true);
  await fixed.phone.settled();
  const ask = (key, name = null) => {
    const abort = new AbortController();
    const request = { waited: false, abort };
    request.verdict = fixed.relays[0].options.allowComputer({
      key,
      name,
      signal: abort.signal,
      waiting: () => {
        request.waited = true;
      },
    });
    return request;
  };
  return { ...fixed, announced, ask };
}

test("a new computer waits for its owner: listed, then allowed or denied", async (t) => {
  const { phone, announced, ask } = await asking(t);
  const studio = ask("deskA", "studio");
  const nameless = ask("deskB");
  assert.equal(studio.waited && nameless.waited, true, "both told to wait");
  assert.deepEqual(phone.pendingDevices(), [
    { key: "deskA", name: "studio", at: 0 },
    { key: "deskB", name: null, at: 0 },
  ]);
  assert.deepEqual(
    announced.at(-1).map((request) => request.key),
    ["deskA", "deskB"],
  );
  assert.deepEqual(
    phone.allowDevice("deskA").map((request) => request.key),
    ["deskB"],
  );
  assert.equal(await studio.verdict, "allowed");
  assert.deepEqual(phone.denyDevice("deskB"), []);
  assert.equal(await nameless.verdict, "denied");
  assert.deepEqual(announced.at(-1), []);
  assert.throws(() => phone.allowDevice("deskA"), /no longer waiting/);
  assert.throws(() => phone.denyDevice("nope"), /no longer waiting/);
});

test("a request expires with the pairing window it arrived in, and one after the window isn't held at all", async (t) => {
  const { phone, clock, ask } = await asking(t);
  clock.now = PAIRING_WINDOW_MS - 30;
  const late = ask("deskA", "studio");
  assert.equal(late.waited, true);
  assert.equal(await late.verdict, "expired");
  assert.deepEqual(phone.pendingDevices(), []);
  clock.now = PAIRING_WINDOW_MS;
  const after = ask("deskB", "lab");
  assert.equal(await after.verdict, "expired");
  assert.equal(after.waited, false, "never shown");
});

test("a request whose computer left is dropped, and a late Allow finds nothing", async (t) => {
  const { phone, announced, ask } = await asking(t);
  const gone = ask("deskA", "studio");
  gone.abort.abort();
  assert.equal(await gone.verdict, "dropped");
  assert.deepEqual(announced.at(-1), []);
  assert.throws(() => phone.allowDevice("deskA"), /no longer waiting/);
});

test("a computer's second hello replaces its first request, and a fifth computer at once is busy", async (t) => {
  const { phone, ask } = await asking(t);
  const first = ask("deskA", "studio");
  const second = ask("deskA", "studio");
  assert.equal(await first.verdict, "dropped");
  assert.deepEqual(
    phone.pendingDevices().map((request) => request.key),
    ["deskA"],
  );
  for (const key of ["deskB", "deskC", "deskD"]) ask(key);
  const fifth = ask("deskE");
  assert.equal(await fifth.verdict, "busy");
  assert.equal(fifth.waited, false);
  assert.equal(phone.pendingDevices().length, 4);
  phone.allowDevice("deskA");
  assert.equal(await second.verdict, "allowed");
});

test("a request that can't be told to wait is dropped, not left listed", async (t) => {
  const { phone, announced, relays } = await asking(t);
  const verdict = await relays[0].options.allowComputer({
    key: "deskA",
    name: "studio",
    signal: new AbortController().signal,
    waiting() {
      throw new Error("its channel is gone");
    },
  });
  assert.equal(verdict, "dropped");
  assert.deepEqual(phone.pendingDevices(), []);
  assert.ok(
    announced.every((list) => list.length === 0),
    "it was never announced as waiting",
  );
  // And its slot is free again.
  const next = relays[0].options.allowComputer({ key: "deskB", signal: new AbortController().signal, waiting() {} });
  phone.denyDevice("deskB");
  assert.equal(await next, "denied");
});

test("turning phone access off drops every waiting request", async (t) => {
  const { phone, ask } = await asking(t);
  const waiting = ask("deskA", "studio");
  await phone.setEnabled(false);
  await phone.settled();
  assert.equal(await waiting.verdict, "dropped");
  assert.deepEqual(phone.pendingDevices(), []);
});

test("a reset and a close drop waiting requests, and a replaced request's abort doesn't touch its successor", async (t) => {
  const { phone, ask } = await asking(t);
  const first = ask("deskA", "studio");
  const second = ask("deskA", "studio");
  assert.equal(await first.verdict, "dropped");
  first.abort.abort();
  assert.deepEqual(
    phone.pendingDevices().map((request) => request.key),
    ["deskA"],
    "the superseded channel closing leaves the new request waiting",
  );
  await phone.reset();
  await phone.settled();
  assert.equal(await second.verdict, "dropped");
  assert.deepEqual(phone.pendingDevices(), []);
  const third = ask("deskB", "lab");
  await phone.close();
  assert.equal(await third.verdict, "dropped");
  assert.deepEqual(phone.pendingDevices(), []);
});

test("webhooks ride the relay host, and a confined phone never takes them", async (t) => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-phone-")));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const startBridge = async (options) => ({ url: `http://127.0.0.1:${options.port}`, lost: new Promise(() => {}), close: async () => {} });
  const received = [];
  const hooks = { ids: () => ["a".repeat(64)], receive: (list) => received.push(list), refused: () => {}, owners: () => ({}) };
  for (const [extra, expectHooks] of [
    [{ allowedRoot: "/demo/project" }, false],
    [{}, true],
  ]) {
    const started = [];
    const startRelay = (options) => {
      started.push(options);
      return { status: () => "connecting", close: async () => {}, syncHooks: () => {} };
    };
    const phone = createPhone({ dataDir, startBridge, startRelay, lanPort: null, name: () => "Test Mac", hooks, ...extra });
    await phone.start();
    await phone.setEnabled(true);
    await phone.settled();
    // Phone access on: the host serving phones carries the webhooks too.
    const own = started.filter((options) => !options.retired && !options.hooksOnly);
    assert.equal(own.length, 1);
    assert.equal(own[0].hooks === hooks, expectHooks);
    started.length = 0;
    await phone.setEnabled(false);
    await phone.settled();
    await phone.syncHooks();
    // Phone access off: a confined Mac starts nothing; the other keeps a host for webhooks alone.
    assert.equal(
      started.some((options) => options.hooksOnly),
      expectHooks,
    );
    await phone.close();
  }
});

test("with phone access off the webhooks-only host starts with the first webhook and stops with the last", async (t) => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-phone-")));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let ids = [];
  const hooks = { ids: () => ids, receive: () => {}, refused: () => {}, owners: () => ({}) };
  const hosts = [];
  const startRelay = (options) => {
    const host = { options, closed: false, syncs: 0, status: () => "online", syncHooks: () => (host.syncs += 1), close: async () => (host.closed = true) };
    hosts.push(host);
    return host;
  };
  const phone = createPhone({ dataDir, startBridge: async () => assert.fail("no bridge"), startRelay, lanPort: null, name: () => "Test Mac", hooks });
  t.after(() => phone.close());
  await phone.start();
  await phone.settled();
  assert.equal(hosts.length, 0, "no webhook, no host");
  ids = ["b".repeat(64)];
  await phone.syncHooks();
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].options.hooksOnly, true);
  assert.equal(hosts[0].options.hooks, hooks);
  ids = ["b".repeat(64), "c".repeat(64)];
  await phone.syncHooks();
  assert.equal(hosts.length, 1);
  assert.ok(hosts[0].syncs >= 1);
  ids = [];
  const syncsBefore = hosts[0].syncs;
  await phone.syncHooks();
  assert.ok(hosts[0].syncs > syncsBefore, "it tells the relay to let go before it stops");
  assert.equal(hosts[0].closed, true);
});

// A Reset leaves the old room holding deliveries the relay already accepted: the Mac drains it with the old identity.
const { readDraining } = require("./relay-identity.cjs");
const DRAIN_HOOKS = { ids: () => ["d".repeat(64)], receive: () => {}, refused: () => {}, owners: () => ({}) };
const drainHosts = (retired) => retired.filter((host) => typeof host.options.hooks?.drained === "function");

test("a Reset with webhooks and phone access off drains the old room through its own host, then lets the identity go", async (t) => {
  const { phone, relays, retired, dataDir } = await fixture(t, { phoneOptions: { hooks: DRAIN_HOOKS } });
  await phone.start();
  await phone.settled();
  const webhookHost = relays.find((host) => host.options.hooksOnly);
  assert.ok(webhookHost, "phone off: the webhooks-only host runs");
  const old = webhookHost.options.identity;
  await phone.reset();
  await phone.settled();
  const [drain] = drainHosts(retired);
  assert.ok(drain, "a host drains the old room");
  assert.equal(drain.options.identity.hostId, old.hostId);
  assert.equal(drain.options.retired, true);
  assert.deepEqual(drain.options.hooks.ids(), [], "it registers nothing, so the room lets its hooks go");
  assert.equal((await readDraining(dataDir, 0)).length, 1);
  const newHost = relays.filter((host) => host.options.hooksOnly).at(-1);
  assert.notEqual(newHost.options.identity.hostId, old.hostId, "webhooks go on through the new identity");
  drain.options.hooks.drained();
  await waitFor(() => drain.closed);
  await waitFor(async () => (await readDraining(dataDir, 0)).length === 0);
});

test("a Reset with webhooks drains the old room with phone access on and no paired phones", async (t) => {
  const { phone, retired, dataDir } = await fixture(t, { phoneOptions: { hooks: DRAIN_HOOKS } });
  await phone.setEnabled(true);
  await phone.settled();
  await phone.reset();
  await phone.settled();
  const drains = drainHosts(retired);
  assert.equal(drains.length, 1);
  assert.equal((await readDraining(dataDir, 0)).length, 1);
});

test("a Reset without webhooks keeps nothing to drain", async (t) => {
  const { phone, retired, dataDir } = await fixture(t, { phoneOptions: { hooks: { ...DRAIN_HOOKS, ids: () => [] } } });
  await phone.setEnabled(true);
  await phone.settled();
  await phone.reset();
  await phone.settled();
  assert.equal(drainHosts(retired).length, 0);
  assert.deepEqual(await readDraining(dataDir, 0), []);
});

test("an old room that is both retired (paired phones) and draining gets one host, still held for its phones once drained", async (t) => {
  const { phone, relays, retired, dataDir } = await fixture(t, { phoneOptions: { hooks: DRAIN_HOOKS } });
  await phone.setEnabled(true);
  await phone.settled();
  await relays.find((host) => !host.options.hooksOnly).options.phones.add("phoneA");
  await phone.reset();
  await phone.settled();
  const open = () => retired.filter((host) => !host.closed);
  assert.equal(open().length, 1, "one host per old identity");
  const [host] = open();
  host.options.hooks.drained();
  // The finish runs in the phone's queue: once that is through, the drop and whatever it closes are done.
  await phone.settled();
  assert.deepEqual(await readDraining(dataDir, 0), []);
  assert.equal(open().length, 1, "its phones still hear the Mac was reset");
  await phone.setEnabled(false);
  await phone.settled();
  assert.equal(open().length, 0, "phone off and nothing to drain: let go");
});

test("a drain gives up once the relay can no longer hold anything (25 h)", async (t) => {
  const clock = { now: 0 };
  const { phone, retired, create } = await fixture(t, { clock, phoneOptions: { hooks: DRAIN_HOOKS } });
  await phone.start();
  await phone.settled();
  await phone.reset();
  await phone.settled();
  assert.equal(drainHosts(retired).length, 1);
  await phone.close();
  clock.now = 25 * 3600_000;
  const later = create();
  t.after(() => later.close());
  await later.start();
  await later.settled();
  assert.equal(drainHosts(retired).length, 1, "no new drain host after the limit");
});

test("a drain that gives up also drops its identity, so the old signing key leaves the disk", async (t) => {
  const clock = { now: 0 };
  const { phone, retired, create, dataDir } = await fixture(t, { clock, phoneOptions: { hooks: DRAIN_HOOKS } });
  await phone.start();
  await phone.settled();
  await phone.reset();
  await phone.settled();
  await phone.close();
  // A later launch a moment before the 25 h limit: its drain host gives up a few milliseconds in.
  clock.now = 25 * 3600_000 - 30;
  const later = create();
  t.after(() => later.close());
  await later.start();
  await later.settled();
  const host = drainHosts(retired).at(-1);
  assert.equal(host.closed, false);
  await waitFor(() => host.closed);
  await later.settled();
  assert.deepEqual(await readDraining(dataDir, 0), []);
});

test("a Reset that lands while another room's drain finishes keeps both rooms still draining", async (t) => {
  const { phone, retired, dataDir } = await fixture(t, { phoneOptions: { hooks: DRAIN_HOOKS } });
  await phone.start();
  await phone.settled();
  await phone.reset();
  await phone.settled();
  await phone.reset();
  await phone.settled();
  const [first, second] = drainHosts(retired);
  const current = (await readIdentity(dataDir)).hostId;
  // The drop reads the list, then waits to write it back until a Reset has written it (or, when the Reset can't, a moment).
  const file = path.join(dataDir, "relay-draining.json");
  const { readFile, rename } = fs;
  let held = false;
  let release;
  const released = new Promise((resolve) => (release = resolve));
  t.mock.method(fs, "readFile", async (name, ...args) => {
    const read = await readFile(name, ...args);
    if (name === file && !held) {
      held = true;
      await released;
    }
    return read;
  });
  t.mock.method(fs, "rename", async (from, to) => {
    await rename(from, to);
    if (to === file && held) release();
  });
  first.options.hooks.drained();
  const resetting = phone.reset();
  // Queued behind the drop, the Reset never writes while the drop holds the list, so the hold ends on its own.
  setTimeout(release, 100);
  await resetting;
  await phone.settled();
  assert.deepEqual(
    (await readDraining(dataDir, 0)).map((entry) => entry.hostId),
    [second.options.identity.hostId, current],
  );
});

test("a drain that finishes as the bridge restarts leaves the room for the next launch to hold, and throws nothing", async (t) => {
  const { phone, relays, retired, bridges, dataDir } = await fixture(t, { phoneOptions: { hooks: DRAIN_HOOKS } });
  // A paired phone, then a Reset with phone access off: the old room is both retired and drained by a host of its own.
  await phone.setEnabled(true);
  await phone.settled();
  await relays.find((host) => !host.options.hooksOnly).options.phones.add("phoneA");
  await phone.setEnabled(false);
  await phone.settled();
  await phone.reset();
  await phone.settled();
  const [drain] = drainHosts(retired);
  const old = drain.options.identity.hostId;
  await phone.setEnabled(true);
  await phone.settled();
  assert.equal(phone.status().state, "on");
  const warnings = t.mock.method(console, "warn", () => {});
  // The bridge goes as the finish reads which rooms to hold: restartLater clears `live` outside the queue.
  const retiredFile = path.join(dataDir, "relay-retired.json");
  const { readFile } = fs;
  let lost = false;
  t.mock.method(fs, "readFile", async (name, ...args) => {
    if (name === retiredFile && !lost) {
      lost = true;
      bridges.at(-1).lose();
    }
    return readFile(name, ...args);
  });
  drain.options.hooks.drained();
  await waitFor(() => lost && drain.closed);
  await waitFor(() => phone.status().state === "on" && retired.some((host) => !host.closed && host !== drain && host.options.identity.hostId === old));
  assert.equal(warnings.mock.callCount(), 0);
});

test("a drain whose finish fails says so in the log, with the error's message and no key", async (t) => {
  const { phone, retired, dataDir } = await fixture(t, { phoneOptions: { hooks: DRAIN_HOOKS } });
  await phone.start();
  await phone.settled();
  await phone.reset();
  await phone.settled();
  const [drain] = drainHosts(retired);
  const file = path.join(dataDir, "relay-draining.json");
  const { rename } = fs;
  t.mock.method(fs, "rename", async (from, to) => {
    if (to === file) throw new Error("disk full");
    return rename(from, to);
  });
  const warnings = t.mock.method(console, "warn", () => {});
  drain.options.hooks.drained();
  await phone.settled();
  await waitFor(() => warnings.mock.callCount() === 1);
  const logged = warnings.mock.calls[0].arguments.join(" ");
  assert.match(logged, /disk full/);
  const { hostId, sign } = drain.options.identity;
  for (const secret of [hostId, b64url(sign.secretKey), b64url(sign.publicKey)]) assert.equal(logged.includes(secret), false);
});
