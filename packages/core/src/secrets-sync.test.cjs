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

/** A computer's link to others: each call reaches the other computer's sync with this computer's paired key, as the computer link does. */
function linkFrom(fromKey, peers) {
  const link = { up: true, calls: [], onlineListeners: [], hold: null };
  link.remote = {
    list: () => Object.entries(peers).map(([id, peer]) => ({ id, name: peer.name, online: link.up })),
    onOnline: (listener) => link.onlineListeners.push(listener),
    invoke: async (id, method, args) => {
      if (!link.up) throw new Error("offline");
      link.calls.push(method);
      if (method === "secrets:push" && link.hold) await link.hold();
      const sync = peers[id].sync();
      if (method === "secrets:digest") return sync.digest();
      if (method === "secrets:push") return sync.receive(args[0], fromKey);
      if (method === "secrets:forget-from") return sync.forgetFrom(args[0], fromKey);
      throw new Error(`unexpected ${method}`);
    },
  };
  return link;
}

function pair(t, { retryMs } = {}) {
  const clock = { at: 1_000 };
  const mac = computer(t, "mac", clock);
  const studio = computer(t, "studio", clock);
  let studioSync;
  const link = linkFrom("mac-key", { "studio-id": { name: "Studio", sync: () => studioSync } });
  const macSync = createSecretsSync({ vault: mac.vault, remote: link.remote, dataDir: mac.dataDir, retryMs });
  studioSync = createSecretsSync({ vault: studio.vault, remote: { list: () => [] }, dataDir: studio.dataDir });
  const goOnline = () => link.onlineListeners.forEach((listener) => listener("studio-id"));
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
  const stale = await studioSync.receive(
    {
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
    },
    "old-laptop-key",
  );
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
  const result = await studioSync.receive(
    {
      entries: [
        { name: "NODE_OPTIONS", secret: record },
        { name: "GOOD_TOKEN", secret: { ...record, extra: "field" } },
        { name: "HUGE_TOKEN", secret: { ...record, value: "x".repeat(64 * 1024 + 1) } },
        { name: "BAD_FILE", secret: { ...record, kind: "file", fileName: "../k.p8" } },
        { name: "FILE_KEY", secret: { ...record, kind: "file", fileName: "k.p8" } },
      ],
    },
    "evil-key",
  );
  assert.deepEqual(result.applied, ["FILE_KEY"]);
  assert.equal((await studio.vault.list())[0].delivery, "on-demand", "a file secret is never ambient, even if sent so");
  await assert.rejects(studioSync.receive({ entries: [] }), /Only a paired computer/);
  await assert.rejects(studioSync.forgetFrom({}), /Only a paired computer/);
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

test("a received secret is never passed on, so turning sharing off reaches every copy", async (t) => {
  const { mac, studio, macSync } = pair(t);
  const clock = { at: 1_000 };
  const laptop = computer(t, "laptop", clock);
  let laptopSync;
  const onward = linkFrom("studio-key", { "laptop-id": { name: "Laptop", sync: () => laptopSync } });
  const onwardDir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-sync-onward-"));
  t.after(() => fs.rmSync(onwardDir, { recursive: true, force: true }));
  const studioOnward = createSecretsSync({ vault: studio.vault, remote: onward.remote, dataDir: onwardDir });
  laptopSync = createSecretsSync({ vault: laptop.vault, remote: { list: () => [] }, dataDir: laptop.dataDir });
  await mac.vault.set({ name: "MAC_TOKEN", value: "mac-only-123456", projects: "all" });
  await studio.vault.set({ name: "STUDIO_TOKEN", value: "studio-own-123456", projects: "all" });
  await macSync.share({ computer: "studio-id", on: true });
  await studioOnward.share({ computer: "laptop-id", on: true });
  assert.deepEqual(Object.keys(await values(laptop.vault)), ["STUDIO_TOKEN"], "the mac's secret stays where the mac sent it");
  await macSync.share({ computer: "studio-id", on: false });
  assert.deepEqual(Object.keys(await values(studio.vault)), ["STUDIO_TOKEN"]);
});

test("a computer forgets only what the computer asking sent, by its paired key, whatever name it gives", async (t) => {
  const { mac, studio, macSync, studioSync } = pair(t);
  await mac.vault.set({ name: "A_TOKEN", value: "shared-123456", projects: "all" });
  await macSync.share({ computer: "studio-id", on: true });
  assert.deepEqual((await studioSync.forgetFrom({ from: "mac-key" }, "laptop-key")).removed, []);
  assert.deepEqual(Object.keys(await values(studio.vault)), ["A_TOKEN"]);
});

test("turning sharing off during a push stops it, then removes what it sent", async (t) => {
  const { mac, studio, macSync, link } = pair(t);
  for (let index = 0; index < 45; index++) await mac.vault.set({ name: `TOKEN_${index}`, value: `value-${index}-123456`, projects: "all" });
  let release;
  let held = 0;
  let pushing;
  const secondBatch = new Promise((resolve) => (pushing = resolve));
  link.hold = () => {
    if (++held !== 2) return undefined;
    pushing();
    return new Promise((resolve) => (release = resolve));
  };
  const sharing = macSync.share({ computer: "studio-id", on: true });
  await secondBatch;
  const off = macSync.share({ computer: "studio-id", on: false });
  release();
  await Promise.all([sharing, off]);
  assert.deepEqual(await values(studio.vault), {});
  assert.equal(link.calls.filter((call) => call === "secrets:push").length, 2, "no batch goes after sharing is off");
  assert.equal(macSync.sharing()[0].pendingRemoval, false);
});

test("a removal that fails is tried again on its own, and a delete reaches a computer that never had the secret", async (t) => {
  const { mac, studio, macSync, studioSync, link } = pair(t, { retryMs: 20 });
  await mac.vault.set({ name: "A_TOKEN", value: "shared-123456", projects: "all" });
  await macSync.share({ computer: "studio-id", on: true });
  link.hold = null;
  const failing = link.remote.invoke;
  let failures = 1;
  link.remote.invoke = async (id, method, args) => {
    if (method === "secrets:forget-from" && failures-- > 0) throw new Error("dropped");
    return failing(id, method, args);
  };
  await macSync.share({ computer: "studio-id", on: false });
  assert.equal(macSync.sharing()[0].pendingRemoval, true);
  for (const start = Date.now(); macSync.sharing()[0].pendingRemoval && Date.now() - start < 2000;) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(macSync.sharing()[0].pendingRemoval, false);
  assert.deepEqual(await values(studio.vault), {});
  await mac.vault.set({ name: "GONE_TOKEN", value: "gone-123456", projects: "all" });
  await mac.vault.remove("GONE_TOKEN");
  await macSync.share({ computer: "studio-id", on: true });
  assert.deepEqual(
    (await studioSync.digest()).filter((entry) => entry.name === "GONE_TOKEN"),
    [{ name: "GONE_TOKEN", version: 2, changedOn: "mac", deleted: true }],
    "the delete is known, so an older copy from anywhere is refused",
  );
});
