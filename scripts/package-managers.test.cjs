const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const YAML = require("yaml");

const script = path.join(__dirname, "generate-package-managers.cjs");
// SHA-256 of "abc", independently known. Every fixture installer contains these bytes.
const hash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const names = [
  "Milagre-1.2.3-arm64.dmg",
  "Milagre-1.2.3-x64.dmg",
  "Milagre-Setup-1.2.3-x64.exe",
  "Milagre-1.2.3-x86_64.AppImage",
  "Milagre-1.2.3-amd64.deb",
  "Milagre-1.2.3-x86_64.rpm",
];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-packages-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifacts = path.join(root, "installers");
  const output = path.join(root, "manifests");
  fs.mkdirSync(artifacts);
  for (const name of names) fs.writeFileSync(path.join(artifacts, name), "abc");
  return {
    artifacts,
    output,
    run: (...args) =>
      spawnSync(process.execPath, [script, "--tag", "v1.2.3", "--platform", "all", "--artifacts", artifacts, "--output", output, ...args], {
        encoding: "utf8",
      }),
  };
}

test("generates architecture-specific Homebrew downloads with real installer checksums", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const cask = fs.readFileSync(path.join(f.output, "homebrew/milagre.rb"), "utf8");
  assert.match(cask, /cask "milagre"/);
  assert.match(cask, /version "1\.2\.3"/);
  assert.match(cask, /arch arm: "arm64", intel: "x64"/);
  assert.ok(cask.includes(`sha256 arm: "${hash}", intel: "${hash}"`));
  assert.ok(cask.includes("https://github.com/the-ptf/milagre/releases/download/v#{version}/Milagre-#{version}-#{arch}.dmg"));
  assert.match(cask, /app "Milagre\.app"/);
  assert.match(cask, /auto_updates true/);
  assert.doesNotMatch(cask, /no_check|zap/);
});

test("generates a WinGet manifest matching the per-user NSIS installer", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const manifest = YAML.parse(fs.readFileSync(path.join(f.output, "winget/Milagre.Milagre.yaml"), "utf8"));
  assert.equal(manifest.PackageVersion, "1.2.3");
  assert.equal(manifest.ManifestType, "singleton");
  assert.equal(manifest.PackageIdentifier, "Milagre.Milagre");
  assert.equal(manifest.License, "MIT");
  assert.equal(manifest.Installers.length, 1);
  assert.deepEqual(manifest.Installers[0], {
    Architecture: "x64",
    InstallerType: "nullsoft",
    Scope: "user",
    InstallerUrl: "https://github.com/the-ptf/milagre/releases/download/v1.2.3/Milagre-Setup-1.2.3-x64.exe",
    InstallerSha256: hash.toUpperCase(),
    InstallerSwitches: { Custom: "/currentuser" },
  });
});

test("can bootstrap Homebrew from the already-signed release with the legacy Intel filename", (t) => {
  const f = fixture(t);
  fs.renameSync(path.join(f.artifacts, names[1]), path.join(f.artifacts, "Milagre-1.2.3.dmg"));
  const result = f.run("--platform", "macos", "--mac-intel-name", "Milagre-1.2.3.dmg");
  assert.equal(result.status, 0, result.stderr);
  const cask = fs.readFileSync(path.join(f.output, "homebrew/milagre.rb"), "utf8");
  assert.match(cask, /arch arm: "-arm64", intel: ""/);
  assert.ok(cask.includes("Milagre-#{version}#{arch}.dmg"));
  assert.ok(fs.readFileSync(path.join(f.output, "SHA256SUMS"), "utf8").includes("  Milagre-1.2.3.dmg\n"));
  for (const name of ["../Milagre-1.2.3.dmg", "other.dmg", "Milagre-1.2.4.dmg"]) {
    assert.notEqual(f.run("--mac-intel-name", name).status, 0);
  }
});

test("checksum list covers every requested installer using its exact release filename", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const checksums = fs.readFileSync(path.join(f.output, "SHA256SUMS"), "utf8");
  assert.deepEqual(checksums.trim().split("\n").sort(), names.map((name) => `${hash}  ${name}`).sort());
});

test("platform selection generates only the requested manifests and checksums", (t) => {
  const f = fixture(t);
  for (const name of names.filter((name) => !name.endsWith(".dmg"))) fs.unlinkSync(path.join(f.artifacts, name));
  const result = f.run("--platform", "macos");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(f.output, "homebrew/milagre.rb")), true);
  assert.equal(fs.existsSync(path.join(f.output, "winget")), false);
  assert.equal(fs.readFileSync(path.join(f.output, "SHA256SUMS"), "utf8").trim().split("\n").length, 2);
});

test("missing, empty and non-file installers stop generation before writing output", (t) => {
  for (const state of ["missing", "empty", "directory", "symlink"]) {
    const f = fixture(t);
    const missing = path.join(f.artifacts, names[0]);
    fs.unlinkSync(missing);
    if (state === "empty") fs.writeFileSync(missing, "");
    if (state === "directory") fs.mkdirSync(missing);
    if (state === "symlink") fs.symlinkSync(path.join(f.artifacts, names[1]), missing);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(names[0]), result.stderr);
    assert.equal(fs.existsSync(f.output), false);
  }
});

test("invalid release tags and CLI options fail before producing manifests", (t) => {
  const f = fixture(t);
  for (const args of [
    ["--tag", "v1.2.3/evil"],
    ["--tag", "v01.2.3"],
    ["--tag", "v1.2.3-beta.1"],
    ["--platform", "android"],
    ["--unknown", "true"],
    ["--output"],
  ]) {
    const result = f.run(...args);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.equal(fs.existsSync(f.output), false);
  }
});

test("expected installer names match electron-builder target expansion", async () => {
  const { Packager } = require("app-builder-lib");
  const { AppInfo } = require("app-builder-lib/out/appInfo");
  const { MacPackager } = require("app-builder-lib/out/macPackager");
  const { WinPackager } = require("app-builder-lib/out/winPackager");
  const { LinuxPackager } = require("app-builder-lib/out/linuxPackager");
  const { Arch } = require("builder-util");
  const packager = new Packager({ projectDir: path.join(__dirname, ".."), config: { extraMetadata: { version: "1.2.3" } } });
  await packager.validateConfig();
  // validateConfig does not start packaging or construct AppInfo; no downloads/signing are needed here.
  // oxlint-disable-next-line no-underscore-dangle -- the test stubs electron-builder's private _appInfo field, which has no public setter
  packager._appInfo = new AppInfo(packager, null);
  const macos = new MacPackager(packager);
  const windows = new WinPackager(packager);
  const linux = new LinuxPackager(packager);
  const actual = [
    macos.expandArtifactNamePattern(packager.config.dmg, "dmg", Arch.arm64),
    macos.expandArtifactNamePattern(packager.config.dmg, "dmg", Arch.x64),
    windows.expandArtifactNamePattern(packager.config.nsis, "exe", Arch.x64),
    ...["AppImage", "deb", "rpm"].map((extension) => linux.expandArtifactNamePattern(packager.config[extension], extension, Arch.x64)),
  ];
  assert.deepEqual(actual, names);
});
