const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { installChannel, caskUrl, channelRelease, updateCommand, watchBrewDownload } = require("./cli-channel.cjs");

const resolvingTo = (target) => ({ realpath: () => target, platform: "darwin", home: "/Users/me" });

test("the install channel comes from where the CLI's binary really lives", () => {
  assert.deepEqual(installChannel("codex", "/opt/homebrew/bin/codex", resolvingTo("/opt/homebrew/Caskroom/codex/0.170.0/bin/codex")), {
    kind: "homebrew-cask",
    token: "codex",
    brew: "/opt/homebrew/bin/brew",
  });
  assert.deepEqual(installChannel("codex", "/usr/local/bin/codex", resolvingTo("/usr/local/Cellar/codex/0.170.0/bin/codex")), {
    kind: "homebrew-formula",
    token: "codex",
    brew: "/usr/local/bin/brew",
  });
  assert.equal(installChannel("codex", "/x/bin/codex", resolvingTo("/x/lib/node_modules/@openai/codex/bin/codex.js")).kind, "npm");
  assert.equal(installChannel("claude", "/Users/me/.local/bin/claude", resolvingTo("/Users/me/.local/share/claude/versions/2.1.300")).kind, "installer");
  assert.equal(installChannel("codex", "/x/codex", resolvingTo("/x/codex")).kind, "other");
  assert.equal(
    installChannel("codex", "/Users/me/.local/share/mise/shims/codex", resolvingTo("/opt/homebrew/Cellar/mise/2026.11.14/bin/mise")).kind,
    "other",
    "a mise shim is mise's binary, so upgrading Homebrew's mise never updates Codex",
  );
  assert.equal(installChannel("codex", "C:\\codex.cmd", { platform: "win32" }).kind, "other");
  assert.equal(installChannel("codex", null).kind, "other");
});

test("each channel names the command a person would run", () => {
  assert.equal(updateCommand("codex", { kind: "homebrew-cask", token: "codex" }), "brew upgrade --cask codex");
  assert.equal(updateCommand("claude", { kind: "homebrew-formula", token: "claude-code" }), "brew upgrade claude-code");
  assert.equal(updateCommand("codex", { kind: "npm" }), "codex update");
  assert.equal(updateCommand("claude", { kind: "installer" }), "claude install latest");
});

test("a Homebrew install checks Homebrew's version, not npm's", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ version: "0.171.0,abc", url: "https://example.test/arm.tar.gz", variations: {} }) };
  };
  const release = await channelRelease("codex", { kind: "homebrew-cask", token: "codex" }, { fetchImpl, platform: "darwin", arch: "arm64" });
  assert.deepEqual(release, { version: "0.171.0", url: "https://example.test/arm.tar.gz" });
  assert.deepEqual(urls, ["https://formulae.brew.sh/api/cask/codex.json"]);
  const npm = await channelRelease("codex", { kind: "other" }, { fetchImpl: async (url) => ({ ok: true, json: async () => ({ version: url }) }) });
  assert.equal(npm.version, "https://registry.npmjs.org/@openai/codex/latest");
});

test("the cask download matches this computer's platform", () => {
  const cask = {
    url: "https://x/arm-mac",
    variations: { sonoma: { url: "https://x/intel-mac" }, arm64_linux: { url: "https://x/arm-linux" }, x86_64_linux: { url: "https://x/intel-linux" } },
  };
  assert.equal(caskUrl(cask, "darwin", "arm64"), "https://x/arm-mac");
  assert.equal(caskUrl(cask, "darwin", "x64"), "https://x/intel-mac");
  assert.equal(caskUrl(cask, "linux", "x64"), "https://x/intel-linux");
  assert.equal(caskUrl(cask, "linux", "arm64"), "https://x/arm-linux");
});

test("the Homebrew download reports its size as it grows, then install once Homebrew renames it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let files = {};
  const fsImpl = {
    readdirSync: () => Object.keys(files),
    statSync: (file) => ({ size: files[path.basename(file)], mtimeMs: 5000 }),
  };
  const events = [];
  const stop = watchBrewDownload({
    url: "https://example.test/download/codex.tar.gz",
    total: 1000,
    onProgress: (event) => events.push(event),
    cacheDir: "/cache",
    fsImpl,
    now: () => 5000,
  });
  t.mock.timers.tick(250);
  files = { "abc--codex.tar.gz.incomplete": 300, "old--other.tar.gz.incomplete": 999 };
  t.mock.timers.tick(250);
  files = { "abc--codex.tar.gz.incomplete": 1200 };
  t.mock.timers.tick(250);
  files = { "abc--codex.tar.gz": 1000 };
  t.mock.timers.tick(250);
  t.mock.timers.tick(250);
  stop();
  assert.deepEqual(events, [{ phase: "download", received: 300, total: 1000 }, { phase: "download", received: 1000, total: 1000 }, { phase: "install" }]);
});
