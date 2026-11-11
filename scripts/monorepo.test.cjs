const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");

const { owner, repo, url } = require("@milagre/shared/repository");

const root = path.resolve(__dirname, "..");

test("npm discovers the desktop and shared packages from the repository root", () => {
  const workspaces = JSON.parse(execFileSync("npm", ["query", ".workspace"], { cwd: root, encoding: "utf8" }));
  assert.deepEqual(workspaces.map((item) => item.name).sort(), [
    "@milagre/core",
    "@milagre/daemon",
    "@milagre/design-share",
    "@milagre/mobile",
    "@milagre/relay",
    "@milagre/shared",
    "@milagre/site",
    "milagre",
  ]);
});

test("Electron CommonJS and renderer imports share the same chat operations", async () => {
  const desktopRequire = createRequire(path.join(root, "apps/desktop/package.json"));
  const { chatTitle } = desktopRequire("@milagre/shared/chats");
  const { chatKey, projectOfKey, sessionIdFromKey } = desktopRequire("@milagre/shared/agent-runs");
  const { chatTitle: rendererTitle } = await import("../apps/desktop/app/src/lib/chat-list.ts");
  assert.equal(rendererTitle, chatTitle);
  assert.equal(chatTitle({ id: 7, agent_name: "main" }, [{ session_id: 7, role: "user", body: "Keep my existing chat" }]), "Keep my existing chat");
  const key = chatKey("/existing/project", 7);
  assert.equal(projectOfKey(key), "/existing/project");
  assert.equal(sessionIdFromKey(key), 7);
});

test("electron-builder retains desktop identity, update feed, output path and release version overrides", async () => {
  const { Packager } = require("app-builder-lib");
  const packager = new Packager({ projectDir: root, config: { extraMetadata: { version: "9.8.7" } } });
  await packager.validateConfig();
  assert.equal(packager.appDir, path.join(root, "apps/desktop"));
  const info = new (require("app-builder-lib/out/appInfo").AppInfo)(packager, null);
  assert.equal(info.name, "milagre");
  assert.equal(info.productName, "Milagre");
  assert.equal(info.id, "com.milagre.app");
  assert.equal(info.version, "9.8.7");
  assert.equal(path.resolve(root, packager.config.directories.output), path.join(root, "release"));
  assert.deepEqual(packager.config.publish, { provider: "github", owner, repo, releaseType: "release" });
});

test("the Linux icon is a hicolor icon set with the sizes desktops look for", async () => {
  const { Packager } = require("app-builder-lib");
  const packager = new Packager({ projectDir: root });
  await packager.validateConfig();
  const directory = path.resolve(root, packager.config.linux.icon);
  assert.ok((await fs.stat(directory)).isDirectory(), "linux.icon must be a directory of NxN.png files");
  for (const size of [48, 128, 256, 512]) {
    const bytes = await fs.readFile(path.join(directory, `${size}x${size}.png`));
    assert.equal(bytes.readUInt32BE(16), size, `${size}x${size}.png width`);
    assert.equal(bytes.readUInt32BE(20), size, `${size}x${size}.png height`);
  }
});

test("repository metadata and distribution code use the canonical repository", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  assert.deepEqual({ owner, repo, url }, { owner: "the-ptf", repo: "milagre", url: "https://github.com/the-ptf/milagre" });
  assert.deepEqual(pkg.repository, { type: "git", url: `${url}.git` });
  const desktop = JSON.parse(await fs.readFile(path.join(root, "apps/desktop/package.json"), "utf8"));
  assert.equal(desktop.homepage, url);
  assert.ok(desktop.dependencies["@milagre/shared"], "electron-builder must bundle the shared repository module");
  const files = [
    ...(await fs.readdir(path.join(root, "apps/desktop/electron"), { recursive: true })).map((file) => `apps/desktop/electron/${file}`),
    ...(await fs.readdir(path.join(root, "scripts"))).filter((file) => /^generate-.*\.cjs$/.test(file)).map((file) => `scripts/${file}`),
  ];
  const oldRepository = "the-ptf/milagre-ade";
  assert.ok(!JSON.stringify(pkg.build).includes(oldRepository));
  for (const file of files) {
    if ((await fs.stat(path.join(root, file))).isFile()) {
      assert.ok(!(await fs.readFile(path.join(root, file), "utf8")).includes(oldRepository), `${file} uses the old repository`);
    }
  }
});

test("ADR numbers are unique and code references point to existing decisions", async () => {
  const decisions = (await fs.readdir(path.join(root, "docs/adr"))).filter((file) => file.endsWith(".md"));
  const numbers = new Set();
  for (const decision of decisions) {
    const number = /^(\d{4})-/.exec(decision)?.[1];
    assert.ok(number, `${decision} needs a four-digit ADR number`);
    assert.ok(!numbers.has(number), `Duplicate ADR number: ${number}`);
    numbers.add(number);
  }
  const files = execFileSync("git", ["ls-files", "-z", "apps", "packages", "scripts"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const file of files) {
    const contents = await fs.readFile(path.join(root, file), "utf8");
    for (const [reference] of contents.matchAll(/docs\/adr\/\d{4}-[a-z0-9-]+\.md/g)) {
      assert.ok(decisions.includes(path.basename(reference)), `${file} references missing ${reference}`);
    }
  }
});

test("the shared repository module ships to installed CLI consumers", async () => {
  const imported = await import("@milagre/shared/repository");
  assert.deepEqual({ owner: imported.owner, repo: imported.repo, url: imported.url }, { owner, repo, url });
  const [packed] = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: path.join(root, "packages/shared"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const shared = JSON.parse(await fs.readFile(path.join(root, "packages/shared/package.json"), "utf8"));
  for (const target of Object.values(shared.exports["./repository"])) {
    assert.ok(
      packed.files.some((file) => file.path === target.replace(/^\.\//, "")),
      `${target} must ship in the shared package`,
    );
  }
});

test("Linux deployment scripts resolve shared code without installed workspace packages", async () => {
  for (const file of ["generate-linux-repository.cjs", "verify-public-packages.cjs"]) {
    const source = await fs.readFile(path.join(root, "scripts", file), "utf8");
    assert.doesNotMatch(source, /require\(["']@milagre\/shared/, `${file} runs without npm ci`);
  }
});
