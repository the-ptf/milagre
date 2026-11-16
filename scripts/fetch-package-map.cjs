const fs = require("node:fs");
const path = require("node:path");
async function main() {
  const directory = process.argv[2];
  if (!directory || process.argv.length !== 3) throw new Error("Usage: node scripts/fetch-package-map.cjs <output-directory>");
  const files = [];
  for (const name of ["package-map.json", "immutable-metadata.json"]) {
    const response = await fetch(`https://packages.milagre.cloud/${name}`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Repository map lookup failed: ${name} (HTTP ${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 1024 * 1024) throw new Error(`Repository map exceeds 1 MiB: ${name}`);
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid repository map: ${name}`);
    files.push([name, bytes]);
  }
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, bytes] of files) fs.writeFileSync(path.join(directory, name), bytes);
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
