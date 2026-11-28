const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { createSecretsVault } = require("./secrets-vault.cjs");

const ORIGIN = "github.com/the-ptf/happiergym";

function fixture(t, { key = randomBytes(32), clock = { at: 1_000_000 } } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-secrets-vault-"));
  fs.chmodSync(dataDir, 0o700);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const holder = { key };
  const make = () => createSecretsVault({ dataDir, masterKey: async () => holder.key, computerId: () => "mac-1", now: () => clock.at });
  return { dataDir, holder, clock, vault: make(), make };
}

test("a saved secret is sealed on disk, listed without its value and read back by a new vault", async (t) => {
  const { dataDir, vault, make } = fixture(t);
  const saved = await vault.set({ name: "VERCEL_TOKEN", value: "vercel-live-token-7QK2", projects: [ORIGIN], note: "Deploys the site" });
  assert.equal(saved.hint, "7QK2");
  assert.equal(saved.version, 1);
  assert.equal("value" in saved, false);
  const raw = fs.readFileSync(path.join(dataDir, "secrets-vault.json"), "utf8");
  assert.equal(raw.includes("vercel-live-token"), false);
  assert.equal(fs.statSync(path.join(dataDir, "secrets-vault.json")).mode & 0o777, 0o600);
  const [listed] = await make().list();
  assert.equal(listed.name, "VERCEL_TOKEN");
  assert.equal(listed.note, "Deploys the site");
  assert.equal("value" in listed, false);
});

test("reserved and invalid names, oversized values and file secrets without a name are refused", async (t) => {
  const { vault } = fixture(t);
  await assert.rejects(vault.set({ name: "NODE_OPTIONS", value: "--require x", projects: "all" }), /reserved/);
  await assert.rejects(vault.set({ name: "lower", value: "x", projects: "all" }), /capital letters/);
  await assert.rejects(vault.set({ name: "BIG", value: "x".repeat(64 * 1024 + 1), projects: "all" }), /at most 64 KB/);
  await assert.rejects(vault.set({ name: "KEY", value: "x", kind: "file", projects: "all" }), /file name/);
  await assert.rejects(vault.set({ name: "KEY", value: "x", kind: "file", fileName: "../evil", projects: "all" }), /file name uses/);
  assert.deepEqual(await vault.list(), []);
});

test("locked: nothing is read or written, and redaction gets no values", async (t) => {
  const { vault, holder } = fixture(t, { key: null });
  await assert.rejects(vault.list(), (error) => error.code === "secrets-locked");
  await assert.rejects(vault.set({ name: "A_TOKEN", value: "value-123456", projects: "all" }), (error) => error.code === "secrets-locked");
  assert.deepEqual(await vault.values(), []);
  assert.deepEqual(await vault.reachable({ origin: ORIGIN }), { locked: true, secrets: [] });
  assert.deepEqual(await vault.status(), { unlocked: false });
  holder.key = randomBytes(32);
  assert.deepEqual(await vault.status(), { unlocked: true });
});

test("another key can't open the vault", async (t) => {
  const { vault, holder, make } = fixture(t);
  await vault.set({ name: "A_TOKEN", value: "value-123456", projects: "all" });
  holder.key = randomBytes(32);
  await assert.rejects(make().list(), (error) => error.code === "secrets-key");
});

test("delivery: named secrets in reach, refused whole when one is missing, logged with the command", async (t) => {
  const { vault, clock } = fixture(t);
  await vault.set({ name: "ASC_KEY_ID", value: "ABCDEF123456", projects: [ORIGIN] });
  await vault.set({ name: "ASC_KEY", value: "-----BEGIN-----\nabc\n-----END-----", kind: "file", fileName: "AuthKey.p8", projects: [ORIGIN] });
  await vault.set({ name: "OTHER_TOKEN", value: "other-123456", projects: ["github.com/a/b"] });
  const target = { origin: ORIGIN, unattended: false };
  const got = await vault.deliver({
    names: ["ASC_KEY_ID", "ASC_KEY"],
    target,
    chatId: "/p#1",
    command: "C:\\Program Files\\nodejs\\npx.cmd",
    delivery: "on-demand",
  });
  assert.deepEqual(
    got.map((secret) => [secret.name, secret.kind, secret.fileName]),
    [
      ["ASC_KEY_ID", "text", null],
      ["ASC_KEY", "file", "AuthKey.p8"],
    ],
  );
  await assert.rejects(vault.deliver({ names: ["ASC_KEY_ID", "OTHER_TOKEN"], target, chatId: "/p#1", delivery: "on-demand" }), (error) => {
    assert.equal(error.code, "secrets-missing");
    assert.deepEqual(error.missing, ["OTHER_TOKEN"]);
    return true;
  });
  const [entry] = await vault.log();
  assert.deepEqual(entry, {
    at: clock.at,
    names: ["ASC_KEY_ID", "ASC_KEY"],
    chatId: "/p#1",
    computer: "mac-1",
    command: "npx.cmd",
    delivery: "on-demand",
  });
  const listed = await vault.list();
  assert.equal(listed.find((secret) => secret.name === "ASC_KEY_ID").lastUsedAt, clock.at);
  assert.equal(listed.find((secret) => secret.name === "OTHER_TOKEN").lastUsedAt, null);
});

test("unattended runs get only secrets that allow them; ambient delivery picks ambient secrets in reach", async (t) => {
  const { vault } = fixture(t);
  await vault.set({ name: "NPM_TOKEN", value: "npm-123456789", projects: "all", delivery: "ambient" });
  await vault.set({ name: "DEPLOY_TOKEN", value: "deploy-123456", projects: "all", unattended: true });
  await vault.set({ name: "RELEASE_TOKEN", value: "release-123456", projects: "all" });
  const unattended = { origin: ORIGIN, unattended: true };
  await assert.rejects(vault.deliver({ names: ["RELEASE_TOKEN"], target: unattended, chatId: "c", delivery: "on-demand" }), /Unattended runs/);
  assert.equal((await vault.deliver({ names: ["DEPLOY_TOKEN"], target: unattended, chatId: "c", delivery: "on-demand" }))[0].value, "deploy-123456");
  assert.deepEqual(
    (await vault.reachable(unattended)).secrets.map((secret) => secret.name),
    ["DEPLOY_TOKEN"],
  );
  const ambient = await vault.deliver({ names: null, target: { origin: ORIGIN }, chatId: "c", delivery: "ambient" });
  assert.deepEqual(
    ambient.map((secret) => secret.name),
    ["NPM_TOKEN"],
  );
  assert.deepEqual(await vault.deliver({ names: null, target: unattended, chatId: "c", delivery: "ambient" }), []);
});

test("versions climb across replace and delete, and a removed secret leaves a tombstone", async (t) => {
  const { vault, make } = fixture(t);
  assert.equal((await vault.set({ name: "A_TOKEN", value: "first-123456", projects: "all" })).version, 1);
  assert.equal((await vault.set({ name: "A_TOKEN", value: "second-123456", projects: "all" })).version, 2);
  assert.deepEqual(await vault.remove("A_TOKEN"), { removed: true });
  assert.deepEqual(await vault.remove("A_TOKEN"), { removed: false });
  assert.equal((await make().set({ name: "A_TOKEN", value: "third-123456", projects: "all" })).version, 4);
});

test("values for redaction and change notices", async (t) => {
  const { vault } = fixture(t);
  let changes = 0;
  vault.onChange(() => changes++);
  await vault.set({ name: "A_TOKEN", value: "value-123456", projects: "all" });
  assert.deepEqual(await vault.values(), [{ name: "A_TOKEN", kind: "text", value: "value-123456" }]);
  await vault.remove("A_TOKEN");
  assert.equal(changes, 2);
});

test("the use log keeps 30 days", async (t) => {
  const { vault, clock, make } = fixture(t);
  await vault.set({ name: "A_TOKEN", value: "value-123456", projects: "all" });
  await vault.deliver({ names: ["A_TOKEN"], target: { origin: null }, chatId: "c", delivery: "on-demand" });
  clock.at += 31 * 24 * 60 * 60 * 1000;
  await vault.deliver({ names: ["A_TOKEN"], target: { origin: null }, chatId: "c", delivery: "on-demand" });
  assert.equal((await make().log("A_TOKEN")).length, 1);
});

test("update changes scope and opt-ins without the value, and bumps the version", async (t) => {
  const { vault } = fixture(t);
  await vault.set({ name: "A_TOKEN", value: "value-123456789", projects: "all" });
  const changed = await vault.update("A_TOKEN", { projects: [ORIGIN], askEachUse: true, note: "Deploys" });
  assert.deepEqual([changed.projects, changed.askEachUse, changed.note, changed.version, changed.hint], [[ORIGIN], true, "Deploys", 2, "6789"]);
  assert.equal((await vault.values())[0].value, "value-123456789");
  await assert.rejects(vault.update("MISSING", { note: "x" }), /No secret named MISSING/);
  await assert.rejects(vault.update("A_TOKEN", { value: "sneaky" }), /Unrecognized key/);
  await vault.set({ name: "KEY_FILE", value: "file-body-123456", kind: "file", fileName: "k.p8", projects: "all" });
  await assert.rejects(vault.update("KEY_FILE", { delivery: "ambient" }), /given per command/);
});

test("one read gives ambient values and their fingerprint; an older ambient file secret loads as per command", async (t) => {
  const { vault, make, dataDir } = fixture(t);
  await vault.set({ name: "NPM_TOKEN", value: "npm-value-123456", projects: "all", delivery: "ambient" });
  const first = await vault.ambient({ target: { origin: null }, chatId: "c", record: false });
  assert.deepEqual(first.secrets, [{ name: "NPM_TOKEN", value: "npm-value-123456" }]);
  assert.equal((await vault.ambient({ target: { origin: null, unattended: true }, chatId: "c", record: false })).secrets.length, 0);
  assert.notEqual((await vault.ambient({ target: { origin: null, unattended: true }, chatId: "c", record: false })).fingerprint, first.fingerprint);
  assert.equal(fs.existsSync(path.join(dataDir, "secrets-vault.json")), true);
  const reloaded = make();
  await vault.set({ name: "KEY_FILE", value: "file-body-123456", kind: "file", fileName: "k.p8", projects: "all" });
  assert.equal((await reloaded.list()).find((secret) => secret.name === "KEY_FILE").delivery, "on-demand");
});
