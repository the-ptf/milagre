const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { assertPrivate, windowsAcl } = require("@milagre/core/private-files");

/** Desktop supplies an OS-sealed master key over the private owner socket; only the daemon writes the vault. */
function createComputerUnlock({ dataDir, safeStorage, invoke }) {
  let preparing;
  async function prepare() {
    const status = await invoke("computers:vault-status");
    if (!status.configuredFile && !status.unlocked) {
      if (!safeStorage.isEncryptionAvailable() || (process.platform === "linux" && safeStorage.getSelectedStorageBackend?.() === "basic_text"))
        throw new Error("This computer cannot unlock its credential keychain. Configure a private key file for unattended access.");
      const file = path.join(dataDir, "computer-vault-key.json");
      let saved;
      try {
        assertPrivate(file);
        saved = JSON.parse(await fs.readFile(file, "utf8"));
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== "ENOENT") throw error;
        // Never replace a missing wrapper for an existing vault with a different key.
        if (status.hasVault) throw new Error("The desktop key for existing computer credentials is missing.");
        const encoded = randomBytes(32).toString("base64");
        const sealed = safeStorage.encryptString(encoded).toString("base64");
        try {
          await fs.writeFile(file, JSON.stringify({ v: 1, sealed }), { flag: "wx", mode: 0o600 });
          if (process.platform === "win32") windowsAcl(file, { mode: "protect" });
          saved = { v: 1, sealed };
        } catch (failure) {
          if (/** @type {any} */ (failure)?.code !== "EEXIST") throw failure;
          assertPrivate(file);
          saved = JSON.parse(await fs.readFile(file, "utf8"));
        }
      }
      if (saved.v !== 1 || typeof saved.sealed !== "string") throw new Error("The desktop computer key is damaged.");
      const key = safeStorage.decryptString(Buffer.from(saved.sealed, "base64"));
      await invoke("computers:unlock", [{ key }]);
    }
    if (status.needsLegacyImport) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Unlock the keychain to migrate existing computer pairings.");
      const legacy = path.join(dataDir, "computer-keys.json");
      assertPrivate(legacy);
      const saved = JSON.parse(await fs.readFile(legacy, "utf8"));
      const value = JSON.parse(safeStorage.decryptString(Buffer.from(saved.sealed, "base64")));
      try {
        await invoke("computers:import-keys", [value]);
      } catch (error) {
        if (!(await invoke("computers:vault-status")).hasVault) throw error;
      }
    }
  }
  return {
    prepare() {
      return (preparing ??= prepare().finally(() => {
        preparing = undefined;
      }));
    },
  };
}

module.exports = { createComputerUnlock };
