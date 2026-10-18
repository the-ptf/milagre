const { preparePrivateDirectory, assertPrivate, windowsAcl } = require("@milagre/core/private-files");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { boxKeyPair, signKeyPair, hostIdOf, b64url, fromB64url } = require("@milagre/shared/relay-crypto");

const random = (n) => new Uint8Array(randomBytes(n));
// Each retired identity holds one more relay socket while the phone is on, so only the last few are kept.
const MAX_RETIRED = 3;

async function writePrivate(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (process.platform === "win32") preparePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
    if (process.platform === "win32") windowsAcl(temporary, { mode: "protect" });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

const identityFile = (dataDir) => path.join(dataDir, "relay-identity.json");

/** The Mac's relay identity: a signing key the relay checks, and a box key the phone pins from the QR. */
async function readIdentity(dataDir) {
  try {
    assertPrivate(identityFile(dataDir));
    const value = JSON.parse(await fs.readFile(identityFile(dataDir), "utf8"));
    const sign = decode(value.sign),
      box = decode(value.box);
    return { hostId: hostIdOf(sign.publicKey), sign, box };
  } catch (error) {
    if (/** @type {any} */ (error).code !== "ENOENT") throw error;
  }
  return rotateIdentity(dataDir);
}

const encode = (pair) => ({ publicKey: b64url(pair.publicKey), secretKey: b64url(pair.secretKey) });
const decode = (pair) => ({ publicKey: fromB64url(pair.publicKey), secretKey: fromB64url(pair.secretKey) });

/**
 * New sign and box key pairs, replacing any saved ones. Reset calls it, so a host id that leaked with an old link
 * no longer names this Mac on the relay. `retireUntil` (ms epoch) keeps the old signing key until then, so the old
 * room can still tell the phones that dial it that this Mac was reset (see readRetired). `drainUntil` keeps it until
 * then to take the webhook deliveries its room still holds (see readDraining).
 * @param {string} dataDir
 * @param {{ retireUntil?: number; drainUntil?: number; now?: number }} [options]
 */
async function rotateIdentity(dataDir, { retireUntil, drainUntil, now = Date.now() } = {}) {
  if (retireUntil || drainUntil) {
    let old;
    try {
      old = JSON.parse(await fs.readFile(identityFile(dataDir), "utf8")).sign;
    } catch {
      /* nothing saved, or unreadable: nothing to retire */
    }
    if (old && retireUntil) {
      const kept = (await readRetiredRaw(dataDir)).filter((entry) => entry.until > now && entry.sign.publicKey !== old.publicKey);
      await writePrivate(retiredFile(dataDir), { retired: [...kept, { sign: old, until: retireUntil }].slice(-MAX_RETIRED) });
    }
    if (old && drainUntil) {
      // No cap: an identity still draining may have deliveries the relay accepted waiting in its room, so only those past
      // their limit (a day or so, see phone.cjs DRAIN_MS) go. That limit is what bounds the list.
      const kept = (await readKeysRaw(drainingFile(dataDir), "draining")).filter((entry) => entry.until > now && entry.sign.publicKey !== old.publicKey);
      await writePrivate(drainingFile(dataDir), { draining: [...kept, { sign: old, until: drainUntil }] });
    }
  }
  const sign = signKeyPair(random),
    box = boxKeyPair(random);
  await writePrivate(identityFile(dataDir), { sign: encode(sign), box: encode(box) });
  return { hostId: hostIdOf(sign.publicKey), sign, box };
}

const retiredFile = (dataDir) => path.join(dataDir, "relay-retired.json");
const drainingFile = (dataDir) => path.join(dataDir, "relay-draining.json");
async function readKeysRaw(file, field) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"))[field];
    return Array.isArray(value)
      ? value.filter((entry) => typeof entry?.sign?.publicKey === "string" && typeof entry.sign.secretKey === "string" && Number.isFinite(entry.until))
      : [];
  } catch {
    return [];
  }
}
const readRetiredRaw = (dataDir) => readKeysRaw(retiredFile(dataDir), "retired");
function decodeEntries(entries, now) {
  const out = [];
  for (const entry of entries) {
    if (entry.until <= now) continue;
    try {
      const sign = decode(entry.sign);
      out.push({ hostId: hostIdOf(sign.publicKey), sign, until: entry.until });
    } catch {
      /* a damaged entry is skipped */
    }
  }
  return out;
}

/**
 * Identities that Reset replaced and that still answer their old room until `until`: phones paired with them hear
 * "this Mac was reset" there instead of finding nobody. Only the signing key is kept; the room needs nothing else.
 */
async function readRetired(dataDir, now = Date.now()) {
  return decodeEntries(await readRetiredRaw(dataDir), now);
}

/**
 * Identities a Reset replaced whose rooms may still hold webhook deliveries the relay accepted: the Mac connects to each
 * until it has taken them all (then dropDraining) or `until` passes (the relay's own retention is shorter).
 */
async function readDraining(dataDir, now = Date.now()) {
  return decodeEntries(await readKeysRaw(drainingFile(dataDir), "draining"), now);
}
async function dropDraining(dataDir, hostId) {
  const entries = await readKeysRaw(drainingFile(dataDir), "draining");
  const kept = entries.filter((entry) => {
    try {
      return hostIdOf(fromB64url(entry.sign.publicKey)) !== hostId;
    } catch {
      return false;
    }
  });
  if (kept.length !== entries.length) await writePrivate(drainingFile(dataDir), { draining: kept });
}

module.exports = { readIdentity, rotateIdentity, readRetired, readDraining, dropDraining, writePrivate };
