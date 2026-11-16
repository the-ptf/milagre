const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { gunzipSync } = require("node:zlib");
const { previousPackages, previousMetadata, regularInstaller, verifyRPM } = require("./generate-linux-repository.cjs");
function verify({ directory, tag, fingerprint, artifacts }) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? "") || !/^[A-F0-9]{40}$/.test(fingerprint ?? ""))
    throw new Error("Expected stable tag and full uppercase signing fingerprint");
  const root = path.resolve(directory);
  const read = (name, limit = 1024 * 1024) => {
    if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.split("/").some((part) => part === "." || part === "..") || name.startsWith("/"))
      throw new Error("Unsafe metadata path");
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > limit) throw new Error(`Invalid metadata file: ${name}`);
    return fs.readFileSync(file);
  };
  const manifest = JSON.parse(read("repository-manifest.json"));
  if (manifest.tag !== tag || manifest.fingerprint !== fingerprint) throw new Error("Repository tag or signing fingerprint mismatch");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-verify-repository-"));
  try {
    fs.chmodSync(temporary, 0o700);
    function gpg(args) {
      const result = spawnSync("gpg", ["--homedir", temporary, "--batch", ...args], { encoding: "utf8" });
      if (result.error || result.status !== 0) throw new Error(`Repository signature verification failed: ${result.error?.message ?? "gpg rejected metadata"}`);
      return result.stdout;
    }
    read("archive-keyring.asc");
    const key = path.join(root, "archive-keyring.asc");
    if (!read("archive-keyring.asc").toString().startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----"))
      throw new Error("Repository key must contain public key material only");
    const keyLines = gpg(["--with-colons", "--show-keys", key]).split("\n");
    const identities = keyLines.flatMap((line, index) => (line.startsWith("pub:") ? [keyLines[index + 1]?.split(":")[9]] : []));
    if (identities.length !== 1 || identities[0] !== fingerprint) throw new Error("Public signing key differs from pinned fingerprint");
    gpg(["--import", key]);
    const signatures = [
      ["dists/stable/InRelease"],
      ["dists/stable/Release.gpg", "dists/stable/Release"],
      ["rpm/x86_64/repodata/repomd.xml.asc", "rpm/x86_64/repodata/repomd.xml"],
    ];
    for (const names of signatures) {
      for (const name of names) read(name);
      const output = gpg(["--status-fd", "1", "--verify", ...names.map((name) => path.join(root, name))]);
      if (!output.split("\n").some((line) => line.startsWith("[GNUPG:] VALIDSIG ") && (line.split(" ")[2] === fingerprint || line.endsWith(` ${fingerprint}`))))
        throw new Error("Metadata was not signed by the pinned key");
    }
    const clear = path.join(temporary, "Release");
    gpg(["--output", clear, "--decrypt", path.join(root, "dists/stable/InRelease")]);
    const release = read("dists/stable/Release");
    if (!release.equals(fs.readFileSync(clear))) throw new Error("InRelease and detached Release payloads differ");
    const entries = release.toString("utf8").split("SHA256:\n")[1]?.trim().split("\n");
    if (!entries?.length) throw new Error("APT checksums missing");
    for (const line of entries) {
      const match = line.match(/^\s*([a-f0-9]{64}) (\d+) (main\/binary-amd64\/Packages(?:\.gz)?)$/);
      if (!match) throw new Error("Invalid APT checksum entry");
      const bytes = read(`dists/stable/${match[3]}`);
      if (bytes.length !== Number(match[2]) || createHash("sha256").update(bytes).digest("hex") !== match[1]) throw new Error("APT index checksum mismatch");
    }
    const repomd = read("rpm/x86_64/repodata/repomd.xml").toString("utf8");
    const data = [...repomd.matchAll(/<data type="[a-z]+">([\s\S]*?)<\/data>/g)];
    if (!data.length) throw new Error("RPM index checksums missing");
    for (const [, block] of data) {
      const checksum = block.match(/<checksum type="sha256">([a-f0-9]{64})<\/checksum>/)?.[1];
      const location = block.match(/<location href="(repodata\/[a-f0-9]+-[a-z]+\.xml\.gz)"\s*\/>/)?.[1];
      if (
        !checksum ||
        !location ||
        createHash("sha256")
          .update(read(`rpm/x86_64/${location}`))
          .digest("hex") !== checksum
      )
        throw new Error("RPM index checksum mismatch");
    }
    const packages = previousPackages(path.join(root, "package-map.json"));
    const immutable = previousMetadata(path.join(root, "immutable-metadata.json"));
    const moduleContents = read("worker/repository-data.mjs", 3 * 1024 * 1024).toString("utf8");
    const moduleParts = moduleContents.match(
      /^\/\/ Generated public metadata only\. No private key or package binaries\.\nexport const metadata = ([\s\S]*?);\nexport const packages = ([\s\S]*?);\n$/,
    );
    if (!moduleParts) throw new Error("Worker embedded metadata has an invalid module format");
    const embedded = JSON.parse(moduleParts[1]);
    const embeddedPackages = JSON.parse(moduleParts[2]);
    if (!isDeepStrictEqual(embeddedPackages, packages) || !isDeepStrictEqual(packages, manifest.packages))
      throw new Error("Worker embedded package map differs from repository metadata");
    if (!isDeepStrictEqual(Object.keys(embedded).sort(), manifest.metadataPaths?.slice().sort()))
      throw new Error("Worker embedded metadata paths differ from repository manifest");
    for (const [route, entry] of Object.entries(embedded)) {
      if (!route.startsWith("/") || /\.(?:deb|rpm)$/.test(route)) throw new Error("Worker embedded metadata has an invalid route");
      const bytes = read(route.slice(1));
      if (
        Buffer.from(entry.base64, "base64").toString("base64") !== entry.base64 ||
        !Buffer.from(entry.base64, "base64").equals(bytes) ||
        createHash("sha256").update(bytes).digest("hex") !== entry.sha256
      )
        throw new Error(`Worker embedded metadata differs from repository file: ${route}`);
    }
    for (const [route, entry] of Object.entries(immutable)) {
      if (!isDeepStrictEqual(embedded[route], entry)) throw new Error("Worker embedded immutable metadata differs from retained metadata");
    }
    for (const name of ["worker.mjs", "repository-handler.mjs", "wrangler.toml"]) {
      if (!read(`worker/${name}`).equals(fs.readFileSync(path.join(__dirname, "../distribution/linux-repository", name))))
        throw new Error(`Worker deployment template differs from checked-in source: ${name}`);
    }
    const version = tag.slice(1);
    const debName = `Milagre-${version}-amd64.deb`;
    const rpmName = `Milagre-${version}-x86_64.rpm`;
    const debRoute = `/pool/main/m/milagre/${debName}`;
    const rpmRoute = `/rpm/x86_64/${rpmName}`;
    const aptText = read("dists/stable/main/binary-amd64/Packages").toString("utf8");
    if (
      !aptText.split("\n").includes(`Version: ${version}`) ||
      !aptText.split("\n").includes(`Filename: ${debRoute.slice(1)}`) ||
      !aptText.split("\n").includes(`SHA256: ${packages[debRoute]?.sha256}`) ||
      !aptText.split("\n").includes(`Size: ${packages[debRoute]?.size}`)
    )
      throw new Error("Current APT package differs from pinned release package map");
    const primary = data.find(([whole]) => whole.startsWith('<data type="primary">'))?.[1];
    const primaryPath = primary?.match(/<location href="([^"]+)"/)?.[1];
    if (!primaryPath) throw new Error("RPM primary metadata missing");
    const primaryText = gunzipSync(read(`rpm/x86_64/${primaryPath}`)).toString("utf8");
    if (
      !primaryText.includes(`<location href="${rpmName}"`) ||
      !primaryText.includes(`<checksum type="sha256" pkgid="YES">${packages[rpmRoute]?.sha256}</checksum>`)
    )
      throw new Error("Current RPM package differs from pinned release package map");
    if (artifacts) {
      function checksum(file) {
        const hash = createHash("sha256");
        const fd = fs.openSync(file, "r");
        const buffer = Buffer.alloc(1024 * 1024);
        try {
          let count;
          while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
        } finally {
          fs.closeSync(fd);
        }
        return hash.digest("hex");
      }
      for (const [name, route] of [
        [debName, debRoute],
        [rpmName, rpmRoute],
      ]) {
        const file = path.resolve(artifacts, name);
        regularInstaller(file);
        if (fs.statSync(file).size !== packages[route].size || checksum(file) !== packages[route].sha256)
          throw new Error(`Signed package checksum mismatch: ${name}`);
      }
      verifyRPM(path.resolve(artifacts, rpmName), key, temporary);
    }
    return manifest;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
if (require.main === module) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      if (!["--directory", "--tag", "--fingerprint", "--artifacts"].includes(args[i]) || !args[i + 1])
        throw new Error("Usage: --directory <bundle> --tag vX.Y.Z --fingerprint <40 hex chars> [--artifacts <final assets>]");
      options[args[i].slice(2)] = args[i + 1];
    }
    verify(options);
    console.log("Verified pinned Linux repository signatures and index checksums");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { verify };
