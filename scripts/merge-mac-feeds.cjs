// Joins the per-architecture macOS feeds in the order electron-builder writes for a two-arch build.
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

const [x64Dir, arm64Dir, outDir] = process.argv.slice(2);
try {
  if (!x64Dir || !arm64Dir || !outDir) throw new Error("Usage: merge-mac-feeds.cjs <x64 dir> <arm64 dir> <output dir>");
  const names = ["latest-mac.yml", "beta-mac.yml"].filter((name) => fs.existsSync(path.join(x64Dir, name)) || fs.existsSync(path.join(arm64Dir, name)));
  if (names.length !== 1) throw new Error("Each architecture must stage exactly one macOS feed, the same one.");
  const [name] = names;
  const [x64, arm64] = [x64Dir, arm64Dir].map((dir) => YAML.parse(fs.readFileSync(path.join(dir, name), "utf8")));
  if (x64?.version !== arm64?.version) throw new Error("The architectures built different versions.");
  const byKind = (feed, ext) => feed.files.filter((entry) => entry.url.endsWith(ext));
  const zip = byKind(x64, ".zip")[0];
  if (!zip) throw new Error("The x64 feed names no ZIP.");
  const merged = {
    version: x64.version,
    files: [...byKind(x64, ".zip"), ...byKind(arm64, ".zip"), ...byKind(x64, ".dmg"), ...byKind(arm64, ".dmg")],
    path: zip.url,
    sha512: zip.sha512,
    releaseDate: [x64.releaseDate, arm64.releaseDate].sort().at(-1),
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), YAML.stringify(merged));
  console.log(`Merged ${name} for ${merged.version}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
