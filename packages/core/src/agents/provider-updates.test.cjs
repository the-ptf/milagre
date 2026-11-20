const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderUpdates } = require("./provider-updates.cjs");

test("release cards compare installed versions numerically, skip missing providers, and share cached lookups", async () => {
  let requests = 0;
  let installed = "0.9.0";
  const read = createProviderUpdates({
    inspect: async (provider) => (provider === "codex" ? { command: "/bin/codex", version: installed } : { command: null }),
    fetchImpl: async () => {
      requests++;
      return { ok: true, json: async () => ({ version: "0.10.0" }) };
    },
  });
  const [first, second] = await Promise.all([read(), read()]);
  assert.deepEqual(first, [{ provider: "codex", installedVersion: "0.9.0", version: "0.10.0", channel: "other", command: "codex update" }]);
  assert.deepEqual(second, first);
  assert.equal(requests, 1);
  installed = "0.10.0";
  assert.deepEqual(await read(), []);
  installed = "0.11.0";
  assert.deepEqual(await read(), []);
});

test("offline and malformed release responses are advisory, then retry after a minute", async () => {
  let clock = 0;
  let requests = 0;
  const read = createProviderUpdates({
    now: () => clock,
    inspect: async (provider) => (provider === "claude" ? { command: "/bin/claude", version: "2.1.288" } : {}),
    fetchImpl: async () => {
      requests++;
      if (requests === 1) throw new Error("offline");
      return { ok: true, json: async () => ({ version: requests === 2 ? "3.0.0-beta" : "3.0.0" }) };
    },
  });
  assert.deepEqual(await read(), []);
  assert.deepEqual(await read(), []);
  assert.equal(requests, 1);
  clock += 60001;
  assert.deepEqual(await read(), []);
  clock += 60001;
  assert.equal((await read())[0].version, "3.0.0");
});

test("Antigravity advertises only Milagre's pinned release", async () => {
  const read = createProviderUpdates({
    inspect: async () => ({}),
    antigravity: {
      resolve: () => ({ version: "1.0.0" }),
      pinned: () => ({ version: "1.1.0" }),
      updateAvailable: () => true,
    },
  });
  assert.deepEqual(await read(), [{ provider: "antigravity", installedVersion: "1.0.0", version: "1.1.0", channel: "milagre", command: null }]);
});

test("a Homebrew install is offered Homebrew's release, so a version npm has first never shows", async () => {
  let brewVersion = "0.170.0";
  const asked = [];
  const read = createProviderUpdates({
    now: (() => {
      let clock = 0;
      return () => (clock += 31 * 60_000);
    })(),
    inspect: async (provider) => (provider === "codex" ? { command: "/opt/homebrew/bin/codex", version: "0.170.0" } : {}),
    channelOf: () => ({ kind: "homebrew-cask", token: "codex", brew: "/opt/homebrew/bin/brew" }),
    release: async (provider, channel) => {
      asked.push(channel.kind);
      return { version: brewVersion };
    },
  });
  assert.deepEqual(await read(), []);
  brewVersion = "0.171.0";
  assert.deepEqual(await read(), [
    { provider: "codex", installedVersion: "0.170.0", version: "0.171.0", channel: "homebrew-cask", command: "brew upgrade --cask codex" },
  ]);
  assert.deepEqual(asked, ["homebrew-cask", "homebrew-cask"]);
});
