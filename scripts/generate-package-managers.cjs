// Generate package-manager metadata from the final installer bytes, after signing/notarization.
// This script never uploads installers, changes a tap, or submits a WinGet package.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const YAML = require("yaml");

const { url: repository } = require("@milagre/shared/repository");
const description = "A local-first desktop ADE for coordinating coding agents";

async function main() {
  const options = { artifacts: "release", output: "release/package-managers" };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!["--tag", "--platform", "--artifacts", "--output", "--mac-intel-name"].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    options[flag.slice(2)] = value;
  }
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(options.tag ?? "")) {
    throw new Error("Pass --tag vX.Y.Z for a stable release");
  }
  const platforms = options.platform === "all" ? ["macos", "windows", "linux"] : (options.platform ?? "").split(",");
  if (!platforms.every((name) => ["macos", "windows", "linux"].includes(name)) || new Set(platforms).size !== platforms.length) {
    throw new Error("Pass --platform macos, windows, linux, a comma list such as macos,linux, or all");
  }
  const version = options.tag.slice(1);
  const legacyIntel = options["mac-intel-name"] === `Milagre-${version}.dmg`;
  if (options["mac-intel-name"] && !legacyIntel && options["mac-intel-name"] !== `Milagre-${version}-x64.dmg`) {
    throw new Error("The Intel DMG filename must match this release version");
  }
  const artifacts = {
    macos: [`Milagre-${version}-arm64.dmg`, options["mac-intel-name"] ?? `Milagre-${version}-x64.dmg`],
    windows: [`Milagre-Setup-${version}-x64.exe`],
    linux: [`Milagre-${version}-x86_64.AppImage`, `Milagre-${version}-amd64.deb`, `Milagre-${version}-x86_64.rpm`],
  };
  const hashes = new Map();
  // Validate everything before creating output. Never substitute an unchecked hash or a missing architecture.
  for (const platform of platforms) {
    for (const name of artifacts[platform]) {
      const file = path.resolve(options.artifacts, name);
      let stat;
      try {
        stat = fs.lstatSync(file);
      } catch {
        throw new Error(`Missing installer: ${name}`);
      }
      if (!stat.isFile() || !stat.size) throw new Error(`Installer must be a non-empty regular file: ${name}`);
      const hash = createHash("sha256");
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
      hashes.set(name, hash.digest("hex"));
    }
  }
  const files = new Map();
  const releaseURL = `${repository}/releases/download/${options.tag}`;
  if (platforms.includes("macos")) {
    files.set(
      "homebrew/milagre.rb",
      `cask "milagre" do
  arch arm: "${legacyIntel ? "-arm64" : "arm64"}", intel: "${legacyIntel ? "" : "x64"}"

  version "${version}"
  sha256 arm: "${hashes.get(artifacts.macos[0])}", intel: "${hashes.get(artifacts.macos[1])}"

  url "${repository}/releases/download/v#{version}/Milagre-#{version}${legacyIntel ? "" : "-"}#{arch}.dmg"
  name "Milagre"
  desc "${description}"
  homepage "${repository}"

  auto_updates true

  app "Milagre.app"
end
`,
    );
  }
  if (platforms.includes("windows")) {
    files.set(
      "winget/Milagre.Milagre.yaml",
      YAML.stringify({
        PackageIdentifier: "Milagre.Milagre",
        PackageVersion: version,
        PackageLocale: "en-US",
        Publisher: "Milagre contributors",
        PackageName: "Milagre",
        PackageUrl: repository,
        License: "MIT",
        LicenseUrl: `${repository}/blob/main/LICENSE`,
        ShortDescription: description,
        Installers: [
          {
            Architecture: "x64",
            InstallerType: "nullsoft",
            Scope: "user",
            InstallerUrl: `${releaseURL}/${artifacts.windows[0]}`,
            InstallerSha256: hashes.get(artifacts.windows[0]).toUpperCase(),
            InstallerSwitches: { Custom: "/currentuser" },
          },
        ],
        ManifestType: "singleton",
        ManifestVersion: "1.12.0",
      }),
    );
  }
  files.set("SHA256SUMS", [...hashes].map(([name, hash]) => `${hash}  ${name}\n`).join(""));
  for (const [name, contents] of files) {
    const destination = path.resolve(options.output, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  }
  console.log(`Generated ${platforms.join(", ")} package metadata in ${path.resolve(options.output)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
