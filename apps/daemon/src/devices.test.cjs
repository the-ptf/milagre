const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { preparePrivateDirectory, assertPrivate } = require("@milagre/core/private-files");
const { createDevices, MAX_DEVICES, CLAIM_MS } = require("./devices.cjs");

// The daemon keeps these in its data folder, which it makes private first: mkdtemp is 0700 on macOS and Linux, and
// Windows needs its ACL set.
const tmp = async (name) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  if (process.platform === "win32") preparePrivateDirectory(dir);
  return dir;
};
const saved = async (dir) => JSON.parse(await fs.readFile(path.join(dir, "devices.json"), "utf8"));
// 0600 on macOS and Linux; on Windows, an ACL only this user and SYSTEM hold.
const assertPrivateFile = async (dir, name) => {
  if (process.platform === "win32") assertPrivate(path.join(dir, name));
  else assert.equal((await fs.stat(path.join(dir, name))).mode & 0o777, 0o600);
};
// Makes the next write of devices.json fail until the returned function undoes it: a read-only folder on macOS and
// Linux; on Windows, where a folder's read-only bit doesn't stop writes, a folder in the file's place.
async function failWrites(dir) {
  if (process.platform !== "win32") {
    await fs.chmod(dir, 0o500);
    return () => fs.chmod(dir, 0o700);
  }
  const file = path.join(dir, "devices.json");
  await fs.rename(file, `${file}.saved`);
  await fs.mkdir(file);
  return async () => {
    await fs.rmdir(file);
    await fs.rename(`${file}.saved`, file);
  };
}
const isNew = (list) => Object.fromEntries(list.map((device) => [device.key, device.isNew]));

test("a device is remembered with its kind, name and times, privately, across loads", async () => {
  const dir = await tmp("devices");
  let now = 1000;
  const devices = createDevices(dir, { now: () => now });
  await devices.load();
  await devices.add("phoneA", { kind: "phone", name: "Victor's iPhone" });
  now = 2000;
  await devices.add("macB", { kind: "computer", name: "studio" });
  const again = createDevices(dir);
  await again.load();
  assert.deepEqual(again.list(), [
    { key: "phoneA", kind: "phone", name: "Victor's iPhone", pairedAt: 1000, lastSeen: 1000, isNew: true },
    { key: "macB", kind: "computer", name: "studio", pairedAt: 2000, lastSeen: 2000, isNew: false },
  ]);
  assert.equal(again.isKnown("phoneA"), true);
  assert.equal(again.count(), 2);
  await assertPrivateFile(dir, "devices.json");
});

test("add with no kind or name is a nameless phone, and an unknown kind is refused", async () => {
  const dir = await tmp("devices-plain");
  const devices = createDevices(dir, { now: () => 7 });
  await devices.add("phoneA");
  assert.deepEqual(devices.list(), [{ key: "phoneA", kind: "phone", name: null, pairedAt: 7, lastSeen: 7, isNew: true }]);
  await assert.rejects(devices.add("x", { kind: "tablet" }), /kind/);
});

test("the phone list counts its phones, and reset forgets them", async () => {
  const dir = await tmp("devices-count");
  const devices = createDevices(dir);
  await devices.load();
  assert.equal(devices.count(), 0);
  await devices.add("phoneA");
  await devices.add("phoneB");
  await devices.add("phoneA");
  assert.equal(devices.count(), 2);
  await devices.clear();
  assert.equal(devices.count(), 0);
  const again = createDevices(dir);
  await again.load();
  assert.equal(again.isKnown("phoneA"), false);
});

test("only the 32 newest devices are remembered", async () => {
  const dir = await tmp("devices-cap");
  const devices = createDevices(dir);
  await devices.load();
  for (let i = 0; i <= MAX_DEVICES; i++) await devices.add(`phone${i}`);
  assert.equal(MAX_DEVICES, 32);
  assert.equal(devices.isKnown("phone0"), false);
  assert.equal(devices.isKnown("phone1"), true);
  assert.equal(devices.isKnown("phone32"), true);
});

test("phones from relay-phones.json move to devices.json as nameless phones, and the old file goes", async () => {
  const dir = await tmp("devices-migrate");
  await fs.writeFile(path.join(dir, "relay-phones.json"), JSON.stringify({ phones: ["phoneA", "phoneB"] }), { mode: 0o600 });
  const devices = createDevices(dir);
  await devices.load();
  assert.deepEqual(devices.list(), [
    { key: "phoneA", kind: "phone", name: null, pairedAt: null, lastSeen: null, isNew: false },
    { key: "phoneB", kind: "phone", name: null, pairedAt: null, lastSeen: null, isNew: false },
  ]);
  assert.deepEqual(
    (await saved(dir)).devices.map((device) => device.key),
    ["phoneA", "phoneB"],
  );
  await assertPrivateFile(dir, "devices.json");
  await assert.rejects(fs.stat(path.join(dir, "relay-phones.json")), { code: "ENOENT" }, "a downgrade must not bring back a removed phone");
});

test("a migrated phone takes its name from its next hello", async () => {
  const dir = await tmp("devices-migrate-name");
  await fs.writeFile(path.join(dir, "relay-phones.json"), JSON.stringify({ phones: ["phoneA"] }), { mode: 0o600 });
  const devices = createDevices(dir, { now: () => 50 });
  await devices.load();
  await devices.seen("phoneA", { name: "Victor's iPhone" });
  assert.deepEqual((await saved(dir)).devices[0], {
    key: "phoneA",
    kind: "phone",
    name: "Victor's iPhone",
    pairedAt: null,
    lastSeen: 50,
    isNew: false,
    announced: true,
  });
});

test("a store used before load still keeps the migrated phones", async () => {
  const dir = await tmp("devices-early");
  await fs.writeFile(path.join(dir, "relay-phones.json"), JSON.stringify({ phones: ["phoneA"] }), { mode: 0o600 });
  await createDevices(dir).add("phoneC");
  const again = createDevices(dir);
  await again.load();
  assert.deepEqual(
    again.list().map((device) => device.key),
    ["phoneA", "phoneC"],
  );
});

test("a relay-phones.json that is not private is not trusted, and is left for the owner to see", async () => {
  const dir = await tmp("devices-open");
  const legacy = path.join(dir, "relay-phones.json");
  await fs.writeFile(legacy, JSON.stringify({ phones: ["phoneA"] }));
  await fs.chmod(legacy, 0o644);
  // Windows has no mode bits: Builtin Users may read it there.
  if (process.platform === "win32") execFileSync("icacls", [legacy, "/grant", "*S-1-5-32-545:(R)"], { stdio: "ignore" });
  const devices = createDevices(dir);
  await devices.load();
  assert.deepEqual(devices.list(), []);
  await fs.stat(legacy);
});

test("seen moves lastSeen at every hello but writes at most once a minute, and a new name at once", async () => {
  const dir = await tmp("devices-seen");
  let now = 0;
  const devices = createDevices(dir, { now: () => now });
  await devices.load();
  await devices.add("phoneA");
  now = 10_000;
  await devices.seen("phoneA");
  assert.equal(devices.list()[0].lastSeen, 10_000);
  assert.equal((await saved(dir)).devices[0].lastSeen, 0, "not written within the minute");
  now = 20_000;
  await devices.seen("phoneA", { name: "Victor's iPhone" });
  assert.deepEqual((await saved(dir)).devices[0], {
    key: "phoneA",
    kind: "phone",
    name: "Victor's iPhone",
    pairedAt: 0,
    lastSeen: 20_000,
    isNew: true,
    announced: false,
  });
  now = 50_000;
  await devices.seen("phoneA");
  assert.equal((await saved(dir)).devices[0].lastSeen, 20_000);
  now = 80_000;
  await devices.seen("phoneA", { name: null });
  assert.equal((await saved(dir)).devices[0].lastSeen, 80_000);
  assert.equal(devices.list()[0].name, "Victor's iPhone", "a hello without a name keeps the one saved");
  await devices.seen("stranger");
  assert.equal(devices.count(), 1, "seen never adds a device");
});

test("remove forgets a device and remembers when; adding it back or a reset clears that", async () => {
  const dir = await tmp("devices-remove");
  let now = 5;
  const devices = createDevices(dir, { now: () => now });
  await devices.load();
  await devices.add("phoneA");
  await devices.add("phoneB");
  now = 9;
  assert.equal(await devices.remove("phoneA"), true);
  assert.equal(await devices.remove("phoneA"), false);
  assert.deepEqual(
    devices.list().map((device) => device.key),
    ["phoneB"],
  );
  assert.equal(devices.removedAt("phoneA"), 9);
  assert.equal(devices.removedAt("phoneB"), null);
  assert.equal(devices.removedAt("constructor"), null);
  const again = createDevices(dir, { now: () => now });
  await again.load();
  assert.equal(again.removedAt("phoneA"), 9);
  await again.add("phoneA");
  assert.equal(again.removedAt("phoneA"), null);
  await again.remove("phoneB");
  await again.clear();
  assert.equal(again.count(), 0);
  assert.equal(again.removedAt("phoneB"), null);
});

test("list during an in-flight load still returns the previous devices", async () => {
  const dir = await tmp("devices-reload");
  const devices = createDevices(dir, { now: () => 5 });
  await devices.load();
  await devices.add("phoneA", { name: "A" });
  await fs.writeFile(path.join(dir, "devices.json"), JSON.stringify({ devices: [{ key: "phoneB", kind: "phone" }], removed: [] }), { mode: 0o600 });
  const load = { settled: false };
  const loading = devices.load().then(() => (load.settled = true));
  const seen = [];
  while (!load.settled) {
    seen.push(
      devices
        .list()
        .map((device) => device.key)
        .join(","),
    );
    await new Promise((resolve) => setImmediate(resolve));
  }
  await loading;
  assert.ok(seen.length > 0);
  assert.ok(
    seen.every((keys) => keys === "phoneA"),
    `list was ${JSON.stringify(seen)}`,
  );
  assert.deepEqual(
    devices.list().map((device) => device.key),
    ["phoneB"],
  );
});

test("kindOf says what a device paired as, and null for a key that isn't paired", async () => {
  const dir = await tmp("devices-kind");
  const devices = createDevices(dir, { now: () => 1 });
  await devices.add("phoneA");
  await devices.add("macB", { kind: "computer", name: "studio" });
  assert.equal(devices.kindOf("phoneA"), "phone");
  assert.equal(devices.kindOf("macB"), "computer");
  assert.equal(devices.kindOf("nobody"), null);
  await devices.remove("macB");
  assert.equal(devices.kindOf("macB"), null);
});

// Takes the pairing notices and confirms them, as a window does once it has shown them.
async function announce(devices) {
  const { claim, devices: list } = await devices.takeNotices();
  if (claim) await devices.confirmNotices(claim);
  return list;
}
const keysOf = (list) => list.map((device) => device.key);

test("a phone's pairing is handed out once to whoever takes it first, and that survives a restart", async () => {
  const dir = await tmp("devices-notices");
  let now = 10;
  const devices = createDevices(dir, { now: () => now });
  await devices.load();
  await devices.add("phoneA", { name: "Victor's iPhone" });
  now = 20;
  await devices.add("phoneB");
  // A computer pairs only after its owner's Allow in this Mac's window: nothing to announce.
  await devices.add("macC", { kind: "computer", name: "studio" });
  // Two windows (or a connect racing a pairing event) asking at once: each pairing goes to exactly one of them.
  const [first, second] = await Promise.all([devices.takeNotices(), devices.takeNotices()]);
  assert.deepEqual(keysOf([...first.devices, ...second.devices]), ["phoneA", "phoneB"]);
  assert.deepEqual(first.devices[0], { key: "phoneA", kind: "phone", name: "Victor's iPhone", pairedAt: 10, lastSeen: 10, isNew: true });
  assert.deepEqual(second, { claim: null, devices: [] });
  assert.equal(await devices.confirmNotices(first.claim), 2);
  assert.deepEqual(await devices.takeNotices(), { claim: null, devices: [] });
  // A daemon started again doesn't announce them a second time.
  const again = createDevices(dir);
  await again.load();
  assert.deepEqual(await again.takeNotices(), { claim: null, devices: [] });
});

test("a phone that paired while no desktop was there is still announced after the daemon restarts", async () => {
  const dir = await tmp("devices-notices-restart");
  await createDevices(dir, { now: () => 5 }).add("phoneA", { name: "Pixel" });
  const again = createDevices(dir);
  await again.load();
  assert.deepEqual(
    (await announce(again)).map((device) => device.name),
    ["Pixel"],
  );
  assert.equal((await saved(dir)).devices[0].announced, true);
});

test("a notice taken but never confirmed (its reply was lost) goes back to pending: released, timed out, or after a restart", async () => {
  const dir = await tmp("devices-notices-claim");
  let now = 0;
  const devices = createDevices(dir, { now: () => now });
  await devices.add("phoneA");
  // The claim is in memory only: the file still says it waits to be announced.
  const lost = await devices.takeNotices();
  assert.deepEqual(keysOf(lost.devices), ["phoneA"]);
  assert.equal((await saved(dir)).devices[0].announced, false);
  // While the claim holds, no other window shows it.
  assert.deepEqual(await devices.takeNotices(), { claim: null, devices: [] });
  // The connection that took it closed before showing it: the next window gets it.
  devices.releaseNotices(lost.claim);
  const second = await devices.takeNotices();
  assert.deepEqual(keysOf(second.devices), ["phoneA"]);
  // A confirm for a released claim does nothing.
  assert.equal(await devices.confirmNotices(lost.claim), 0);
  // Nobody confirms or releases: after the claim times out it is offered again.
  now = CLAIM_MS - 1;
  assert.deepEqual((await devices.takeNotices()).devices, []);
  now = CLAIM_MS;
  const third = await devices.takeNotices();
  assert.deepEqual(keysOf(third.devices), ["phoneA"]);
  assert.equal(await devices.confirmNotices(second.claim), 0, "a claim that timed out and was taken again no longer confirms");
  // A restart with the claim still open loses nothing.
  const again = createDevices(dir);
  await again.load();
  assert.deepEqual(keysOf(await announce(again)), ["phoneA"]);
  assert.deepEqual((await again.takeNotices()).devices, []);
});

test("a confirm whose write fails keeps the notice pending on disk and doesn't hand it out again until its claim ends", async () => {
  const dir = await tmp("devices-notices-confirm-fail");
  let now = 0;
  const devices = createDevices(dir, { now: () => now });
  await devices.add("phoneA");
  const taken = await devices.takeNotices();
  const restore = await failWrites(dir);
  try {
    await assert.rejects(devices.confirmNotices(taken.claim));
  } finally {
    await restore();
  }
  assert.deepEqual((await devices.takeNotices()).devices, [], "no second window shows it right away");
  now = CLAIM_MS;
  const retry = await devices.takeNotices();
  assert.deepEqual(keysOf(retry.devices), ["phoneA"]);
  assert.equal(await devices.confirmNotices(retry.claim), 1);
  assert.equal((await saved(dir)).devices[0].announced, true);
});

test("a phone stays New until the owner sees it, on disk too; a computer is never New", async () => {
  const dir = await tmp("devices-new");
  const devices = createDevices(dir, { now: () => 1 });
  await devices.add("phoneA");
  await devices.add("phoneB");
  await devices.add("macC", { kind: "computer" });
  assert.deepEqual(isNew(devices.list()), { phoneA: true, phoneB: true, macC: false });
  // Only the keys the owner saw: a phone that paired after the list was read stays New.
  assert.equal(await devices.acknowledge(["phoneA", "macC", "stranger"]), 1);
  assert.equal(await devices.acknowledge(["phoneA"]), 0);
  assert.deepEqual(isNew(devices.list()), { phoneA: false, phoneB: true, macC: false });
  const again = createDevices(dir);
  await again.load();
  assert.deepEqual(isNew(again.list()), { phoneA: false, phoneB: true, macC: false });
  // Seeing a phone doesn't announce it, and announcing it doesn't mark it seen: the notice and the marker are separate.
  assert.deepEqual(keysOf(await announce(again)), ["phoneA", "phoneB"]);
  assert.equal(isNew(again.list()).phoneB, true);
});

test("an acknowledge whose write fails leaves the phone New, so the next one writes it", async () => {
  const dir = await tmp("devices-new-fail");
  const devices = createDevices(dir, { now: () => 1 });
  await devices.add("phoneA");
  const restore = await failWrites(dir);
  try {
    await assert.rejects(devices.acknowledge(["phoneA"]));
  } finally {
    await restore();
  }
  assert.equal(devices.list()[0].isNew, true, "memory agrees with the file");
  assert.equal(await devices.acknowledge(["phoneA"]), 1);
  assert.equal((await saved(dir)).devices[0].isNew, false);
});

test("a removed phone is no longer announced, and devices saved before these fields are neither announced nor New", async () => {
  const dir = await tmp("devices-new-old");
  await fs.writeFile(
    path.join(dir, "devices.json"),
    JSON.stringify({ devices: [{ key: "phoneA", kind: "phone", name: null, pairedAt: 1, lastSeen: 1 }], removed: [] }),
    { mode: 0o600 },
  );
  const devices = createDevices(dir, { now: () => 2 });
  await devices.load();
  assert.equal(devices.list()[0].isNew, false);
  assert.deepEqual((await devices.takeNotices()).devices, []);
  await devices.add("phoneB");
  await devices.remove("phoneB");
  assert.deepEqual((await devices.takeNotices()).devices, []);
});
