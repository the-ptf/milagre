const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const http = require("node:http");
const { createHash } = require("node:crypto");
const { gunzipSync } = require("node:zlib");

const generator = path.join(__dirname, "generate-linux-repository.cjs");
test("rejects prereleases before creating output", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-repository-test-"));
  try {
    const output = path.join(directory, "output");
    const result = spawnSync(process.execPath, [generator, "--tag", "v1.2.3-rc.1", "--output", output], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /stable release/);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("rejects absent or symlinked installers before creating output", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-repository-test-"));
  try {
    const output = path.join(directory, "output");
    const args = [generator, "--tag", "v1.2.3", "--artifacts", directory, "--output", output];
    let result = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.match(result.stderr, /Missing installer: Milagre-1.2.3-amd64.deb/);
    fs.writeFileSync(path.join(directory, "target"), "bytes");
    fs.symlinkSync(path.join(directory, "target"), path.join(directory, "Milagre-1.2.3-amd64.deb"));
    result = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.match(result.stderr, /non-empty regular file/);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("serves metadata bytes, HEAD and conditional requests without calling upstream", async () => {
  const { createRepositoryWorker } = await import("../distribution/linux-repository/repository-handler.mjs");
  const worker = createRepositoryWorker(
    { "/dists/stable/InRelease": { base64: Buffer.from("signed metadata\n").toString("base64"), type: "text/plain", sha256: "a".repeat(64) } },
    {},
    () => {
      throw new Error("Unexpected upstream");
    },
  );
  const response = await worker.fetch(new Request("https://packages.milagre.cloud/dists/stable/InRelease"));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "signed metadata\n");
  assert.equal(response.headers.get("content-length"), "16");
  const head = await worker.fetch(new Request("https://packages.milagre.cloud/dists/stable/InRelease", { method: "HEAD" }));
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("content-length"), "16");
  const cached = await worker.fetch(
    new Request("https://packages.milagre.cloud/dists/stable/InRelease", { headers: { "If-None-Match": '"' + "a".repeat(64) + '"' } }),
  );
  assert.equal(cached.status, 304);
});
test("rejects unknown paths, query strings, encoded paths and write requests", async () => {
  const { createRepositoryWorker } = await import("../distribution/linux-repository/repository-handler.mjs");
  const worker = createRepositoryWorker({}, {}, () => {
    throw new Error("Unexpected upstream");
  });
  for (const suffix of ["/unknown", "/pool/unknown.deb", "/archive-keyring.asc?download=1", "/pool/%2Fsecret", "/pool//secret"]) {
    assert.equal((await worker.fetch(new Request(`https://packages.milagre.cloud${suffix}`))).status, 404);
  }
  assert.equal((await worker.fetch(new Request("https://packages.milagre.cloud/", { method: "POST" }))).status, 405);
  const withKnownKey = createRepositoryWorker(
    { "/archive-keyring.asc": { base64: Buffer.from("public key").toString("base64"), type: "text/plain", sha256: "a".repeat(64) } },
    {},
    () => {
      throw new Error("Unexpected upstream");
    },
  );
  for (const pathname of ["/pool/../archive-keyring.asc", "/pool/%2e%2e/archive-keyring.asc"]) {
    // Preserve the raw URL, as native Request construction normalizes dot segments.
    assert.equal((await withKnownKey.fetch({ url: `https://packages.milagre.cloud${pathname}`, method: "GET", headers: new Headers() })).status, 404);
  }
});
test("proxies only an exact mapped versioned release and limits forwarded headers", async () => {
  const { createRepositoryWorker } = await import("../distribution/linux-repository/repository-handler.mjs");
  let request;
  const url = "https://github.com/the-ptf/milagre/releases/download/v1.2.3/Milagre-1.2.3-amd64.deb";
  const worker = createRepositoryWorker(
    {},
    { "/pool/main/m/milagre/Milagre-1.2.3-amd64.deb": { url, sha256: "b".repeat(64), size: 4 } },
    async (target, init) => {
      request = { target, init };
      return new Response("test", {
        status: 206,
        headers: { "Content-Range": "bytes 0-3/4", "Set-Cookie": "secret", "Content-Type": "application/octet-stream" },
      });
    },
  );
  const response = await worker.fetch(
    new Request("https://packages.milagre.cloud/pool/main/m/milagre/Milagre-1.2.3-amd64.deb", {
      headers: { Range: "bytes=0-3", Authorization: "secret", Cookie: "secret" },
    }),
  );
  assert.equal(request.target, url);
  assert.equal(request.init.headers.get("range"), "bytes=0-3");
  assert.equal(request.init.headers.has("authorization"), false);
  assert.equal(request.init.headers.has("cookie"), false);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-3/4");
  assert.equal(response.headers.has("set-cookie"), false);
  assert.equal(await response.text(), "test");
});

test("retains old repository mappings with canonical URLs after the rename", () => {
  const { previousPackages } = require("./generate-linux-repository.cjs");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-package-map-rename-"));
  const file = path.join(directory, "package-map.json");
  const route = "/pool/main/m/milagre/Milagre-1.0.0-amd64.deb";
  const releasePath = "/releases/download/v1.0.0/Milagre-1.0.0-amd64.deb";
  try {
    for (const repository of ["milagre-ade", "milagre"]) {
      const entry = { url: `https://github.com/the-ptf/${repository}${releasePath}`, size: 4, sha256: "a".repeat(64) };
      fs.writeFileSync(file, JSON.stringify({ [route]: entry }));
      assert.deepEqual(previousPackages(file), { [route]: { ...entry, url: `https://github.com/the-ptf/milagre${releasePath}` } });
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects previous maps that could proxy arbitrary URLs", () => {
  const { previousPackages, previousMetadata } = require("./generate-linux-repository.cjs");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-package-map-"));
  const file = path.join(directory, "package-map.json");
  try {
    for (const entry of [
      { "/pool/main/m/milagre/Milagre-1.0.0-amd64.deb": { url: "https://attacker.example/secret", size: 4, sha256: "a".repeat(64) } },
      {
        "/pool/../secret": { url: "https://github.com/the-ptf/milagre/releases/download/v1.0.0/Milagre-1.0.0-amd64.deb", size: 4, sha256: "a".repeat(64) },
      },
    ]) {
      fs.writeFileSync(file, JSON.stringify(entry));
      assert.throws(() => previousPackages(file), /Invalid previous package mapping/);
    }
    fs.writeFileSync(
      file,
      JSON.stringify({
        ["/dists/stable/main/binary-amd64/by-hash/SHA256/" + "a".repeat(64)]: { base64: Buffer.from("wrong hash").toString("base64"), sha256: "a".repeat(64) },
      }),
    );
    assert.throws(() => previousMetadata(file), /Immutable metadata checksum mismatch/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "real tools authenticate metadata, install fixture packages and reject damaged bytes",
  { skip: process.env.MILAGRE_LINUX_REPOSITORY_INTEGRATION !== "1" },
  async () => {
    const { run, generate } = require("./generate-linux-repository.cjs");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-repository-integration-"));
    const oldEpoch = process.env.SOURCE_DATE_EPOCH;
    const oldMask = process.umask(0o022);
    let server;
    try {
      process.env.SOURCE_DATE_EPOCH = "1791158400";
      const artifacts = path.join(directory, "artifacts");
      fs.mkdirSync(artifacts);
      const debRoot = path.join(directory, "deb");
      fs.mkdirSync(path.join(debRoot, "DEBIAN"), { recursive: true });
      fs.mkdirSync(path.join(debRoot, "usr/share/milagre"), { recursive: true });
      fs.writeFileSync(
        path.join(debRoot, "DEBIAN/control"),
        "Package: milagre\nVersion: 1.2.3\nArchitecture: amd64\nMaintainer: Milagre <release@milagre.cloud>\nDescription: Repository integration fixture\n Fixture payload for signing and installation checks.\n",
      );
      fs.writeFileSync(path.join(debRoot, "usr/share/milagre/repository-fixture.txt"), "installed-deb\n");
      const deb = path.join(artifacts, "Milagre-1.2.3-amd64.deb");
      run("dpkg-deb", ["--build", "--root-owner-group", debRoot, deb]);
      const rpmRoot = path.join(directory, "rpmbuild");
      for (const subdirectory of ["BUILD", "RPMS", "SOURCES", "SPECS", "SRPMS", "BUILDROOT"])
        fs.mkdirSync(path.join(rpmRoot, subdirectory), { recursive: true });
      const spec = path.join(rpmRoot, "SPECS/milagre.spec");
      fs.writeFileSync(
        spec,
        "Name: milagre\nVersion: 1.2.3\nRelease: 1\nSummary: Repository integration fixture\nLicense: MIT\nBuildArch: x86_64\nPrefix: /usr/share/milagre\n%description\nRepository integration fixture.\n%install\nmkdir -p %{buildroot}/usr/share/milagre\necho installed-rpm > %{buildroot}/usr/share/milagre/repository-fixture.txt\n%files\n/usr/share/milagre/repository-fixture.txt\n",
      );
      run("rpmbuild", ["--define", `_topdir ${rpmRoot}`, "-bb", spec]);
      const rpm = path.join(artifacts, "Milagre-1.2.3-x86_64.rpm");
      fs.copyFileSync(path.join(rpmRoot, "RPMS/x86_64/milagre-1.2.3-1.x86_64.rpm"), rpm);
      const output = path.join(directory, "repository");
      await assert.rejects(generate({ tag: "v1.2.3", artifacts, output }), /RPM lacks a valid signature/);
      assert.equal(fs.existsSync(output), false);
      const oldMap = path.join(directory, "old-package-map.json");
      fs.writeFileSync(
        oldMap,
        JSON.stringify({
          "/pool/main/m/milagre/Milagre-1.0.0-amd64.deb": {
            url: "https://github.com/the-ptf/milagre/releases/download/v1.0.0/Milagre-1.0.0-amd64.deb",
            sha256: "a".repeat(64),
            size: 4,
          },
        }),
      );
      const oldMetadata = path.join(directory, "old-metadata.json");
      const oldIndex = Buffer.from("Package: milagre\nVersion: 1.0.0\n");
      const oldHash = createHash("sha256").update(oldIndex).digest("hex");
      const oldRoute = "/dists/stable/main/binary-amd64/by-hash/SHA256/" + oldHash;
      fs.writeFileSync(oldMetadata, JSON.stringify({ [oldRoute]: { base64: oldIndex.toString("base64"), sha256: oldHash } }));
      await generate({ tag: "v1.2.3", artifacts, output, signRPM: true, previous: oldMap, previousMetadata: oldMetadata });
      run("gpg", ["--batch", "--verify", path.join(output, "dists/stable/InRelease")]);
      run("gpg", ["--batch", "--verify", path.join(output, "dists/stable/Release.gpg"), path.join(output, "dists/stable/Release")]);
      run("gpg", ["--batch", "--verify", path.join(output, "rpm/x86_64/repodata/repomd.xml.asc"), path.join(output, "rpm/x86_64/repodata/repomd.xml")]);
      const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      const packages = fs.readFileSync(path.join(output, "dists/stable/main/binary-amd64/Packages"), "utf8");
      assert.match(packages, new RegExp(`SHA256: ${hash(deb)}`));
      assert.match(packages, /Filename: pool\/main\/m\/milagre\/Milagre-1.2.3-amd64.deb/);
      assert.match(packages, /\n Fixture payload for signing and installation checks\./);
      const repomd = fs.readFileSync(path.join(output, "rpm/x86_64/repodata/repomd.xml"), "utf8");
      const primary = repomd.match(/<data type="primary">([\s\S]*?)<\/data>/)[1];
      const primaryPath = primary.match(/<location href="([^"]+)"/)[1];
      assert.match(primaryPath, /^repodata\/[a-f0-9]+-primary.xml.gz$/);
      assert.equal(primary.match(/<checksum type="sha256">([^<]+)<\/checksum>/)[1], hash(path.join(output, "rpm/x86_64", primaryPath)));
      const primaryXML = gunzipSync(fs.readFileSync(path.join(output, "rpm/x86_64", primaryPath))).toString();
      assert.match(primaryXML, new RegExp(`<checksum type="sha256" pkgid="YES">${hash(rpm)}</checksum>`));
      assert.match(primaryXML, /<location href="Milagre-1.2.3-x86_64.rpm"/);
      const firstRelease = fs.readFileSync(path.join(output, "dists/stable/Release"));
      const firstRepomd = fs.readFileSync(path.join(output, "rpm/x86_64/repodata/repomd.xml"));
      fs.writeFileSync(path.join(output, "stale-file"), "remove-on-rerun");
      await generate({ tag: "v1.2.3", artifacts, output });
      const verifier = path.join(__dirname, "verify-linux-repository.cjs");
      const verifyArgs = [verifier, "--directory", output, "--tag", "v1.2.3", "--fingerprint", process.env.MILAGRE_LINUX_SIGNING_KEY, "--artifacts", artifacts];
      let verified = spawnSync(process.execPath, verifyArgs, { encoding: "utf8" });
      assert.equal(verified.status, 0, verified.stderr);
      const wrongFingerprint = [...verifyArgs];
      wrongFingerprint[wrongFingerprint.indexOf("--fingerprint") + 1] = "A".repeat(40);
      assert.notEqual(spawnSync(process.execPath, wrongFingerprint, { encoding: "utf8" }).status, 0);
      const releasePath = path.join(output, "dists/stable/Release");
      const intactRelease = fs.readFileSync(releasePath);
      fs.appendFileSync(releasePath, "tampered\n");
      assert.notEqual(spawnSync(process.execPath, verifyArgs, { encoding: "utf8" }).status, 0);
      fs.writeFileSync(releasePath, intactRelease);
      const packagesPath = path.join(output, "dists/stable/main/binary-amd64/Packages");
      const intactPackages = fs.readFileSync(packagesPath);
      fs.appendFileSync(packagesPath, "tampered\n");
      verified = spawnSync(process.execPath, verifyArgs, { encoding: "utf8" });
      assert.notEqual(verified.status, 0);
      assert.match(verified.stderr, /APT index checksum mismatch/);
      fs.writeFileSync(packagesPath, intactPackages);
      const modulePath = path.join(output, "worker/repository-data.mjs");
      const intactModule = fs.readFileSync(modulePath, "utf8");
      fs.writeFileSync(modulePath, intactModule.replace(/"base64": "[^"]+"/, '"base64": "dGFtcGVyZWQ="'));
      verified = spawnSync(process.execPath, verifyArgs, { encoding: "utf8" });
      assert.notEqual(verified.status, 0);
      assert.match(verified.stderr, /Worker embedded metadata/);
      fs.writeFileSync(modulePath, intactModule);
      assert.deepEqual(fs.readFileSync(path.join(output, "dists/stable/Release")), firstRelease);
      assert.deepEqual(fs.readFileSync(path.join(output, "rpm/x86_64/repodata/repomd.xml")), firstRepomd);
      assert.equal(fs.existsSync(path.join(output, "stale-file")), false);
      const { metadata, packages: proxies } = await import(require("node:url").pathToFileURL(path.join(output, "worker/repository-data.mjs")).href);
      assert.equal(Object.keys(proxies).length, 3);
      assert.equal(proxies["/pool/main/m/milagre/Milagre-1.0.0-amd64.deb"].size, 4);
      assert.equal(
        Object.keys(metadata).some((name) => /\.(deb|rpm)$/.test(name)),
        false,
      );
      assert.equal(proxies["/rpm/x86_64/Milagre-1.2.3-x86_64.rpm"].url, "https://github.com/the-ptf/milagre/releases/download/v1.2.3/Milagre-1.2.3-x86_64.rpm");
      assert.ok(metadata["/package-map.json"]);
      assert.equal(Buffer.from(metadata[oldRoute].base64, "base64").toString(), oldIndex.toString());
      assert.match(fs.readFileSync(path.join(output, "milagre.repo"), "utf8"), /repo_gpgcheck=1/);
      const { createRepositoryWorker } = await import("../distribution/linux-repository/repository-handler.mjs");
      const worker = createRepositoryWorker(
        metadata,
        proxies,
        async (url, init) => new Response(init.method === "HEAD" ? null : fs.readFileSync(path.join(artifacts, path.basename(new URL(url).pathname)))),
      );
      assert.equal(await (await worker.fetch(new Request("http://localhost" + oldRoute))).text(), oldIndex.toString());
      server = http.createServer(async (request, response) => {
        try {
          const result = await worker.fetch(new Request(`http://127.0.0.1${request.url}`, { method: request.method, headers: request.headers }));
          response.writeHead(result.status, Object.fromEntries(result.headers));
          response.end(Buffer.from(await result.arrayBuffer()));
        } catch (error) {
          response.writeHead(500);
          response.end(error.message);
        }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const aptRoot = path.join(directory, "apt");
      for (const subdirectory of [
        "etc/apt/sources.list.d",
        "etc/apt/apt.conf.d",
        "var/lib/apt/lists/partial",
        "var/cache/apt/archives/partial",
        "var/lib/dpkg",
      ])
        fs.mkdirSync(path.join(aptRoot, subdirectory), { recursive: true });
      fs.writeFileSync(path.join(aptRoot, "var/lib/dpkg/status"), "");
      const aptKey = path.join(directory, "archive-keyring.gpg");
      run("gpg", ["--batch", "--yes", "--output", aptKey, "--dearmor", path.join(output, "archive-keyring.asc")]);
      fs.writeFileSync(
        path.join(aptRoot, "etc/apt/sources.list"),
        `deb [arch=amd64 signed-by=${aptKey}] http://127.0.0.1:${server.address().port} stable main\n`,
      );
      async function command(program, args) {
        return new Promise((resolve, reject) => {
          const child = spawn(program, args, { env: { ...process.env, LC_ALL: "C" } });
          let output = "";
          child.stdout.on("data", (data) => {
            output += data;
          });
          child.stderr.on("data", (data) => {
            output += data;
          });
          child.on("error", reject);
          child.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(`${program}: ${output}`))));
        });
      }
      const aptArgs = ["-o", `Dir=${aptRoot}`, "-o", "APT::Sandbox::User=root", "-o", "APT::Architecture=amd64", "-o", "Acquire::Languages=none"];
      await command("apt-get", [...aptArgs, "update"]);
      await command("apt-get", [...aptArgs, "--yes", "--download-only", "install", "milagre"]);
      assert.equal(hash(path.join(aptRoot, "var/cache/apt/archives/milagre_1.2.3_amd64.deb")), hash(deb));
      const debInstalled = path.join(directory, "deb-installed");
      fs.mkdirSync(path.join(debInstalled, "var/lib/dpkg"), { recursive: true });
      // This script-free fixture installs only into our disposable writable root.
      // CI runs without root privileges, unlike a default Docker invocation.
      run("dpkg", ["--force-not-root", "--root", debInstalled, "--install", deb]);
      assert.equal(fs.readFileSync(path.join(debInstalled, "usr/share/milagre/repository-fixture.txt"), "utf8"), "installed-deb\n");
      const rpmInstalled = path.join(directory, "rpm-installed");
      fs.mkdirSync(rpmInstalled);
      // Relocate the script-free fixture instead of chrooting (which requires root).
      // Keep its package database and every installed file inside this test tree.
      const rpmArgs = ["--dbpath", path.join(rpmInstalled, "var/lib/rpm")];
      run("rpm", [...rpmArgs, "--initdb"]);
      run("rpmkeys", [...rpmArgs, "--import", path.join(output, "archive-keyring.asc")]);
      run("rpm", [...rpmArgs, "--install", "--nodeps", "--prefix", path.join(rpmInstalled, "usr/share/milagre"), rpm]);
      assert.equal(fs.readFileSync(path.join(rpmInstalled, "usr/share/milagre/repository-fixture.txt"), "utf8"), "installed-rpm\n");
      const bytes = fs.readFileSync(rpm);
      bytes[bytes.length - 8] ^= 0xff;
      fs.writeFileSync(rpm, bytes);
      await assert.rejects(generate({ tag: "v1.2.3", artifacts, output: path.join(directory, "damaged") }), /rpmkeys failed|RPM lacks a valid signature/);
      assert.equal(fs.existsSync(path.join(directory, "damaged")), false);
    } finally {
      process.umask(oldMask);
      if (server) await new Promise((resolve) => server.close(resolve));
      if (oldEpoch === undefined) delete process.env.SOURCE_DATE_EPOCH;
      else process.env.SOURCE_DATE_EPOCH = oldEpoch;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
