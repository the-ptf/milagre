const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } = require("node:crypto");
const nacl = require("tweetnacl");
const { z } = require("zod");
const { assertPrivate, windowsAcl } = require("@milagre/core/private-files");
const { writePrivate } = require("./relay-identity.cjs");
const { boxKeyPair, b64url, fromB64url } = require("@milagre/shared/relay-crypto");
const AAD = Buffer.from("milagre:computer-vault:v2");
const keyString = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const stateSchema = z.strictObject({
  identity: z.strictObject({ publicKey: keyString, secretKey: keyString }).nullable(),
  computers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.strictObject({ hostKey: keyString, token: z.string().regex(/^[A-Za-z0-9_-]{64}$/) })),
});
function validate(value) {
  const state = stateSchema.parse(value);
  if (Object.keys(state.computers).length > 1024) throw new Error("Too many saved computers");
  if (state.identity) {
    const pair = nacl.box.keyPair.fromSecretKey(fromB64url(state.identity.secretKey));
    if (b64url(pair.publicKey) !== state.identity.publicKey) throw new Error("Computer identity is damaged");
  } else if (Object.keys(state.computers).length) throw new Error("Saved computers have no identity");
  return state;
}
const keysError = (message) => Object.assign(new Error(message), { code: "keys" });
async function privateJson(file) {
  assertPrivate(file);
  if ((await fs.stat(file)).size > 1024 * 1024) throw keysError("Computer credential file exceeds its limit");
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function createComputerVault({ dataDir, keyFile = process.env.MILAGRE_COMPUTER_KEY_FILE }) {
  const file = path.join(dataDir, "computer-vault.json");
  const config = path.join(dataDir, "computer-vault-config.json");
  const legacy = path.join(dataDir, "computer-keys.json");
  let key;
  let state;
  let chain = Promise.resolve();
  const serial = (run) => {
    const work = chain.then(run);
    chain = work.catch(() => {});
    return work;
  };
  const exists = async (name) =>
    fs.stat(name).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
  async function configuredFile() {
    if (keyFile) return keyFile;
    try {
      return (await privateJson(config)).keyFile;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  function checkKeyPath(name) {
    if (typeof name !== "string" || !path.isAbsolute(name)) throw keysError("Computer key file must be an absolute path");
    const relative = path.relative(path.resolve(dataDir), path.resolve(name));
    if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
      throw keysError("Keep the computer key file outside the profile directory");
    assertPrivate(path.dirname(name));
  }
  async function loadKey() {
    if (key) return key;
    const name = await configuredFile();
    if (!name)
      throw keysError(
        'Unlock computer credentials from desktop, or run milagre computers setup-key --input \'{"file":"/absolute/private/key"}\' for unattended access.',
      );
    checkKeyPath(name);
    assertPrivate(name);
    if ((await fs.stat(name)).size !== 32) throw keysError("Computer key file must contain exactly 32 bytes");
    const candidate = await fs.readFile(name);
    if (await exists(file)) await decrypt(candidate);
    key = candidate;
    return key;
  }
  async function decrypt(master) {
    const saved = await privateJson(file);
    if (saved.v !== 2) throw keysError("Unsupported computer vault version");
    try {
      const decipher = createDecipheriv("aes-256-gcm", master, Buffer.from(saved.nonce, "base64"));
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(saved.tag, "base64"));
      return validate(JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.sealed, "base64")), decipher.final()]).toString("utf8")));
    } catch {
      throw keysError("Computer credentials cannot be decrypted with this key");
    }
  }
  async function read() {
    await loadKey();
    if (state) return state;
    if (await exists(file)) return (state = await decrypt(key));
    if (await exists(legacy)) throw keysError("Existing desktop pairings need migration. Open the updated desktop once to unlock and migrate them.");
    return (state = { identity: null, computers: {} });
  }
  async function persist(next) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", await loadKey(), nonce);
    cipher.setAAD(AAD);
    const sealed = Buffer.concat([cipher.update(JSON.stringify(next), "utf8"), cipher.final()]);
    await writePrivate(file, { v: 2, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), sealed: sealed.toString("base64") });
    state = next;
  }
  return {
    status: async () => ({
      unlocked: Boolean(key),
      configuredFile: Boolean(await configuredFile()),
      hasVault: await exists(file),
      needsLegacyImport: !(await exists(file)) && (await exists(legacy)),
    }),
    unlock: (encoded) =>
      serial(async () => {
        if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw keysError("Invalid computer vault key");
        const next = Buffer.from(encoded, "base64");
        if (key && !timingSafeEqual(key, next)) throw keysError("Computer vault is already unlocked with another key");
        const loaded = (await exists(file)) ? await decrypt(next) : null;
        key = next;
        state = loaded;
        return { unlocked: true };
      }),
    setupKey: (name) =>
      serial(async () => {
        if (typeof name !== "string" || !path.isAbsolute(name)) throw keysError("Computer key file must be an absolute path");
        const created = await fs.mkdir(path.dirname(name), { recursive: true, mode: 0o700 });
        if (created && process.platform === "win32") windowsAcl(path.dirname(name), { mode: "protect" });
        checkKeyPath(name);
        let provided;
        try {
          assertPrivate(name);
          if ((await fs.stat(name)).size !== 32) throw keysError("Computer key file must contain exactly 32 bytes");
          provided = await fs.readFile(name);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        let master;
        try {
          master = await loadKey();
        } catch (error) {
          if (provided) {
            if (await exists(file)) await decrypt(provided);
            master = provided;
          } else {
            if ((await exists(file)) || (await configuredFile())) throw error;
            master = randomBytes(32);
          }
        }
        if (provided) {
          if (!timingSafeEqual(master, provided)) throw keysError("This file holds a different computer key");
        } else {
          await fs.writeFile(name, master, { flag: "wx", mode: 0o600 });
          if (process.platform === "win32") windowsAcl(name, { mode: "protect" });
        }
        await writePrivate(config, { keyFile: name });
        keyFile = name;
        key = master;
        return { configured: true };
      }),
    importLegacy: (value) =>
      serial(async () => {
        if (await exists(file)) throw keysError("Computer vault already exists; existing pairings were not overwritten");
        await persist(validate(value));
        return { migrated: true };
      }),
    identity: () =>
      serial(async () => {
        const current = await read();
        if (!current.identity) {
          const pair = boxKeyPair((n) => new Uint8Array(randomBytes(n)));
          await persist({ ...current, identity: { publicKey: b64url(pair.publicKey), secretKey: b64url(pair.secretKey) } });
        }
        return { publicKey: fromB64url(state.identity.publicKey), secretKey: fromB64url(state.identity.secretKey) };
      }),
    secretsOf: (id) => serial(async () => structuredClone((await read()).computers[id] ?? null)),
    save: (id, secrets) =>
      serial(async () => {
        const current = await read();
        await persist(validate({ ...current, computers: { ...current.computers, [id]: secrets } }));
      }),
    forget: (id) =>
      serial(async () => {
        const current = await read();
        const computers = { ...current.computers };
        delete computers[id];
        await persist({ ...current, computers });
      }),
  };
}

module.exports = { createComputerVault };
