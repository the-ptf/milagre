const test = require("node:test");
const assert = require("node:assert/strict");
const { relayPairingLink } = require("./mobile-pairing.cjs");

const base = { relay: "wss://relay.milagre.cloud", hostId: "a".repeat(22), key: "b".repeat(43), token: "c".repeat(64), name: "Test Mac" };

test("the relay link carries the relay origin, host id, host key, token and name", () => {
  assert.equal(
    relayPairingLink(base),
    `milagre://pair?relay=wss%3A%2F%2Frelay.milagre.cloud&host=${base.hostId}&key=${base.key}&token=${base.token}&name=Test%20Mac`,
  );
  assert.match(
    relayPairingLink({ ...base, relay: "wss://relay.milagre.cloud/some/path?x=1" }),
    /^milagre:\/\/pair\?relay=wss%3A%2F%2Frelay\.milagre\.cloud&host=/,
  );
});

test("this Mac's name is looked up once per host, or each time it is asked with options", (t) => {
  const childProcess = require("node:child_process");
  const os = require("node:os");
  const { execFileSync } = childProcess;
  const { hostname } = os;
  let lookups = 0;
  // A fresh copy of the module, reading names through these: scutil on a Mac, the hostname elsewhere.
  childProcess.execFileSync = () => {
    lookups++;
    return "Studio\n";
  };
  os.hostname = () => {
    lookups++;
    return "studio.local";
  };
  const file = require.resolve("./mobile-pairing.cjs");
  delete require.cache[file];
  t.after(() => {
    childProcess.execFileSync = execFileSync;
    os.hostname = hostname;
    delete require.cache[file];
  });
  const { computerName } = require("./mobile-pairing.cjs");
  const expected = process.platform === "darwin" ? "Studio" : "studio";
  assert.equal(computerName(), expected);
  assert.equal(computerName(), expected);
  assert.equal(lookups, 1, "scutil holds the event loop; it runs once");
  const run = () => {
    lookups++;
    return "Renamed\n";
  };
  assert.equal(computerName({ platform: "darwin", run }), "Renamed");
  assert.equal(computerName({ platform: "darwin", run }), "Renamed");
  assert.equal(computerName({ platform: "linux", hostname: () => "box.local" }), "box");
  assert.equal(lookups, 3, "asked with options, it looks again");
  assert.equal(computerName(), expected, "the host's own name is kept");
});

test("the relay link refuses anything that is not a ws URL, a host id, a key or a token", () => {
  assert.throws(() => relayPairingLink({ ...base, relay: "nope" }), /URL/);
  assert.throws(() => relayPairingLink({ ...base, relay: "https://relay.milagre.cloud" }), /ws or wss/);
  assert.throws(() => relayPairingLink({ ...base, hostId: "short" }), /host id/);
  assert.throws(() => relayPairingLink({ ...base, key: "short" }), /host key/);
  assert.throws(() => relayPairingLink({ ...base, token: "short" }), /token/);
});
