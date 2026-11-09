// Signing/stapling can change installers after electron-builder writes its feeds.
// Refresh hashes only after signing, or verify the complete staged release with --check.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const YAML = require("yaml");
async function main() {
  const options = { artifacts: "release", platform: "all" };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check") {
      options.check = true;
      continue;
    }
    if (!["--tag", "--platform", "--artifacts"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--"))
      throw new Error(`Invalid option: ${args[i]}`);
    options[args[i].slice(2)] = args[++i];
  }
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.test(options.tag ?? "")) throw new Error("Expected --tag vX.Y.Z or vX.Y.Z-beta.N");
  const selected = options.platform === "all" ? ["macos", "windows", "linux"] : options.platform.split(",");
  if (!selected.length || new Set(selected).size !== selected.length || !selected.every((name) => ["macos", "windows", "linux"].includes(name)))
    throw new Error("Invalid platform");
  const v = options.tag.slice(1);
  const beta = v.includes("-beta.");
  const feeds = {
    macos: [[beta ? "beta-mac.yml" : "latest-mac.yml"], [`Milagre-${v}-arm64.zip`, `Milagre-${v}-x64.zip`, `Milagre-${v}-arm64.dmg`, `Milagre-${v}-x64.dmg`]],
    windows: [[beta ? "beta.yml" : "latest.yml"], [`Milagre-Setup-${v}-x64.exe`]],
    linux: [[beta ? "beta-linux.yml" : "latest-linux.yml"], [`Milagre-${v}-x86_64.AppImage`, `Milagre-${v}-amd64.deb`, `Milagre-${v}-x86_64.rpm`]],
  };
  // A stable rebuilds the newest beta's commit, which beta installs already run: a beta feed on it would offer them a
  // second download of the same code.
  const betaFeeds = { macos: "beta-mac.yml", windows: "beta.yml", linux: "beta-linux.yml" };
  for (const platform of selected)
    if (!beta && fs.existsSync(path.resolve(options.artifacts, betaFeeds[platform])))
      throw new Error(`A stable release must not carry the beta feed: ${betaFeeds[platform]}`);
  const changes = [];
  for (const platform of selected) {
    const [names, expected] = feeds[platform];
    for (const name of names) {
      const file = path.resolve(options.artifacts, name);
      if (!fs.lstatSync(file).isFile()) throw new Error(`Feed must be a regular file: ${name}`);
      const feed = YAML.parse(fs.readFileSync(file, "utf8"));
      if (feed?.version !== v || !Array.isArray(feed.files)) throw new Error(`Wrong version or invalid feed: ${name}`);
      const actual = feed.files.map((entry) => entry?.url);
      if (actual.length !== expected.length || !expected.every((item) => actual.includes(item)))
        throw new Error(`Incomplete or unexpected installer references: ${name}`);
      if (!actual.includes(feed.path)) throw new Error(`Invalid legacy path: ${name}`);
      for (const entry of feed.files) {
        const installer = path.resolve(options.artifacts, entry.url),
          stat = fs.lstatSync(installer);
        if (!stat.isFile() || !stat.size) throw new Error(`Installer must be a non-empty regular file: ${entry.url}`);
        const hash = createHash("sha512");
        for await (const bytes of fs.createReadStream(installer)) hash.update(bytes);
        const digest = hash.digest("base64");
        if (options.check && (entry.sha512 !== digest || entry.size !== stat.size || (entry.url === feed.path && feed.sha512 !== digest)))
          throw new Error(`Feed checksum mismatch: ${entry.url}`);
        entry.sha512 = digest;
        entry.size = stat.size;
        if (entry.url === feed.path) feed.sha512 = digest;
      }
      changes.push([file, YAML.stringify(feed)]);
    }
  }
  if (!options.check) for (const [file, contents] of changes) fs.writeFileSync(file, contents);
  console.log(`${options.check ? "Verified" : "Refreshed"} final update feeds for ${options.platform}`);
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
