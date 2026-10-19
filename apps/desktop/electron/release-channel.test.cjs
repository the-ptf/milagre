const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createReleaseChannelStore, configureUpdater, isChannelNotPublished, resolveBetaFeed, prepareUpdater } = require("./release-channel.cjs");

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-channel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "release-channel.json");
}

test("defaults to stable, persists beta, ignores garbage", (t) => {
  const file = tempFile(t);
  const store = createReleaseChannelStore({ file });
  assert.equal(store.get(), "stable");
  assert.equal(store.set("beta"), "beta");
  assert.equal(createReleaseChannelStore({ file }).get(), "beta");
  fs.writeFileSync(file, '{"channel":"nightly"}');
  assert.equal(createReleaseChannelStore({ file }).get(), "stable");
  assert.throws(() => store.set("nightly"), /Unknown release channel/);
});

function fakeUpdater() {
  const updater = { feeds: [] };
  updater.setFeedURL = (options) => updater.feeds.push(options);
  return updater;
}
const GITHUB_FEED = { provider: "github", owner: "the-ptf", repo: "milagre-ade", releaseType: "release" };

test("stable installs follow GitHub's latest release and never see prereleases or downgrade", () => {
  const updater = fakeUpdater();
  configureUpdater(updater, "stable");
  assert.deepEqual(updater.feeds, [GITHUB_FEED]);
  assert.equal(updater.channel, "latest");
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
});

test("beta installs read the feed of the release they were pointed at, and never downgrade", () => {
  const updater = fakeUpdater();
  configureUpdater(updater, "beta", "https://github.com/the-ptf/milagre-ade/releases/download/v0.104.1-beta.3");
  assert.deepEqual(updater.feeds, [{ provider: "generic", url: "https://github.com/the-ptf/milagre-ade/releases/download/v0.104.1-beta.3", channel: "beta" }]);
  assert.equal(updater.channel, "beta");
  assert.equal(updater.allowPrerelease, true);
  assert.equal(updater.allowDowngrade, false);
  // Without a resolved feed, beta falls back to GitHub's own lookup.
  configureUpdater(updater, "beta");
  assert.deepEqual(updater.feeds.at(-1), GITHUB_FEED);
  assert.equal(updater.channel, "beta");
});

const release = (tag, assets, extra = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: tag.includes("-"),
  assets: assets.map((name) => ({ name })),
  ...extra,
});
const answer =
  (body, status = 200) =>
  async (url, options) => {
    answer.calls.push({ url, options });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
answer.calls = [];

test("the beta feed is the newest published release that carries this platform's beta file, never an empty candidate", async () => {
  // Draft releases have no files; the atom feed lists the tags of the old per-merge draft candidates first.
  const releases = [
    release("v0.105.1", [], { draft: true }),
    release("v0.105.0", []),
    release("v0.104.1-beta.3", ["beta-mac.yml", "Milagre-0.104.1-beta.3-arm64.zip"]),
    release("v0.104.1", ["latest-mac.yml", "beta-mac.yml", "latest-linux.yml"]),
    release("v0.104.1-beta.10", ["beta-mac.yml"]),
    release("v0.103.0", ["beta-mac.yml"]),
  ];
  assert.equal(await resolveBetaFeed({ fetch: answer(releases), platform: "darwin" }), "https://github.com/the-ptf/milagre-ade/releases/download/v0.104.1");
  assert.match(answer.calls.at(-1).url, /^https:\/\/api\.github\.com\/repos\/the-ptf\/milagre-ade\/releases\?per_page=\d+$/);
  // Among betas of one version, the higher build number wins, compared as a number.
  assert.equal(
    await resolveBetaFeed({ fetch: answer(releases.filter((item) => item.tag_name !== "v0.104.1")), platform: "darwin" }),
    "https://github.com/the-ptf/milagre-ade/releases/download/v0.104.1-beta.10",
  );
  // Linux reads beta-linux.yml, which only stable releases carry today.
  assert.equal(await resolveBetaFeed({ fetch: answer([release("v0.104.1-beta.3", ["beta-mac.yml"])]), platform: "linux" }), null);
});

test("a GitHub API failure is an error the caller can fall back from", async () => {
  await assert.rejects(resolveBetaFeed({ fetch: answer({ message: "rate limited" }, 403), platform: "darwin" }), /403/);
});

test("prepareUpdater resolves the beta feed, and falls back to GitHub's lookup when that fails", async () => {
  const updater = fakeUpdater();
  await prepareUpdater(updater, "beta", { fetch: answer([release("v0.104.1", ["beta-mac.yml"])]), platform: "darwin" });
  assert.equal(updater.feeds.at(-1).url, "https://github.com/the-ptf/milagre-ade/releases/download/v0.104.1");
  await prepareUpdater(updater, "beta", {
    fetch: async () => {
      throw new Error("offline");
    },
    platform: "darwin",
  });
  assert.deepEqual(updater.feeds.at(-1), GITHUB_FEED);
  let asked = false;
  await prepareUpdater(updater, "stable", {
    fetch: async () => {
      asked = true;
    },
    platform: "darwin",
  });
  assert.equal(asked, false, "stable never asks the API");
  assert.deepEqual(updater.feeds.at(-1), GITHUB_FEED);
});

test("a stable release without a beta feed is not an error for beta installs", () => {
  assert.equal(isChannelNotPublished(Object.assign(new Error("x"), { code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" })), true);
  assert.equal(isChannelNotPublished(new Error("network")), false);
});
