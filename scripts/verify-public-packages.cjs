// Deployment must never advertise a missing or different public installer.
const { url: repository } = require("../packages/shared/src/repository.mjs");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
async function main() {
  const args = process.argv.slice(2),
    options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--directory", "--tag"].includes(args[i]) || !args[i + 1]) throw new Error("Expected --directory <repository> --tag vX.Y.Z");
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(options.tag ?? "")) throw new Error("Expected stable release tag");
  const map = JSON.parse(fs.readFileSync(path.join(options.directory, "package-map.json"), "utf8"));
  const prefix = `${repository}/releases/download/${options.tag}/`;
  const v = options.tag.slice(1),
    names = [`Milagre-${v}-amd64.deb`, `Milagre-${v}-x86_64.rpm`];
  for (const name of names) {
    const entry = Object.values(map).find((entry) => entry.url === prefix + name);
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size <= 0)
      throw new Error(`Missing current package mapping: ${name}`);
    const response = await fetch(entry.url, { signal: AbortSignal.timeout(300000) });
    if (!response.ok) throw new Error(`Public package download failed: ${name} (HTTP ${response.status})`);
    const hash = createHash("sha256");
    let size = 0;
    for await (const bytes of response.body) {
      size += bytes.length;
      if (size > entry.size) throw new Error(`Public package exceeds expected size: ${name}`);
      hash.update(bytes);
    }
    if (size !== entry.size || hash.digest("hex") !== entry.sha256) throw new Error(`Public package checksum mismatch: ${name}`);
  }
  console.log("Verified both public Linux installers against repository hashes");
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
