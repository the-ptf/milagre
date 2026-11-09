const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const YAML = require("yaml");
const script = path.join(__dirname, "finalize-update-feeds.cjs");
const names = ["Milagre-1.2.3-arm64.zip", "Milagre-1.2.3-x64.zip", "Milagre-1.2.3-arm64.dmg", "Milagre-1.2.3-x64.dmg"];
function fixture(t, { tag = "v1.2.3", feeds = ["latest-mac.yml"] } = {}) {
  const v = tag.slice(1);
  const files = [`Milagre-${v}-arm64.zip`, `Milagre-${v}-x64.zip`, `Milagre-${v}-arm64.dmg`, `Milagre-${v}-x64.dmg`];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-feeds-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of files) fs.writeFileSync(path.join(root, name), "abc");
  const feed = { version: v, files: files.map((url) => ({ url, sha512: "stale", size: 1 })), path: files[0], sha512: "stale" };
  for (const name of feeds) fs.writeFileSync(path.join(root, name), YAML.stringify(feed));
  const file = path.join(root, feeds[0]);
  return {
    root,
    feed,
    file,
    run: (...args) => spawnSync(process.execPath, [script, "--tag", tag, "--platform", "macos", "--artifacts", root, ...args], { encoding: "utf8" }),
  };
}
test("refreshes feed hashes from final signed bytes including legacy top-level fields", (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const result = YAML.parse(fs.readFileSync(f.file, "utf8"));
  const digest = createHash("sha512").update("abc").digest("base64");
  assert.equal(result.sha512, digest);
  assert.ok(result.files.every((file) => file.size === 3 && file.sha512 === digest));
  assert.equal(f.run("--check").status, 0);
  fs.writeFileSync(path.join(f.root, names[0]), "tampered");
  const check = f.run("--check");
  assert.notEqual(check.status, 0);
  assert.match(check.stderr, /checksum mismatch/);
});
test("rejects missing architecture, unexpected paths and wrong feed versions before writing", (t) => {
  const f = fixture(t);
  for (const change of [(feed) => feed.files.pop(), (feed) => (feed.files[0].url = "../outside.zip"), (feed) => (feed.version = "9.9.9")]) {
    const feed = structuredClone(f.feed);
    change(feed);
    const original = YAML.stringify(feed);
    fs.writeFileSync(f.file, original);
    assert.notEqual(f.run().status, 0);
    assert.equal(fs.readFileSync(f.file, "utf8"), original);
  }
});
test("rejects empty assets and symlinks", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, names[0]), "");
  assert.notEqual(f.run().status, 0);
  fs.unlinkSync(path.join(f.root, names[0]));
  fs.symlinkSync(path.join(f.root, names[1]), path.join(f.root, names[0]));
  assert.notEqual(f.run().status, 0);
});
test("a stable tag carrying a beta feed fails: beta installs would download the beta they already run", (t) => {
  const f = fixture(t, { feeds: ["latest-mac.yml", "beta-mac.yml"] });
  const result = f.run("--check");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not carry the beta feed: beta-mac\.yml/);
  assert.notEqual(f.run().status, 0);
});
test("a beta tag needs only the beta feed and refreshes it", (t) => {
  const f = fixture(t, { tag: "v1.2.3-beta.7", feeds: ["beta-mac.yml"] });
  assert.equal(f.run().status, 0);
  const digest = createHash("sha512").update("abc").digest("base64");
  assert.equal(YAML.parse(fs.readFileSync(f.file, "utf8")).sha512, digest);
  assert.equal(f.run("--check").status, 0);
});
test("a Linux beta tag needs only the Linux beta feed", (t) => {
  const f = fixture(t, { tag: "v1.2.3-beta.7", feeds: ["beta-mac.yml"] });
  const linux = ["Milagre-1.2.3-beta.7-x86_64.AppImage", "Milagre-1.2.3-beta.7-amd64.deb", "Milagre-1.2.3-beta.7-x86_64.rpm"];
  for (const name of linux) fs.writeFileSync(path.join(f.root, name), "abc");
  const digest = createHash("sha512").update("abc").digest("base64");
  const feed = { version: "1.2.3-beta.7", files: linux.map((url) => ({ url, sha512: digest, size: 3 })), path: linux[0], sha512: digest };
  assert.notEqual(f.run("--platform", "linux", "--check").status, 0, "no feed yet");
  fs.writeFileSync(path.join(f.root, "beta-linux.yml"), YAML.stringify(feed));
  assert.equal(f.run("--platform", "linux", "--check").status, 0);
});
test("a macos,linux platform list needs the Linux feed and its installers", (t) => {
  const f = fixture(t);
  const linux = ["Milagre-1.2.3-x86_64.AppImage", "Milagre-1.2.3-amd64.deb", "Milagre-1.2.3-x86_64.rpm"];
  const both = ["--platform", "macos,linux"];
  assert.notEqual(f.run(...both, "--check").status, 0, "no Linux feed");
  for (const name of linux) fs.writeFileSync(path.join(f.root, name), "abc");
  const feed = { version: "1.2.3", files: linux.map((url) => ({ url, sha512: "stale", size: 1 })), path: linux[0], sha512: "stale" };
  fs.writeFileSync(path.join(f.root, "latest-linux.yml"), YAML.stringify(feed));
  assert.equal(f.run(...both).status, 0);
  assert.equal(f.run(...both, "--check").status, 0);
  fs.unlinkSync(path.join(f.root, "latest-mac.yml"));
  assert.notEqual(f.run(...both, "--check").status, 0, "no macOS feed");
  assert.notEqual(f.run("--platform", "macos,macos").status, 0);
  assert.notEqual(f.run("--platform", "macos,bogus").status, 0);
});
