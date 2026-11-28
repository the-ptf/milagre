const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { createSecretsVault } = require("./secrets-vault.cjs");
const { createSecretsSync, newer } = require("./secrets-sync.cjs");

function computer(t, name, clock) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `milagre-sync-${name}-`));
  fs.chmodSync(dataDir, 0o700);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const key = randomBytes(32);
  const vault = createSecretsVault({ dataDir, masterKey: async () => key, computerId: () => name, now: () => clock.at });
  return { name, dataDir, vault };
}

function pair(t) {
  const clock = { at: 1_000 };
  const mac = computer(t, "mac", clock);
  const studio = computer(t, "studio", clock);
  const link = { up: true, calls: [] };
  const onlineListeners = [];
  let studioSync;
  const remote = {
    list: () => [{ id: "studio-id", name: "Studio", online: link.up }],
    onOnline: (listener) => onlineListeners.push(listener),
    invoke: async (id, method, args) => {
      if (!link.up) throw new Error("offline");
      link.calls.push(method);
      if (method === "secrets:digest") return studioSync.digest();
      if (method === "secrets:push") return studioSync.receive(args[0]);
      if (method === "secrets:forget-from") return studioSync.forgetFrom(args[0]);
      throw new Error(`unexpected ${method}`);
    },
  };
  const macSync = createSecretsSync({ vault: mac.vault, remote, dataDir: mac.dataDir, self: () => "mac" });
  studioSync = createSecretsSync({ vault: studio.vault, remote: { list: () => [] }, dataDir: studio.dataDir, self: () => "studio" });
  const goOnline = () => onlineListeners.forEach((listener) => listener("studio-id"));
  return { clock, mac, studio, macSync, studioSync, link, goOnline };
}

const values = async (vault) => Object.fromEntries((await vault.values()).map((secret) => [secret.name, secret.value]));

test("sharing sends secrets to the other computer, which never sends a value back", async (t) => {
  const { mac, studio, macSync, studioSync, link } = pair(t);
  await mac.vault.set({ name: "DEPLOY_TOKEN", value: "deploy-123456", projects: "all", note: "Vercel" });
  await macSync.share({ computer: "studio-id", on: true });
  assert.deepEqual(await values(studio.vault), { DEPLOY_TOKEN: "deploy-123456" });
  const [received] = await studio.vault.list();
  assert.equal(received.note, "Vercel");
  assert.equal(received.changedOn, "mac");
  assert.deepEqual(link.calls, ["secrets:digest", "secrets:push"]);
  const digest = await studioSync.digest();
  assert.deepEqual(digest, [{ name: "DEPLOY_TOKEN", version: 1, changedOn: "mac", deleted: false }]);
  assert.equal(JSON.stringify(digest).includes("deploy-123456"), false);
  link.calls.length = 0;
  await macSync.syncOne("studio-id");
  assert.deepEqual(link.calls, ["secrets:digest"], "nothing to send when the other computer is current");
});

test("the higher version wins, a tie goes to the higher computer name, and a stale computer can't undo a delete", async (t) => {
  const { mac, studio, macSync, studioSync } = pair(t);
  await mac.vault.set({ name: "A_TOKEN", value: "first-123456", projects: "all" });
  await macSync.share({ computer: "studio-id", on: true });
  await studio.vault.set({ name: "A_TOKEN", value: "studio-edit-123456", projects: "all" });
  await macSync.syncOne("studio-id");
  assert.equal((await values(studio.vault)).A_TOKEN, "studio-edit-123456", "the mac's older version doesn't overwrite");
  assert.equal(newer({ version: 3, changedOn: "a" }, { version: 3, changedOn: "b" }), false);
  assert.equal(newer({ version: 3, changedOn: "b" }, { version: 3, changedOn: "a" }), true);
  await mac.vault.set({ name: "A_TOKEN", value: "mac-again-123456", projects: "all" });
  await mac.vault.set({ name: "A_TOKEN", value: "mac-third-123456", projects: "all" });
  await macSync.syncOne("studio-id");
  assert.equal((await values(studio.vault)).A_TOKEN, "mac-third-123456");
  await mac.vault.remove("A_TOKEN");
  await macSync.syncOne("studio-id");
  assert.deepEqual(await values(studio.vault), {});
  const stale = await studioSync.receive({
    from: "old-laptop",
    entries: [
      {
        name: "A_TOKEN",
        secret: {
          kind: "text",
          value: "stale-123456",
          fileName: null,
          projects: "all",
          delivery: "on-demand",
          askEachUse: false,
          unattended: false,
          note: null,
          version: 2,
          changedOn: "zzz",
          updatedAt: 1,
        },
      },
    ],
  });
  assert.deepEqual(stale.applied, [], "an older version can't bring a deleted secret back");
});

test("a reserved or malformed entry from another computer is dropped, never stored", async (t) => {
  const { studio, studioSync } = pair(t);
  const record = {
    kind: "text",
    value: "x-123456789",
    fileName: null,
    projects: "all",
    delivery: "ambient",
    askEachUse: false,
    unattended: false,
    note: null,
    version: 9,
    changedOn: "evil",
    updatedAt: 1,
  };
  const result = await studioSync.receive({
    from: "evil",
    entries: [
      { name: "NODE_OPTIONS", secret: record },
      { name: "GOOD_TOKEN", secret: { ...record, extra: "field" } },
      { name: "FILE_KEY", secret: { ...record, kind: "file", fileName: "k.p8" } },
    ],
  });
  assert.deepEqual(result.applied, ["FILE_KEY"]);
  assert.equal((await studio.vault.list())[0].delivery, "on-demand", "a file secret is never ambient, even if sent so");
  await assert.rejects(studioSync.receive({ entries: [] }), /names the computer/);
});

test("turning sharing off removes what came from this computer, waiting while the other one is offline", async (t) => {
  const { mac, studio, macSync, link, goOnline } = pair(t);
  await mac.vault.set({ name: "A_TOKEN", value: "shared-123456", projects: "all" });
  await macSync.share({ computer: "studio-id", on: true });
  await studio.vault.set({ name: "OWN_TOKEN", value: "studio-own-123456", projects: "all" });
  link.up = false;
  const sharing = await macSync.share({ computer: "studio-id", on: false });
  assert.deepEqual(sharing, [{ id: "studio-id", name: "Studio", online: false, shared: false, pendingRemoval: true }]);
  assert.deepEqual(Object.keys(await values(studio.vault)).sort(), ["A_TOKEN", "OWN_TOKEN"]);
  link.up = true;
  goOnline();
  await macSync.syncOne("studio-id");
  assert.deepEqual(Object.keys(await values(studio.vault)), ["OWN_TOKEN"], "only what came from the mac goes");
  assert.equal(macSync.sharing()[0].pendingRemoval, false);
  await macSync.share({ computer: "studio-id", on: true });
  assert.equal((await values(studio.vault)).A_TOKEN, "shared-123456", "sharing again brings it back");
  await assert.rejects(macSync.share({ computer: "nobody", on: true }), /isn't paired/);
});
