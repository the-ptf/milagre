import nacl from "tweetnacl";

/** Raised when a hello must not open a channel; `code` says why. */
export class RelayAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const HELLO = 0x01,
  ACCEPT = 0x02,
  DATA = 0x03;
const PHONE_TO_HOST = 0x01,
  HOST_TO_PHONE = 0x02;
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const KINDS = new Set(["phone", "desktop"]);
const MAX_NAME = 64;
// Control characters and bidirectional overrides: a name must not hide or reorder the text around it in a list.
const UNSAFE = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu;

/** A device's name from its hello: unsafe characters removed, trimmed, at most 64 characters; null when there is none. */
export function helloName(value) {
  if (typeof value !== "string") return null;
  const name = Array.from(value.replace(UNSAFE, "").trim()).slice(0, MAX_NAME).join("").trim();
  return name || null;
}

export function b64url(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out +=
      ALPHABET[(n >> 18) & 63] +
      ALPHABET[(n >> 12) & 63] +
      (i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : "") +
      (i + 2 < bytes.length ? ALPHABET[n & 63] : "");
  }
  return out;
}
export function fromB64url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("Not base64url");
  const bytes = [];
  let bits = 0,
    value = 0;
  for (const char of text) {
    value = (value << 6) | ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 255);
    }
  }
  return new Uint8Array(bytes);
}
const withRandom = (random) => nacl.setPRNG((out, n) => out.set(random(n)));
export function boxKeyPair(random) {
  withRandom(random);
  return nacl.box.keyPair();
}
export function signKeyPair(random) {
  withRandom(random);
  return nacl.sign.keyPair();
}
export const hostIdOf = (signPublicKey) => b64url(nacl.hash(signPublicKey).slice(0, 16));

const json = (value) => encoder.encode(JSON.stringify(value));
const parse = (bytes) => JSON.parse(decoder.decode(bytes));
// What a device says it takes (`caps` in its hello, e.g. "batch"): short names, a few at most; Macs from before ignore them.
const MAX_CAPS = 8;
const MAX_CAP = 32;
function sameToken(a, b) {
  if (typeof a !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function channel(key, sendDirection) {
  let sent = 0n,
    seen = 0n;
  const nonce = (direction, counter) => {
    const n = new Uint8Array(24);
    n[0] = direction;
    new DataView(n.buffer).setBigUint64(16, counter);
    return n;
  };
  const receiveDirection = sendDirection === PHONE_TO_HOST ? HOST_TO_PHONE : PHONE_TO_HOST;
  /** Seals `plain`, the UTF-8 bytes of one JSON message. */
  function sealEncoded(plain) {
    sent += 1n;
    const box = nacl.secretbox(plain, nonce(sendDirection, sent), key);
    const frame = new Uint8Array(9 + box.length);
    frame[0] = DATA;
    new DataView(frame.buffer).setBigUint64(1, sent);
    frame.set(box, 9);
    return frame;
  }
  return {
    seal: (value) => sealEncoded(json(value)),
    // A daemon frame is serialised once for every client; sealing its bytes saves a second JSON pass per desktop.
    sealEncoded,
    open(frame) {
      if (frame[0] !== DATA || frame.length < 9 + nacl.secretbox.overheadLength) throw new Error("Not a channel frame");
      const counter = new DataView(frame.buffer, frame.byteOffset).getBigUint64(1);
      if (counter !== seen + 1n) throw new Error("Out of order or replayed frame");
      const plain = nacl.secretbox.open(frame.subarray(9), nonce(receiveDirection, counter), key);
      if (!plain) throw new Error("Could not decrypt the frame");
      seen = counter;
      return parse(plain);
    },
  };
}

/**
 * `name` says what the device is called, `kind` what it is ("phone" when left out) and `caps` what it takes ("batch": a
 * window of messages as one frame); Macs from before ignore all three.
 */
export function phoneHello({ phone, host, token, random, name, kind, caps }) {
  withRandom(random);
  const ephemeral = nacl.box.keyPair();
  const nonce = random(24);
  const inner = { token, eph: b64url(ephemeral.publicKey) };
  if (typeof name === "string" && name) inner.name = name;
  if (kind) inner.kind = kind;
  if (Array.isArray(caps) && caps.length) inner.caps = caps.filter((cap) => typeof cap === "string").slice(0, MAX_CAPS);
  const box = nacl.box(json(inner), nonce, host, phone.secretKey);
  const message = new Uint8Array(1 + 32 + 32 + 24 + box.length);
  message[0] = HELLO;
  message.set(ephemeral.publicKey, 1);
  message.set(phone.publicKey, 33);
  message.set(nonce, 65);
  message.set(box, 89);
  return { message, ephemeral };
}

export function hostAccept({ host, hello, isKnown, canPair = false, token, random }) {
  if (!(hello instanceof Uint8Array) || hello[0] !== HELLO || hello.length < 89 + nacl.box.overheadLength) throw new RelayAuthError("bad-hello", "Not a hello");
  const eph = hello.slice(1, 33),
    phoneKey = hello.slice(33, 65),
    nonce = hello.slice(65, 89);
  const plain = nacl.box.open(hello.subarray(89), nonce, phoneKey, host.secretKey);
  if (!plain) throw new RelayAuthError("bad-hello", "The hello was not for this computer");
  let inner;
  try {
    inner = parse(plain);
  } catch {
    throw new RelayAuthError("bad-hello", "Unreadable hello");
  }
  if (!inner || typeof inner !== "object") throw new RelayAuthError("bad-hello", "Unreadable hello");
  if (inner.eph !== b64url(eph)) throw new RelayAuthError("bad-hello", "The hello was altered");
  if (!sameToken(inner.token, token)) throw new RelayAuthError("bad-token", "This phone was paired with an older code");
  if (inner.kind !== undefined && !KINDS.has(inner.kind)) throw new RelayAuthError("bad-hello", "Unknown kind of device");
  const id = b64url(phoneKey);
  const firstPairing = !isKnown(id);
  // A function decides per device: a device removed while the window was open stays out until it opens again.
  const pairable = typeof canPair === "function" ? canPair(id) : canPair;
  if (firstPairing && !pairable) throw new RelayAuthError("unknown-phone", "Pairing is closed on this computer");
  withRandom(random);
  const mine = nacl.box.keyPair();
  const replyNonce = random(24);
  const box = nacl.box(json({ eph: b64url(mine.publicKey), peer: b64url(eph) }), replyNonce, phoneKey, host.secretKey);
  const reply = new Uint8Array(1 + 32 + 24 + box.length);
  reply[0] = ACCEPT;
  reply.set(mine.publicKey, 1);
  reply.set(replyNonce, 33);
  reply.set(box, 57);
  return {
    reply,
    phoneKey: id,
    firstPairing,
    kind: inner.kind ?? "phone",
    name: helloName(inner.name),
    caps: Array.isArray(inner.caps) ? inner.caps.filter((cap) => typeof cap === "string" && cap.length <= MAX_CAP).slice(0, MAX_CAPS) : [],
    channel: channel(nacl.box.before(eph, mine.secretKey), HOST_TO_PHONE),
  };
}

export function phoneFinish({ ephemeral, phone, host, reply }) {
  if (reply[0] !== ACCEPT) throw new Error("Not an accept");
  const eph = reply.slice(1, 33),
    nonce = reply.slice(33, 57);
  const plain = nacl.box.open(reply.subarray(57), nonce, host, phone.secretKey);
  if (!plain) throw new Error("The reply is not from the paired computer");
  const inner = parse(plain);
  if (inner.eph !== b64url(eph) || inner.peer !== b64url(ephemeral.publicKey)) throw new Error("The reply was altered");
  return channel(nacl.box.before(eph, ephemeral.secretKey), PHONE_TO_HOST);
}
