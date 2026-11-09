const fs = require("node:fs/promises");
const { b64url, boxKeyPair, fromB64url } = require("@milagre/shared/relay-crypto");
const { writePrivate } = require("./relay-identity.cjs");
const { ThisComputer } = require("@milagre/shared/host-computer");

const NO_KEYCHAIN = `${ThisComputer} can't keep keys in its keychain, so it can't pair with computers.`;
const UNREADABLE = `${ThisComputer}'s keys for its computers can't be read. Remove them and pair again.`;

/** A keychain failure, tagged so the peer channel's caller can report it as a `keys` error. */
const keysError = (message) => Object.assign(new Error(message), { code: "keys" });

/**
 * This Mac's own key pair (the "phone" key of every computer's hello) and, per computer, the Mac's pinned box key and
 * pairing token (every hello carries it), sealed with Electron's safeStorage, whose key lives in the login keychain, in
 * `<userData>/computer-keys.json` as `{ v: 1, sealed: base64 }`. Read once, kept in memory; each change rewrites it.
 * A missing keychain or a file this keychain can't open throws an Error with `code: "keys"`.
 */
function createComputerKeys({ file, safeStorage, random }) {
  let loaded = null;
  let making = null;
  let writes = Promise.resolve();
  async function read() {
    if (!safeStorage.isEncryptionAvailable()) throw keysError(NO_KEYCHAIN);
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "ENOENT") return { identity: null, computers: {} };
      throw keysError(UNREADABLE);
    }
    try {
      const plain = JSON.parse(safeStorage.decryptString(Buffer.from(JSON.parse(text).sealed, "base64")));
      return { identity: plain?.identity ?? null, computers: plain?.computers && typeof plain.computers === "object" ? plain.computers : {} };
    } catch {
      throw keysError(UNREADABLE);
    }
  }
  const state = () =>
    (loaded ??= read().catch((error) => {
      loaded = null;
      throw error;
    }));
  function persist(value) {
    let sealed;
    try {
      sealed = safeStorage.encryptString(JSON.stringify(value)).toString("base64");
    } catch {
      return Promise.reject(keysError(NO_KEYCHAIN));
    }
    const next = writes.then(() => writePrivate(file, { v: 1, sealed }));
    writes = next.catch(() => {});
    return next;
  }
  return {
    /** This Mac's box key pair, made the first time a computer needs it. */
    identity() {
      making ??= (async () => {
        const value = await state();
        if (!value.identity) {
          const pair = boxKeyPair(random);
          value.identity = { publicKey: b64url(pair.publicKey), secretKey: b64url(pair.secretKey) };
          try {
            await persist(value);
          } catch (error) {
            value.identity = null;
            throw error;
          }
        }
        return { publicKey: fromB64url(value.identity.publicKey), secretKey: fromB64url(value.identity.secretKey) };
      })().catch((error) => {
        making = null;
        throw error;
      });
      return making;
    },
    async secretsOf(id) {
      const found = (await state()).computers[id];
      return found && typeof found.hostKey === "string" && typeof found.token === "string" ? { hostKey: found.hostKey, token: found.token } : null;
    },
    async save(id, { hostKey, token }) {
      const value = await state();
      const before = value.computers[id];
      value.computers[id] = { hostKey, token };
      try {
        await persist(value);
      } catch (error) {
        // What is kept in memory must be what is sealed on disk.
        if (before === undefined) delete value.computers[id];
        else value.computers[id] = before;
        throw error;
      }
    },
    async forget(id) {
      const value = await state();
      if (!(id in value.computers)) return;
      const before = value.computers[id];
      delete value.computers[id];
      try {
        await persist(value);
      } catch (error) {
        value.computers[id] = before;
        throw error;
      }
    },
  };
}

module.exports = { createComputerKeys };
