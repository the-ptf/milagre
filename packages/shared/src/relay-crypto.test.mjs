import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import { boxKeyPair, signKeyPair, hostIdOf, phoneHello, hostAccept, phoneFinish, b64url, fromB64url, helloName } from "./relay-crypto.mjs";

const random = (n) => new Uint8Array(randomBytes(n));
const token = "a".repeat(64);
function pair() {
  const host = boxKeyPair(random),
    phone = boxKeyPair(random);
  return { host, phone };
}

test("base64url round trips and hostIdOf is stable and 22 chars", () => {
  const bytes = random(40);
  assert.deepEqual(fromB64url(b64url(bytes)), bytes);
  const sign = signKeyPair(random);
  assert.equal(hostIdOf(sign.publicKey), hostIdOf(sign.publicKey));
  assert.match(hostIdOf(sign.publicKey), /^[A-Za-z0-9_-]{22}$/);
});

test("first pairing with the token opens a channel both ways", () => {
  const { host, phone } = pair();
  const { message, ephemeral } = phoneHello({ phone, host: host.publicKey, token, random });
  const accepted = hostAccept({ host, hello: message, isKnown: () => false, canPair: true, token, random });
  assert.equal(accepted.firstPairing, true);
  assert.equal(accepted.phoneKey, b64url(phone.publicKey));
  const phoneSide = phoneFinish({ ephemeral, phone, host: host.publicKey, reply: accepted.reply });
  assert.deepEqual(accepted.channel.open(phoneSide.seal({ t: "ping" })), { t: "ping" });
  assert.deepEqual(phoneSide.open(accepted.channel.seal({ t: "pong" })), { t: "pong" });
});

test("an unknown phone outside the pairing window is refused, even with the token", () => {
  const { host, phone } = pair();
  const { message } = phoneHello({ phone, host: host.publicKey, token, random });
  assert.throws(() => hostAccept({ host, hello: message, isKnown: () => false, canPair: false, token, random }), { code: "unknown-phone" });
});

test("a wrong token is refused", () => {
  const { host, phone } = pair();
  const { message } = phoneHello({ phone, host: host.publicKey, token: "b".repeat(64), random });
  assert.throws(() => hostAccept({ host, hello: message, isKnown: () => true, token, random }), { code: "bad-token" });
});

test("a hello for another host is refused", () => {
  const { host, phone } = pair();
  const other = boxKeyPair(random);
  const { message } = phoneHello({ phone, host: other.publicKey, token, random });
  assert.throws(() => hostAccept({ host, hello: message, isKnown: () => true, token, random }), { code: "bad-hello" });
});

test("a swapped ephemeral key is refused", () => {
  const { host, phone } = pair();
  const { message } = phoneHello({ phone, host: host.publicKey, token, random });
  message.set(random(32), 1); // replace Ep in the clear
  assert.throws(() => hostAccept({ host, hello: message, isKnown: () => true, token, random }), { code: "bad-hello" });
});

test("the phone refuses a reply that is not from the pinned host", () => {
  const { host, phone } = pair();
  const other = boxKeyPair(random);
  const { message, ephemeral } = phoneHello({ phone, host: host.publicKey, token, random });
  const accepted = hostAccept({ host, hello: message, isKnown: () => true, token, random });
  assert.throws(() => phoneFinish({ ephemeral, phone, host: other.publicKey, reply: accepted.reply }));
});

test("replay is rejected", () => {
  const { host, phone } = pair();
  const { message, ephemeral } = phoneHello({ phone, host: host.publicKey, token, random });
  const accepted = hostAccept({ host, hello: message, isKnown: () => true, token, random });
  const phoneSide = phoneFinish({ ephemeral, phone, host: host.publicKey, reply: accepted.reply });
  const frame = phoneSide.seal({ t: "req", id: 1 });
  accepted.channel.open(frame);
  assert.throws(() => accepted.channel.open(frame), /replay|order/);
});

test("tampering is rejected", () => {
  const { host, phone } = pair();
  const { message, ephemeral } = phoneHello({ phone, host: host.publicKey, token, random });
  const accepted = hostAccept({ host, hello: message, isKnown: () => true, token, random });
  const phoneSide = phoneFinish({ ephemeral, phone, host: host.publicKey, reply: accepted.reply });
  const frame = phoneSide.seal({ t: "req", id: 1 });
  frame[frame.length - 1] ^= 1;
  assert.throws(() => accepted.channel.open(frame), /decrypt/);
});

test("a boxed null inner payload is refused as bad-hello, not a TypeError", () => {
  const { host, phone } = pair();
  const eph = boxKeyPair(random);
  const nonce = random(24);
  const box = nacl.box(new TextEncoder().encode("null"), nonce, host.publicKey, phone.secretKey);
  const hello = new Uint8Array(89 + box.length);
  hello[0] = 0x01;
  hello.set(eph.publicKey, 1);
  hello.set(phone.publicKey, 33);
  hello.set(nonce, 65);
  hello.set(box, 89);
  assert.throws(() => hostAccept({ host, hello, isKnown: () => true, token, random }), { code: "bad-hello" });
});

test("a hello that is not bytes is refused as bad-hello", () => {
  const { host } = pair();
  for (const hello of [undefined, null, "hello", [1, 2, 3]]) {
    assert.throws(() => hostAccept({ host, hello, isKnown: () => true, token, random }), { code: "bad-hello" });
  }
});

test("a hello may name the device and say what kind it is; without a kind it is a phone", () => {
  const { host, phone } = pair();
  const plain = hostAccept({ host, hello: phoneHello({ phone, host: host.publicKey, token, random }).message, isKnown: () => true, token, random });
  assert.equal(plain.kind, "phone");
  assert.equal(plain.name, null);
  const named = hostAccept({
    host,
    hello: phoneHello({ phone, host: host.publicKey, token, random, name: "  Victor's iPhone ", kind: "desktop" }).message,
    isKnown: () => true,
    token,
    random,
  });
  assert.equal(named.kind, "desktop");
  assert.equal(named.name, "Victor's iPhone");
});

test("a hello's name is cleaned: control and bidi characters go, 64 characters at most, blank is none", () => {
  assert.equal(helloName("a\u0000b\u202ec\n"), "abc");
  assert.equal(helloName("é".repeat(80)), "é".repeat(64));
  assert.equal(helloName("x".repeat(1024)), "x".repeat(64));
  assert.equal(helloName("👩\u200d💻 laptop"), "👩\u200d💻 laptop");
  assert.equal(helloName("   "), null);
  assert.equal(helloName(42), null);
  assert.equal(helloName(undefined), null);
});

test("a hello with an unknown kind is refused as bad-hello", () => {
  const { host, phone } = pair();
  const { message } = phoneHello({ phone, host: host.publicKey, token, random, kind: "toaster" });
  assert.throws(() => hostAccept({ host, hello: message, isKnown: () => true, token, random }), { code: "bad-hello" });
});

test("canPair may decide per device: one new phone is turned away while another pairs", () => {
  const { host, phone } = pair();
  const blocked = b64url(phone.publicKey);
  const canPair = (key) => key !== blocked;
  const { message } = phoneHello({ phone, host: host.publicKey, token, random });
  assert.throws(() => hostAccept({ host, hello: message, isKnown: () => false, canPair, token, random }), { code: "unknown-phone" });
  const other = boxKeyPair(random);
  const accepted = hostAccept({
    host,
    hello: phoneHello({ phone: other, host: host.publicKey, token, random }).message,
    isKnown: () => false,
    canPair,
    token,
    random,
  });
  assert.equal(accepted.firstPairing, true);
});

test("sealEncoded seals JSON text already encoded, in the same counter sequence as seal", () => {
  const { host, phone } = pair();
  const { message, ephemeral } = phoneHello({ phone, host: host.publicKey, token, random, kind: "desktop" });
  const accepted = hostAccept({ host, hello: message, isKnown: () => false, canPair: true, token, random });
  const desktop = phoneFinish({ ephemeral, phone, host: host.publicKey, reply: accepted.reply });
  assert.deepEqual(desktop.open(accepted.channel.seal({ t: "pong" })), { t: "pong" });
  const encoded = new TextEncoder().encode('{"t":"evt","frame":{"v":1,"id":1,"result":"ação🙂"}}');
  assert.deepEqual(desktop.open(accepted.channel.sealEncoded(encoded)), { t: "evt", frame: { v: 1, id: 1, result: "ação🙂" } });
  assert.deepEqual(desktop.open(accepted.channel.seal({ t: "pong" })), { t: "pong" });
  assert.deepEqual(accepted.channel.open(desktop.sealEncoded(new TextEncoder().encode('{"t":"ping"}'))), { t: "ping" });
});

test("a hello may say what the device takes (caps): short strings only, eight at most, and none when it says nothing", () => {
  const { host, phone } = pair();
  const plain = hostAccept({ host, hello: phoneHello({ phone, host: host.publicKey, token, random }).message, isKnown: () => true, token, random });
  assert.deepEqual(plain.caps, []);
  const caps = ["batch", 7, "x".repeat(33), ...Array(10).fill("more")];
  const accepted = hostAccept({ host, hello: phoneHello({ phone, host: host.publicKey, token, random, caps }).message, isKnown: () => true, token, random });
  assert.deepEqual(accepted.caps, ["batch", ...Array(6).fill("more")]);
});
