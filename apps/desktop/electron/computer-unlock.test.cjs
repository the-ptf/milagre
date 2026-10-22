const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createComputerUnlock } = require("./computer-unlock.cjs");
const { createComputerVault } = require("@milagre/daemon/computer-vault");
const { boxKeyPair, b64url } = require("@milagre/shared/relay-crypto");
const { randomBytes } = require("node:crypto");

test("desktop unlock migrates legacy pairings into the daemon vault without storing plaintext keys", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-unlock-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value).map((b) => b ^ 0x5a),
    decryptString: (value) =>
      Buffer.from(value)
        .map((b) => b ^ 0x5a)
        .toString("utf8"),
  };
  const pair = boxKeyPair((n) => new Uint8Array(randomBytes(n)));
  const legacy = { identity: { publicKey: b64url(pair.publicKey), secretKey: b64url(pair.secretKey) }, computers: {} };
  await fs.writeFile(
    path.join(dataDir, "computer-keys.json"),
    JSON.stringify({ v: 1, sealed: safeStorage.encryptString(JSON.stringify(legacy)).toString("base64") }),
    { mode: 0o600 },
  );
  const vault = createComputerVault({ dataDir });
  const invoke = async (method, args = []) => {
    if (method === "computers:vault-status") return vault.status();
    if (method === "computers:unlock") return vault.unlock(args[0].key);
    if (method === "computers:import-keys") return vault.importLegacy(args[0]);
    throw new Error(method);
  };
  const unlock = createComputerUnlock({ dataDir, safeStorage, invoke });
  await unlock.prepare();
  assert.deepEqual((await vault.identity()).secretKey, pair.secretKey);
  const encryptedMaster = await fs.readFile(path.join(dataDir, "computer-vault-key.json"), "utf8");
  assert.ok(!encryptedMaster.includes(b64url(pair.secretKey)));
  const again = createComputerVault({ dataDir });
  const next = createComputerUnlock({
    dataDir,
    safeStorage,
    invoke: async (method, args = []) =>
      method === "computers:vault-status" ? again.status() : method === "computers:unlock" ? again.unlock(args[0].key) : again.importLegacy(args[0]),
  });
  await next.prepare();
  assert.deepEqual((await again.identity()).publicKey, pair.publicKey);
});
