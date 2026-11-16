const { preparePrivateDirectory, assertPrivate, windowsAcl } = require("@milagre/core/private-files");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { boxKeyPair, signKeyPair, hostIdOf, b64url, fromB64url } = require("@milagre/shared/relay-crypto");

const random = (n) => new Uint8Array(randomBytes(n));
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
 * @param {string} dataDir
 * @param {{ retireUntil?: number; drainUntil?: number; now?: number }} [options]
 */
async function rotateIdentity(dataDir, { retireUntil, drainUntil, now = Date.now() } = {}) {
  if (retireUntil || drainUntil) {
    let old;
    try {
      old = JSON.parse(await fs.readFile(identityFile(dataDir), "utf8")).sign;
    } catch {}
    if (old && retireUntil) {
      const kept = (await readRetiredRaw(dataDir)).filter((entry) => entry.until > now && entry.sign.publicKey !== old.publicKey);
      await writePrivate(retiredFile(dataDir), { retired: [...kept, { sign: old, until: retireUntil }].slice(-MAX_RETIRED) });
    }
    if (old && drainUntil) {
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
    } catch {}
  }
  return out;
}

async function readRetired(dataDir, now = Date.now()) {
  return decodeEntries(await readRetiredRaw(dataDir), now);
}

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
