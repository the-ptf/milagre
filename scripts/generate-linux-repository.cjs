// Generates small signed repository metadata. DEB/RPM assets stay on GitHub Releases.
// The RPM must already be signed: run linux-repository-sign-rpm.cjs first.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { gzipSync } = require("node:zlib");
const { spawnSync } = require("node:child_process");

const template = path.resolve(__dirname, "../distribution/linux-repository");
const { url: repository } = require("@milagre/shared/repository");

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error?.code === "ENOENT") throw new Error(`Required tool not found: ${program}`);
  if (result.error || result.status !== 0) {
    throw new Error(`${program} failed: ${result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`}`);
  }
  return result.stdout;
}

function signingEnvironment() {
  const fingerprint = process.env.MILAGRE_LINUX_SIGNING_KEY;
  if (!/^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$/.test(fingerprint ?? "")) {
    throw new Error("Set MILAGRE_LINUX_SIGNING_KEY to the full GPG signing-key fingerprint");
  }
  if (!process.env.GNUPGHOME || !fs.statSync(process.env.GNUPGHOME).isDirectory()) {
    throw new Error("Set GNUPGHOME to an existing private GPG key directory outside the repository");
  }
  const home = fs.realpathSync(process.env.GNUPGHOME);
  const root = path.resolve(__dirname, "..");
  if (home === root || home.startsWith(root + path.sep)) throw new Error("GNUPGHOME must remain outside the repository");
  const key = fingerprint.toUpperCase();
  const listing = run("gpg", ["--batch", "--with-colons", "--list-secret-keys", key]);
  if (!listing.split("\n").some((line) => line.startsWith("fpr:") && line.split(":")[9] === key)) {
    throw new Error("The requested private signing key is unavailable");
  }
  return { fingerprint: key, home };
}

function regularInstaller(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new Error(`Missing installer: ${path.basename(file)}`);
  }
  if (!stat.isFile() || !stat.size) throw new Error(`Installer must be a non-empty regular file: ${path.basename(file)}`);
}

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function write(base, name, contents) {
  const file = path.join(base, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function sign(file, output, fingerprint, clear = false) {
  run("gpg", [
    "--batch",
    "--yes",
    "--local-user",
    fingerprint,
    "--digest-algo",
    "SHA256",
    "--armor",
    "--output",
    output,
    clear ? "--clearsign" : "--detach-sign",
    file,
  ]);
  run("gpg", ["--batch", "--verify", output, ...(clear ? [] : [file])]);
}

function verifyRPM(file, publicKey, temporary) {
  // An isolated rpm keyring prevents a package signed with an unrelated local key
  // from passing. The verification also checks the package's own payload digest.
  const database = path.join(temporary, "rpm-keyring");
  fs.mkdirSync(database);
  run("rpm", ["--dbpath", database, "--initdb"]);
  run("rpmkeys", ["--dbpath", database, "--import", publicKey]);
  const check = run("rpmkeys", ["--dbpath", database, "--checksig", "--verbose", file]);
  if (!/\bSignature\b[^\n]*:\s*OK\b/i.test(check) || /\b(?:NOKEY|NOT OK|BAD|NOTTRUSTED)\b/.test(check)) {
    throw new Error("RPM lacks a valid signature from the repository key; run scripts/linux-repository-sign-rpm.cjs before generating metadata");
  }
}

function signRPM(rpm) {
  regularInstaller(rpm);
  const { fingerprint, home } = signingEnvironment();
  const gpg = run("sh", ["-c", "command -v gpg"]).trim();
  if (/\s/.test(gpg) || /\s/.test(home)) throw new Error("RPM signing requires GPG executable and GNUPGHOME paths without whitespace");
  run("rpmsign", [
    "--define",
    `_gpg_name ${fingerprint}`,
    "--define",
    `_gpg_path ${home}`,
    "--define",
    `__gpg ${gpg}`,
    "--define",
    "_gpg_digest_algo sha256",
    "--addsign",
    rpm,
  ]);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-rpm-sign-"));
  try {
    const key = write(temporary, "archive-keyring.asc", run("gpg", ["--batch", "--armor", "--export", fingerprint]));
    verifyRPM(rpm, key, temporary);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function packageControl(deb, rpm, version) {
  const fields = run("dpkg-deb", ["--field", deb]).trim();
  for (const [field, expected] of [
    ["Package", "milagre"],
    ["Version", version],
    ["Architecture", "amd64"],
  ]) {
    if (!fields.split("\n").includes(`${field}: ${expected}`)) throw new Error(`DEB ${field} must be ${expected}`);
  }
  const rpmFields = run("rpm", ["--query", "--package", "--queryformat", "%{NAME}\n%{VERSION}\n%{ARCH}\n", rpm]).trim().split("\n");
  if (rpmFields.join("\n") !== `milagre\n${version}\nx86_64`) throw new Error("RPM must be milagre with the requested version and x86_64 architecture");
  return fields.replace(/^(?:Filename|Size|MD5sum|SHA1|SHA256|SHA512):[^\n]*(?:\n[ \t][^\n]*)*\n?/gm, "");
}

function previousPackages(file) {
  regularInstaller(file);
  if (fs.statSync(file).size > 1024 * 1024) throw new Error("Previous package map exceeds 1 MiB");
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("Previous package map must be valid JSON");
  }
  if (!entries || typeof entries !== "object" || Array.isArray(entries) || Object.keys(entries).length > 1000)
    throw new Error("Previous package map must contain at most 1000 package entries");
  const result = {};
  for (const [route, entry] of Object.entries(entries)) {
    const match = route.match(
      /^\/(?:pool\/main\/m\/milagre\/(Milagre-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-amd64\.deb)|rpm\/x86_64\/(Milagre-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-x86_64\.rpm))$/,
    );
    const name = match?.[1] ?? match?.[3];
    const version = match?.[2] ?? match?.[4];
    const releasePath = `/releases/download/v${version}/${name}`;
    if (
      !match ||
      !entry ||
      // Accept retained maps written before the rename, then emit canonical URLs.
      ![repository + releasePath, `${repository}-ade${releasePath}`].includes(entry.url) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "") ||
      !Number.isSafeInteger(entry.size) ||
      entry.size <= 0
    ) {
      throw new Error(`Invalid previous package mapping: ${route}`);
    }
    result[route] = { url: repository + releasePath, sha256: entry.sha256, size: entry.size };
  }
  return result;
}

const immutableRoute =
  /^\/(?:dists\/stable\/main\/binary-amd64\/by-hash\/SHA256\/([a-f0-9]{64})|rpm\/x86_64\/repodata\/([a-f0-9]{64})-(?:primary|filelists|other)\.xml\.gz)$/;
function previousMetadata(file) {
  regularInstaller(file);
  if (fs.statSync(file).size > 1024 * 1024) throw new Error("Immutable metadata map exceeds 1 MiB");
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("Immutable metadata map must be valid JSON");
  }
  if (!entries || typeof entries !== "object" || Array.isArray(entries) || Object.keys(entries).length > 1000)
    throw new Error("Immutable metadata map must contain at most 1000 entries");
  const result = {};
  for (const [route, entry] of Object.entries(entries)) {
    const match = route.match(immutableRoute);
    if (!match || !entry || typeof entry.base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.base64))
      throw new Error(`Invalid immutable metadata mapping: ${route}`);
    const bytes = Buffer.from(entry.base64, "base64");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!bytes.length || sha256 !== (match[1] ?? match[2]) || entry.sha256 !== sha256) throw new Error(`Immutable metadata checksum mismatch: ${route}`);
    result[route] = { base64: entry.base64, sha256, type: "application/octet-stream" };
  }
  return result;
}

async function generate(options) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(options.tag ?? "")) {
    throw new Error("Pass --tag vX.Y.Z for a stable release");
  }
  const version = options.tag.slice(1);
  const artifacts = path.resolve(options.artifacts ?? "release");
  const output = path.resolve(options.output ?? "release/linux-repository");
  const debName = `Milagre-${version}-amd64.deb`;
  const rpmName = `Milagre-${version}-x86_64.rpm`;
  const originalDeb = path.join(artifacts, debName);
  const originalRPM = path.join(artifacts, rpmName);
  regularInstaller(originalDeb);
  regularInstaller(originalRPM);
  if (output === artifacts || artifacts.startsWith(output + path.sep) || output === path.parse(output).root) {
    throw new Error("Output must not contain the installer directory or be a filesystem root");
  }
  if (fs.existsSync(output) && fs.readdirSync(output).length && !fs.existsSync(path.join(output, "repository-manifest.json"))) {
    throw new Error("Refusing to replace a nonempty directory that is not generated repository output");
  }
  const oldMap = options.previous ?? (fs.existsSync(path.join(output, "package-map.json")) ? path.join(output, "package-map.json") : null);
  const retainedPackages = oldMap ? previousPackages(oldMap) : {};
  const oldMetadata =
    options.previousMetadata ?? (fs.existsSync(path.join(output, "immutable-metadata.json")) ? path.join(output, "immutable-metadata.json") : null);
  const retainedMetadata = oldMetadata ? previousMetadata(oldMetadata) : {};
  const { fingerprint } = signingEnvironment();
  const epoch = process.env.SOURCE_DATE_EPOCH ?? String(Math.floor(Date.now() / 1000));
  if (!/^\d+$/.test(epoch) || !Number.isSafeInteger(Number(epoch)) || Number(epoch) > 8640000000000) {
    throw new Error("SOURCE_DATE_EPOCH must be a valid Unix timestamp in seconds");
  }
  const date = new Date(Number(epoch) * 1000).toUTCString();
  // Reject a mismatched version/name before signing any bytes.
  packageControl(originalDeb, originalRPM, version);
  if (options.signRPM) signRPM(originalRPM);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-repository-"));
  try {
    // Verify and hash immutable snapshots, then compare the upload inputs again
    // before publishing metadata. Concurrent changes cannot produce unchecked hashes.
    const deb = path.join(temporary, debName);
    const rpm = path.join(temporary, rpmName);
    fs.copyFileSync(originalDeb, deb);
    fs.copyFileSync(originalRPM, rpm);
    const publicKey = write(temporary, "archive-keyring.asc", run("gpg", ["--batch", "--armor", "--export", fingerprint]));
    if (!fs.statSync(publicKey).size) throw new Error("Could not export the public signing key");
    verifyRPM(rpm, publicKey, temporary);
    // Integrity fields always describe the final bytes, never fields supplied by
    // package control metadata. Keep dependency and multiline Description fields.
    const control = packageControl(deb, rpm, version);
    const debHash = await hashFile(deb);
    const rpmHash = await hashFile(rpm);
    const debRoute = `pool/main/m/milagre/${debName}`;
    const rpmRoute = `rpm/x86_64/${rpmName}`;
    const packagesText = `${control}\nFilename: ${debRoute}\nSize: ${fs.statSync(deb).size}\nSHA256: ${debHash}\n\n`;
    const staged = path.join(temporary, "output");
    fs.mkdirSync(staged);
    write(staged, "archive-keyring.asc", fs.readFileSync(publicKey));
    const aptBase = "dists/stable";
    const aptEntries = new Map([
      ["main/binary-amd64/Packages", Buffer.from(packagesText)],
      ["main/binary-amd64/Packages.gz", gzipSync(packagesText, { level: 9 })],
    ]);
    let release = `Origin: Milagre\nLabel: Milagre\nSuite: stable\nCodename: stable\nVersion: ${version}\nDate: ${date}\nArchitectures: amd64\nComponents: main\nDescription: Milagre stable desktop packages\nSHA256:\n`;
    for (const [name, contents] of aptEntries) {
      const hash = createHash("sha256").update(contents).digest("hex");
      write(staged, `${aptBase}/${name}`, contents);
      // by-hash URLs avoid mismatching cached Release and Packages across updates.
      write(staged, `${aptBase}/${path.posix.dirname(name)}/by-hash/SHA256/${hash}`, contents);
      release += ` ${hash} ${contents.length} ${name}\n`;
    }
    release = release.replace("SHA256:\n", "Acquire-By-Hash: yes\nSHA256:\n");
    const releaseFile = write(staged, `${aptBase}/Release`, release);
    sign(releaseFile, path.join(staged, aptBase, "InRelease"), fingerprint, true);
    sign(releaseFile, path.join(staged, aptBase, "Release.gpg"), fingerprint);
    // createrepo must inspect real signed RPM bytes. Work in a private temporary
    // directory and copy only repodata into the deployment; never include RPMs.
    const rpmWorking = path.join(temporary, "rpm-working");
    fs.mkdirSync(rpmWorking);
    fs.copyFileSync(rpm, path.join(rpmWorking, rpmName));
    fs.utimesSync(path.join(rpmWorking, rpmName), Number(epoch), Number(epoch));
    run("createrepo_c", [
      "--checksum",
      "sha256",
      "--no-database",
      "--revision",
      epoch,
      "--set-timestamp-to-revision",
      "--general-compress-type",
      "gz",
      rpmWorking,
    ]);
    const repodata = path.join(staged, "rpm/x86_64/repodata");
    fs.cpSync(path.join(rpmWorking, "repodata"), repodata, { recursive: true });
    sign(path.join(repodata, "repomd.xml"), path.join(repodata, "repomd.xml.asc"), fingerprint);
    write(
      staged,
      "milagre.sources",
      `Types: deb\nURIs: https://packages.milagre.cloud\nSuites: stable\nComponents: main\nArchitectures: amd64\nSigned-By: /usr/share/keyrings/milagre-archive-keyring.gpg\n`,
    );
    write(
      staged,
      "milagre.repo",
      `[milagre]\nname=Milagre stable\nbaseurl=https://packages.milagre.cloud/rpm/x86_64/\nenabled=1\ngpgcheck=1\nrepo_gpgcheck=1\ngpgkey=https://packages.milagre.cloud/archive-keyring.asc\n`,
    );
    for (const [route, entry] of Object.entries(retainedMetadata)) {
      const file = path.join(staged, route.slice(1));
      if (!fs.existsSync(file)) write(staged, route.slice(1), Buffer.from(entry.base64, "base64"));
    }
    const releaseURL = `${repository}/releases/download/${options.tag}`;
    const currentPackages = {
      [`/${debRoute}`]: { url: `${releaseURL}/${debName}`, sha256: debHash, size: fs.statSync(deb).size },
      [`/${rpmRoute}`]: { url: `${releaseURL}/${rpmName}`, sha256: rpmHash, size: fs.statSync(rpm).size },
    };
    for (const [route, entry] of Object.entries(currentPackages)) {
      if (retainedPackages[route] && retainedPackages[route].sha256 !== entry.sha256)
        throw new Error("Refusing to change an already published versioned package checksum");
    }
    const packages = { ...retainedPackages, ...currentPackages };
    if (Object.keys(packages).length > 1000) throw new Error("Package map exceeds 1000 entries; archive old releases explicitly before publishing");
    write(staged, "package-map.json", JSON.stringify(packages, null, 2) + "\n");
    const metadata = {};
    function collect(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) collect(file);
        else {
          const name = path.relative(staged, file).split(path.sep).join("/");
          const contents = fs.readFileSync(file);
          const type =
            name.endsWith(".gz") || name.includes("/by-hash/")
              ? "application/octet-stream"
              : name.endsWith(".xml")
                ? "application/xml; charset=utf-8"
                : name.endsWith(".json")
                  ? "application/json; charset=utf-8"
                  : "text/plain; charset=utf-8";
          metadata[`/${name}`] = { base64: contents.toString("base64"), type, sha256: createHash("sha256").update(contents).digest("hex") };
        }
      }
    }
    collect(staged);
    const immutable = Object.fromEntries(Object.entries(metadata).filter(([route]) => immutableRoute.test(route)));
    const immutableJSON = JSON.stringify(immutable, null, 2) + "\n";
    if (Buffer.byteLength(immutableJSON) > 1024 * 1024 || Object.keys(immutable).length > 1000)
      throw new Error("Immutable metadata map exceeds its 1 MiB / 1000-entry limit; archive old metadata explicitly before publishing");
    write(staged, "immutable-metadata.json", immutableJSON);
    metadata["/immutable-metadata.json"] = {
      base64: Buffer.from(immutableJSON).toString("base64"),
      type: "application/json; charset=utf-8",
      sha256: createHash("sha256").update(immutableJSON).digest("hex"),
    };
    const worker = path.join(staged, "worker");
    const moduleContents = `// Generated public metadata only. No private key or package binaries.\nexport const metadata = ${JSON.stringify(metadata, null, 2)};\nexport const packages = ${JSON.stringify(packages, null, 2)};\n`;
    if (Buffer.byteLength(moduleContents) > 3 * 1024 * 1024) throw new Error("Worker metadata module exceeds its 3 MiB limit");
    write(worker, "repository-data.mjs", moduleContents);
    for (const name of ["worker.mjs", "repository-handler.mjs", "wrangler.toml"]) fs.copyFileSync(path.join(template, name), path.join(worker, name));
    write(staged, "SHA256SUMS", `${debHash}  ${debName}\n${rpmHash}  ${rpmName}\n`);
    write(
      staged,
      "repository-manifest.json",
      JSON.stringify({ tag: options.tag, fingerprint, date, packages, metadataPaths: Object.keys(metadata) }, null, 2) + "\n",
    );
    // Ensure input artifacts were not modified concurrently while indexing.
    if ((await hashFile(originalDeb)) !== debHash || (await hashFile(originalRPM)) !== rpmHash)
      throw new Error("Installer bytes changed during repository generation");
    // Prepare a complete tree before replacing the previous generated deployment.
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const incoming = fs.mkdtempSync(path.join(path.dirname(output), ".milagre-repository-"));
    try {
      fs.cpSync(staged, incoming, { recursive: true });
      fs.rmSync(output, { recursive: true, force: true });
      fs.renameSync(incoming, output);
    } finally {
      fs.rmSync(incoming, { recursive: true, force: true });
    }
    return output;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const options = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--sign-rpm") {
      options.signRPM = true;
      continue;
    }
    if (!["--tag", "--artifacts", "--output", "--previous", "--previous-metadata"].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    options[flag === "--previous-metadata" ? "previousMetadata" : flag.slice(2)] = value;
  }
  console.log(`Generated signed Linux repository in ${await generate(options)}`);
}

module.exports = { generate, hashFile, regularInstaller, run, signingEnvironment, verifyRPM, signRPM, previousPackages, previousMetadata };
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
