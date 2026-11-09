const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const bytes = Buffer.from("verified executable");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const artifact = { name: "cloudflared-linux-amd64", sha256, binarySha256: sha256 };
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-cloudflared-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { target: path.join(dir, "cloudflared"), artifact, download: async () => bytes };
}
test("installs a verified executable privately and reuses it offline", async (t) => {
  const { installCloudflared } = require("./cloudflared.cjs");
  const options = await fixture(t);
  await installCloudflared(options);
  assert.deepEqual(await fs.readFile(options.target), bytes);
  if (process.platform !== "win32") assert.equal((await fs.stat(options.target)).mode & 0o777, 0o700);
  await installCloudflared({
    ...options,
    download: async () => {
      throw Error("offline");
    },
  });
});
test("refuses a bad checksum, leaves no partial install and can retry", async (t) => {
  const { installCloudflared } = require("./cloudflared.cjs");
  const options = await fixture(t);
  await assert.rejects(installCloudflared({ ...options, download: async () => Buffer.from("corrupt") }), /checksum/);
  await assert.rejects(fs.access(options.target), { code: "ENOENT" });
  await installCloudflared(options);
  await fs.writeFile(options.target, "damaged cache");
  await installCloudflared(options);
  assert.deepEqual(await fs.readFile(options.target), bytes);
});
test("uses the bundled executable without a network or cache dependency", async (t) => {
  const { ensureCloudflared } = require("./cloudflared.cjs");
  const options = await fixture(t);
  await fs.writeFile(options.target, bytes, { mode: 0o700 });
  const resolved = await ensureCloudflared({
    bundledDir: path.dirname(options.target),
    platform: "linux",
    arch: "x64",
    artifact,
    cacheDir: "/must-not-write",
    download: async () => {
      throw Error("must not download");
    },
  });
  assert.equal(resolved, options.target);
});
test("packaging installs the target architecture in app resources", async (t) => {
  const pack = require("../../../scripts/package-cloudflared.cjs");
  const options = await fixture(t);
  const appOutDir = path.dirname(options.target);
  await pack(
    { appOutDir, electronPlatformName: "linux", arch: 1, packager: { appInfo: { productFilename: "Milagre" } } },
    { artifact, download: async () => bytes },
  );
  assert.deepEqual(await fs.readFile(path.join(appOutDir, "resources/bin/cloudflared")), bytes);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(path.join(appOutDir, "resources/bin/cloudflared"))).mode & 0o777, 0o755);
    assert.equal((await fs.stat(path.join(appOutDir, "resources/bin"))).mode & 0o777, 0o755);
  }
  assert.match(await fs.readFile(path.join(appOutDir, "resources/bin/cloudflared-LICENSE.txt"), "utf8"), /Apache License/);
});
test("concurrent starts share a download and clean temporary files", async (t) => {
  const { installCloudflared } = require("./cloudflared.cjs");
  const options = await fixture(t);
  let downloads = 0;
  const download = async () => {
    downloads++;
    return bytes;
  };
  await Promise.all([installCloudflared({ ...options, download }), installCloudflared({ ...options, download })]);
  assert.equal(downloads, 1);
  assert.deepEqual(await fs.readdir(path.dirname(options.target)), ["cloudflared"]);
});
test("packaging puts Windows and macOS executables in their resource directories", async (t) => {
  const pack = require("../../../scripts/package-cloudflared.cjs");
  const options = await fixture(t);
  const appOutDir = path.dirname(options.target);
  for (const [platform, relative] of [
    ["win32", "resources/bin/cloudflared.exe"],
    ["darwin", "Milagre.app/Contents/Resources/bin/cloudflared"],
  ]) {
    await pack(
      { appOutDir, electronPlatformName: platform, arch: 1, packager: { appInfo: { productFilename: "Milagre" } } },
      { artifact, download: async () => bytes },
    );
    assert.deepEqual(await fs.readFile(path.join(appOutDir, relative)), bytes);
  }
});
test("a tunnel starts with the bundled executable when PATH has no cloudflared", { skip: process.platform === "win32" }, async (t) => {
  const { startQuickTunnel } = require("./mobile-tunnel.cjs");
  const options = await fixture(t);
  await fs.writeFile(
    options.target,
    `#!${process.execPath}\nprocess.stderr.write('https://managed-test.trycloudflare.com\\nRegistered tunnel connection\\n'); setInterval(() => {}, 1000);`,
    { mode: 0o700 },
  );
  const old = process.env.MILAGRE_BUNDLED_BIN_DIR;
  process.env.MILAGRE_BUNDLED_BIN_DIR = path.dirname(options.target);
  t.after(() => {
    if (old === undefined) delete process.env.MILAGRE_BUNDLED_BIN_DIR;
    else process.env.MILAGRE_BUNDLED_BIN_DIR = old;
  });
  const tunnel = await startQuickTunnel({ port: 8787 });
  t.after(() => tunnel.close());
  assert.equal(tunnel.url, "https://managed-test.trycloudflare.com");
  await tunnel.close();
});
test("the packaged app bundles every font OFL license", async () => {
  const root = path.join(__dirname, "../../..");
  const build = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).build;
  const entry = build.extraResources.find((item) => item.from === "licenses" && item.to === "licenses");
  assert.ok(entry, "extraResources copies licenses/ to resources/licenses");
  for (const name of ["inter", "geist", "geist-mono", "jetbrains-mono"]) {
    const file = `${name}-OFL.txt`;
    assert.ok(
      entry.filter.some((glob) => path.matchesGlob(file, glob)),
      `${file} matches the filter`,
    );
    assert.match(await fs.readFile(path.join(root, "licenses", file), "utf8"), /SIL OPEN FONT LICENSE/i);
  }
});
