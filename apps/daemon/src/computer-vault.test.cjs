const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { boxKeyPair, b64url } = require("@milagre/shared/relay-crypto");
const { createComputerVault } = require("./computer-vault.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-vault-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "profile");
  await fs.mkdir(dataDir, { mode: 0o700 });
  return { root, dataDir };
}

test("headless vault requires explicit key setup, encrypts credentials and reopens unattended", async (t) => {
  const { root, dataDir } = await fixture(t);
  const vault = createComputerVault({ dataDir });
  await assert.rejects(vault.identity(), /key|unlock/i);
  await vault.setupKey(path.join(root, "key"));
  const identity = await vault.identity();
  await vault.save("studio", { hostKey: "h".repeat(43), token: "t".repeat(64) });
  const disk = await fs.readFile(path.join(dataDir, "computer-vault.json"), "utf8");
  assert.ok(!disk.includes("t".repeat(64)));
  const reopened = createComputerVault({ dataDir });
  assert.deepEqual(await reopened.identity(), identity);
  assert.deepEqual(await reopened.secretsOf("studio"), { hostKey: "h".repeat(43), token: "t".repeat(64) });
  await reopened.forget("studio");
  assert.equal(await createComputerVault({ dataDir }).secretsOf("studio"), null);
});

test("migration preserves identities and refuses wrong keys or overwriting an existing vault", async (t) => {
  const { dataDir } = await fixture(t);
  await fs.writeFile(path.join(dataDir, "computer-keys.json"), '{"v":1,"sealed":"legacy"}', { mode: 0o600 });
  const vault = createComputerVault({ dataDir });
  const key = randomBytes(32).toString("base64");
  await vault.unlock(key);
  await assert.rejects(vault.identity(), /migrat/i);
  const pair = boxKeyPair((n) => new Uint8Array(randomBytes(n)));
  const legacy = {
    identity: { publicKey: b64url(pair.publicKey), secretKey: b64url(pair.secretKey) },
    computers: { studio: { hostKey: "h".repeat(43), token: "t".repeat(64) } },
  };
  await vault.importLegacy(legacy);
  assert.deepEqual((await vault.identity()).publicKey, pair.publicKey);
  await assert.rejects(vault.importLegacy(legacy), /already/i);
  await assert.rejects(createComputerVault({ dataDir }).unlock(randomBytes(32).toString("base64")), /key|decrypt/i);
  assert.equal(await fs.readFile(path.join(dataDir, "computer-keys.json"), "utf8"), '{"v":1,"sealed":"legacy"}');
});

test("vault setup refuses insecure paths and missing keys never replace saved credentials", async (t) => {
  const { root, dataDir } = await fixture(t);
  const vault = createComputerVault({ dataDir });
  await assert.rejects(vault.setupKey(path.join(dataDir, "master.key")), /outside/);
  const file = path.join(root, "master.key");
  await vault.setupKey(file);
  const identity = await vault.identity();
  if (process.platform !== "win32") {
    await fs.chmod(file, 0o644);
    await assert.rejects(createComputerVault({ dataDir }).identity(), /0600/);
    await fs.chmod(file, 0o600);
  }
  const backup = path.join(root, "backup.key");
  await fs.writeFile(backup, await fs.readFile(file), { mode: 0o600 });
  await fs.unlink(file);
  await assert.rejects(createComputerVault({ dataDir }).identity(), /ENOENT/);
  await assert.rejects(createComputerVault({ dataDir }).setupKey(file), /ENOENT/);
  const recovered = createComputerVault({ dataDir });
  await recovered.setupKey(backup);
  assert.deepEqual(await recovered.identity(), identity);
  assert.deepEqual(await vault.identity(), identity);
});
