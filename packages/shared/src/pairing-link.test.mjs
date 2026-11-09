import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePairing, validRelay, privatePairingLink } from "./pairing-link.mjs";

const token = "a".repeat(64);
const hostId = "h".repeat(22);
const key = "k".repeat(43);
const link = (relay, name = "studio") =>
  `milagre://pair?relay=${encodeURIComponent(relay)}&host=${hostId}&key=${key}&token=${token}&name=${encodeURIComponent(name)}`;

test("a relay link reads as the phone always read it", () => {
  assert.deepEqual(parsePairing(link("wss://relay.milagre.cloud")), {
    address: `relay://${hostId}`,
    token,
    name: "studio",
    relay: { url: "wss://relay.milagre.cloud", hostId, key },
  });
  assert.equal(parsePairing(link("wss://relay.milagre.cloud", "")).name, "Mac");
  assert.throws(() => parsePairing("https://example.com/pair?token=x"), /not a Milagre pairing link/);
});

test("loopback device routes are read only in local fixtures", () => {
  assert.throws(() => parsePairing(link("ws://127.0.0.1:8080")), /damaged/);
  assert.equal(parsePairing(link("ws://127.0.0.1:8080"), { allowLocalRelay: true }).relay.url, "ws://127.0.0.1:8080");
  assert.equal(parsePairing(link("ws://192.168.1.20:8080")).relay.url, "ws://192.168.1.20:8080");
  assert.throws(() => validRelay({ url: "ws://127.0.0.1:8080", hostId, key }), /damaged/);
});

test("private pairing keeps the pinned identity and removes the public fallback", () => {
  const direct = ["ws://192.168.1.20:8798", "ws://100.107.136.115:8798"];
  const automatic = link("wss://relay.milagre.cloud") + `&direct=${encodeURIComponent(JSON.stringify(direct))}`;
  const parsed = parsePairing(privatePairingLink(automatic));
  assert.deepEqual(parsed.relay, { url: direct[0], hostId, key, direct });
  assert.equal(parsed.token, token);
  assert.equal(parsed.address, `relay://${hostId}`);
  assert.ok(!privatePairingLink(automatic).includes("milagre.cloud"));
  assert.throws(() => privatePairingLink(link("wss://relay.milagre.cloud")), /no private network address/);
});

test("device routes reject public plain WebSockets, malformed addresses and oversized route lists", () => {
  for (const url of [
    "ws://8.8.8.8:8798",
    "ws://100.128.0.1:8798",
    "ws://172.32.0.1:8798",
    "ws://mac.local:8798",
    "ws://192.168.1.20/path",
    "ws://user@192.168.1.20:8798",
  ]) {
    assert.throws(() => parsePairing(link(url)), /damaged/);
  }
  for (const direct of [["ws://8.8.8.8:8798"], ["ws://192.168.1.20:8798?token=x"], Array(5).fill("ws://192.168.1.20:8798"), "bad"]) {
    assert.throws(() => parsePairing(link("wss://relay.milagre.cloud") + `&direct=${encodeURIComponent(JSON.stringify(direct))}`), /damaged/);
  }
});
