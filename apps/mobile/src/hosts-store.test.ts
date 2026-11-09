import { test } from "node:test";
import assert from "node:assert/strict";
import { createHostsStore } from "./hosts-store.ts";
import { parsePairing } from "./pairing.ts";

const token = "a".repeat(64);
function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItemAsync: async (key: string) => values.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
      values.set(key, value);
    },
    deleteItemAsync: async (key: string) => {
      values.delete(key);
    },
  };
}

test("saved computers list newest first and re-pairing replaces the same address", async () => {
  let clock = 1;
  const store = createHostsStore(storage(), () => clock++);
  await store.save({ name: "MacBook Pro", address: "https://mac.example.com", token });
  await store.save({ name: "Studio", address: "https://studio.example.com", token });
  await store.save({ name: "MacBook Pro (new token)", address: "https://mac.example.com/", token: "b".repeat(64) });
  const hosts = await store.list();
  assert.deepEqual(
    hosts.map((host) => host.name),
    ["MacBook Pro (new token)", "Studio"],
  );
  assert.ok(hosts[0] !== undefined);
  assert.equal(hosts[0].token, "b".repeat(64));
});

test("the single connection saved before multiple computers is migrated", async () => {
  const driver = storage();
  driver.values.set("milagre.connection.v1", JSON.stringify({ address: "http://127.0.0.1:8787", token }));
  const store = createHostsStore(driver, () => 5);
  assert.deepEqual(
    (await store.list()).map((host) => host.address),
    ["http://127.0.0.1:8787"],
  );
  await store.rename("http://127.0.0.1:8787", "Simulator host");
  assert.equal(driver.values.has("milagre.connection.v1"), false);
  const [renamed] = await store.list();
  assert.ok(renamed);
  assert.equal(renamed.name, "Simulator host");
});

test("forget removes only that computer and waits for a pending save", async () => {
  const driver = storage();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = createHostsStore({
    ...driver,
    setItemAsync: async (key, value) => {
      await gate;
      await driver.setItemAsync(key, value);
    },
  });
  const saving = store.save({ name: "Mac", address: "https://mac.example.com", token });
  const forgetting = store.forget("https://mac.example.com");
  release();
  await Promise.all([saving, forgetting]);
  assert.deepEqual(await store.list(), []);
});

test("remote plaintext addresses and bad tokens are rejected", async () => {
  const store = createHostsStore(storage());
  await assert.rejects(store.save({ name: "Mac", address: "http://192.168.0.4:8787", token }), /HTTPS/);
  await assert.rejects(store.save({ name: "Mac", address: "https://mac.example.com", token: "short" }), /token/);
});

test("pairing links from the host QR parse into a computer", () => {
  const link = `milagre://pair?address=${encodeURIComponent("https://mac.example.com")}&token=${token}&name=${encodeURIComponent("Victor's MacBook Pro")}`;
  assert.deepEqual(parsePairing(link), { address: "https://mac.example.com", token, name: "Victor's MacBook Pro" });
  assert.equal(parsePairing(`milagre://pair?address=${encodeURIComponent("http://127.0.0.1:8787")}&token=${token}`).name, "127.0.0.1");
  assert.equal(parsePairing(`milagre-local://pair?address=${encodeURIComponent("http://127.0.0.1:8787")}&token=${token}`).address, "http://127.0.0.1:8787");
  assert.throws(() => parsePairing("https://example.com/pair?token=x"), /not a Milagre pairing link/);
  assert.throws(() => parsePairing(`milagre://pair?address=x&token=short`), /valid token/);
});

test("a damaged saved entry is dropped instead of blocking the others and new pairings", async () => {
  const driver = storage();
  const store = createHostsStore(driver, () => 1);
  await store.save({ name: "Studio", address: "https://studio.example.com", token });
  const key = [...driver.values.keys()][0];
  assert.ok(key !== undefined);
  driver.values.set(key, JSON.stringify([...JSON.parse(driver.values.get(key)!), { address: "ftp://bad", token: "short" }]));
  assert.deepEqual(
    (await store.list()).map((host) => host.name),
    ["Studio"],
  );
  await store.save({ name: "MacBook Pro", address: "https://mac.example.com", token });
  assert.equal((await store.list()).length, 2);
});

test("a Cloudflare pairing link keeps its Access token through save and list", async () => {
  const access = { id: `${"c".repeat(32)}.access`, secret: "Secret_with-mixed".padEnd(43, "z") };
  const pairing = parsePairing(
    `milagre://pair?address=${encodeURIComponent("https://mac.example.cloud")}&token=${token}&name=Mac&cfId=${access.id}&cfSecret=${access.secret}`,
  );
  assert.deepEqual(pairing.access, access);
  const store = createHostsStore(storage(), () => 1);
  await store.save({ name: pairing.name, address: pairing.address, token: pairing.token, access: pairing.access });
  const [saved] = await store.list();
  assert.ok(saved);
  assert.deepEqual(saved.access, access);
  assert.throws(
    () => parsePairing(`milagre://pair?address=${encodeURIComponent("http://127.0.0.1:8797")}&token=${token}&cfId=${access.id}&cfSecret=${access.secret}`),
    /HTTPS/,
  );
  assert.throws(
    () => parsePairing(`milagre://pair?address=${encodeURIComponent("https://mac.example.cloud")}&token=${token}&cfId=bad&cfSecret=${access.secret}`),
    /Cloudflare/,
  );
});

const hostId = "H".repeat(21) + "g";
const key = "K".repeat(42) + "A";
const relayLink = (params: Record<string, string> = {}) =>
  "milagre://pair?" +
  Object.entries({ relay: "wss://relay.milagre.cloud", host: hostId, key, token, name: "Studio", ...params })
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("&");

test("a relay pairing link round trips into a saved computer", async () => {
  const pairing = parsePairing(relayLink());
  const relay = { url: "wss://relay.milagre.cloud", hostId, key };
  assert.deepEqual(pairing, { address: `relay://${hostId}`, token, name: "Studio", relay });
  const store = createHostsStore(storage(), () => 7);
  const saved = await store.save(pairing);
  assert.deepEqual(saved, { id: `relay://${hostId}`, name: "Studio", address: `relay://${hostId}`, token, relay, lastUsed: 7 });
  assert.deepEqual(await store.list(), [saved]);
  assert.equal(parsePairing(relayLink({ name: "" })).name, "Mac");
  assert.equal((await createHostsStore(storage()).save({ ...pairing, name: "" })).name, "Mac");
});

test("a relay link with a damaged key, host or relay address asks for a new scan", () => {
  assert.throws(() => parsePairing(relayLink({ key: key.slice(1) })), /Scan the code again/);
  assert.throws(() => parsePairing(relayLink({ key: key + "A" })), /Scan the code again/);
  assert.throws(() => parsePairing(relayLink({ host: "short" })), /Scan the code again/);
  assert.throws(() => parsePairing(relayLink({ relay: "https://relay.milagre.cloud" })), /Scan the code again/);
  assert.throws(() => parsePairing(relayLink({ relay: "ws://relay.milagre.cloud" })), /Scan the code again/);
  assert.throws(() => parsePairing(relayLink({ address: "https://mac.example.com" })), /Scan the code again/);
  assert.throws(() => parsePairing(relayLink({ token: "short" })), /valid token/);
});

test("address and relay computers coexist, and rename and forget work on either", async () => {
  let clock = 1;
  const driver = storage();
  const store = createHostsStore(driver, () => clock++);
  await store.save({ name: "MacBook Pro", address: "https://mac.example.com", token });
  const relay = await store.save(parsePairing(relayLink()));
  assert.deepEqual(
    (await store.list()).map((host) => host.id),
    [`relay://${hostId}`, "https://mac.example.com"],
  );
  // Pairing the same Mac again replaces it rather than adding a second entry.
  await store.save(parsePairing(relayLink({ token: "b".repeat(64), name: "Studio (new code)" })));
  assert.deepEqual(
    (await store.list()).map((host) => [host.name, host.token]),
    [
      ["Studio (new code)", "b".repeat(64)],
      ["MacBook Pro", token],
    ],
  );
  await store.rename(relay.id, "Office");
  const [renamed] = await store.list();
  assert.ok(renamed);
  assert.equal(renamed.name, "Office");
  await store.forget(relay.id);
  assert.deepEqual(
    (await store.list()).map((host) => host.id),
    ["https://mac.example.com"],
  );
  // A damaged relay entry is dropped like any other.
  const stored = [...driver.values.keys()][0];
  assert.ok(stored !== undefined);
  driver.values.set(
    stored,
    JSON.stringify([
      ...JSON.parse(driver.values.get(stored)!),
      { name: "Bad", address: "relay://x", token, relay: { url: "wss://relay.milagre.cloud", hostId, key: "short" } },
    ]),
  );
  assert.deepEqual(
    (await store.list()).map((host) => host.id),
    ["https://mac.example.com"],
  );
});

const lan = { hostId: "H".repeat(22), key: "K".repeat(43), endpoints: ["ws://192.168.1.20:8798"], learnedAt: 1 };

test("learn saves a LAN route on that computer, and a re-pairing keeps it until relearned", async () => {
  const store = createHostsStore(storage());
  const saved = await store.save({ name: "Mac", address: "https://mac.example.com", token });
  await store.learn(saved.id, lan);
  const [learned] = await store.list();
  assert.ok(learned);
  assert.deepEqual(learned.routes, { lan });
  await store.save({ name: "Mac", address: "https://mac.example.com", token: "b".repeat(64) });
  const [repaired] = await store.list();
  assert.ok(repaired);
  assert.deepEqual(repaired.routes, { lan });
  await store.learn(saved.id, undefined);
  const [forgottenRoute] = await store.list();
  assert.ok(forgottenRoute);
  assert.equal(forgottenRoute.routes, undefined);
});

test("a damaged LAN route is dropped, the computer is kept", async () => {
  const driver = storage();
  driver.values.set("milagre.hosts.v1", JSON.stringify([{ name: "Mac", address: "https://mac.example.com", token, routes: { lan: { hostId: "bad" } } }]));
  const [host] = await createHostsStore(driver).list();
  assert.ok(host !== undefined);
  assert.equal(host.address, "https://mac.example.com");
  assert.equal(host.routes, undefined);
});

test("a hidden computer stays hidden across re-pairing and shows again when unhidden", async () => {
  const store = createHostsStore(storage(), () => 1);
  await store.save({ name: "Studio", address: "https://studio.example.com", token });
  await store.save({ name: "Mac", address: "https://mac.example.com", token });
  await store.setHidden("https://studio.example.com", true);
  assert.deepEqual(
    (await store.list()).map((host) => [host.name, host.hidden]),
    [
      ["Mac", undefined],
      ["Studio", true],
    ],
  );
  await store.save({ name: "Studio again", address: "https://studio.example.com", token: "b".repeat(64) });
  assert.equal((await store.list()).find((host) => host.address === "https://studio.example.com")?.hidden, true);
  await store.setHidden("https://studio.example.com", false);
  assert.equal((await store.list()).find((host) => host.address === "https://studio.example.com")?.hidden, undefined);
  await store.setHidden("https://missing.example.com", true);
  assert.equal((await store.list()).length, 2);
});
