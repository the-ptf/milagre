const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { NATIVE_TESTS, MAX_SHARDS, fullSuiteReason, affectedTests, selectAffected, gitState, ciPlan } = require("./affected-tests.cjs");
const runner = require("./test-runner.cjs");

const root = path.join(__dirname, "..");

/** Selection over an in-memory repository: `tree` maps paths to sources. */
function select(tree, changed, tests = Object.keys(tree).filter((file) => /\.test\.|^scripts\/test-/.test(file))) {
  const result = selectAffected({ changed, tests, files: Object.keys(tree), read: (file) => tree[file] });
  return result.full ? result : [...result.tests].sort();
}

const workspace = {
  "packages/shared/package.json": JSON.stringify({
    name: "@milagre/shared",
    exports: { "./chats": { types: "./src/chats.d.mts", default: "./src/chats.mjs" }, "./after-paint": "./src/after-paint.ts" },
  }),
  "packages/shared/src/chats.mjs": `export const chats = 1;`,
  "packages/shared/src/chats.d.mts": `export declare const chats: number;`,
  "packages/shared/src/after-paint.ts": `export const afterPaint = 1;`,
  "packages/core/package.json": JSON.stringify({ name: "@milagre/core", exports: { ".": "./src/runtime.cjs", "./*": "./src/*.cjs" } }),
  "packages/core/src/runtime.cjs": `const store = require("./project-store.cjs");`,
  "packages/core/src/project-store.cjs": `const { chats } = require("@milagre/shared/chats");`,
  "packages/core/src/ports.cjs": `module.exports = {};`,
};

test("a test runs when a file it imports, directly or through others, changes", () => {
  const tree = {
    ...workspace,
    "packages/core/src/runtime.test.cjs": `require("./runtime.cjs");`,
    "packages/core/src/ports.test.cjs": `require("./ports");`,
    "apps/daemon/src/server.test.cjs": `const core = require("@milagre/core"); const ports = require("@milagre/core/ports");`,
  };
  assert.deepEqual(select(tree, ["packages/shared/src/chats.mjs"]), ["apps/daemon/src/server.test.cjs", "packages/core/src/runtime.test.cjs"]);
  assert.deepEqual(select(tree, ["packages/core/src/ports.cjs"]), ["apps/daemon/src/server.test.cjs", "packages/core/src/ports.test.cjs"]);
  assert.deepEqual(select(tree, ["packages/core/src/ports.test.cjs"]), ["packages/core/src/ports.test.cjs"], "a changed test runs itself");
  assert.deepEqual(select(tree, ["packages/shared/src/chats.d.mts"]), ["apps/daemon/src/server.test.cjs", "packages/core/src/runtime.test.cjs"]);
  assert.deepEqual(select(tree, ["README.md"]), []);
});

test("TypeScript, ESM and renderer specifiers resolve: .js for .ts, extensionless, index files, Vite's /src and @/", () => {
  const tree = {
    ...workspace,
    "apps/mobile/src/format.ts": `export const format = 1;`,
    "apps/mobile/src/format.test.ts": `import { format } from "./format.js";`,
    "apps/desktop/app/src/lib/index.ts": `export * from "./settings";`,
    "apps/desktop/app/src/lib/settings.ts": `import { afterPaint } from "@milagre/shared/after-paint";`,
    "apps/desktop/app/src/components/Sidebar.tsx": `import "@/lib";\nimport styles from "./sidebar.css?inline";`,
    "apps/desktop/app/src/components/sidebar.css": `.row {}`,
    "apps/desktop/app/src/components/Sidebar.test.ts": `import { lazy } from "react";\nconst load = () => import("./Sidebar.tsx");`,
    "scripts/test-sidebar.cjs": 'const fixture = `\nimport Sidebar from "/src/components/Sidebar";\nimport "/src/styles.css";\n`;',
    "apps/desktop/app/src/styles.css": `@import "tailwindcss";`,
  };
  assert.deepEqual(select(tree, ["apps/mobile/src/format.ts"]), ["apps/mobile/src/format.test.ts"]);
  assert.deepEqual(select(tree, ["packages/shared/src/after-paint.ts"]), ["apps/desktop/app/src/components/Sidebar.test.ts", "scripts/test-sidebar.cjs"]);
  assert.deepEqual(select(tree, ["apps/desktop/app/src/components/sidebar.css"]), [
    "apps/desktop/app/src/components/Sidebar.test.ts",
    "scripts/test-sidebar.cjs",
  ]);
  assert.deepEqual(select(tree, ["apps/desktop/app/src/styles.css"]), ["scripts/test-sidebar.cjs"]);
});

test("paths a test names rather than imports count: fixtures, folders it scans, scripts it spawns, a package's build output", () => {
  const tree = {
    "scripts/fixtures/report.html": `<p>`,
    "scripts/test-report.cjs": `const html = fs.readFileSync(path.join(__dirname, "fixtures/report.html"));`,
    "scripts/copy.test.cjs": `const root = path.join(__dirname, "..");\nfor (const file of walk(path.join(root, "apps", "mobile", "src"))) check(file);`,
    "apps/mobile/src/screen.tsx": `export default 1;`,
    "apps/mobile/index.ts": `import "./src/screen";`,
    "apps/mobile/plugins/live-activity.cjs": `1`,
    "scripts/config.test.cjs": `const mobile = path.resolve(__dirname, "../apps/mobile");\ngetConfig(mobile);`,
    "scripts/spawn.test.cjs": `spawnSync(process.execPath, [require.resolve("./helper.cjs")]);`,
    "scripts/helper.cjs": `1`,
    "apps/site/src/index.astro": `---`,
    "scripts/test-site.cjs": `const dist = path.resolve(__dirname, "../apps/site/dist");`,
  };
  assert.deepEqual(select(tree, ["scripts/fixtures/report.html"]), ["scripts/test-report.cjs"]);
  assert.deepEqual(select(tree, ["apps/mobile/src/screen.tsx"]), ["scripts/config.test.cjs", "scripts/copy.test.cjs"]);
  assert.deepEqual(select(tree, ["apps/mobile/plugins/live-activity.cjs"]), ["scripts/config.test.cjs"], "a path to a folder is all of it, not its index");
  assert.deepEqual(
    select(tree, ["apps/mobile/src/deleted.tsx"]),
    ["scripts/config.test.cjs", "scripts/copy.test.cjs"],
    "a deleted file under a scanned folder",
  );
  assert.deepEqual(select(tree, ["scripts/helper.cjs"]), ["scripts/spawn.test.cjs"]);
  assert.deepEqual(select(tree, ["apps/site/src/index.astro"]), ["scripts/test-site.cjs"]);
});

test("tests naming other tests, a bare file name and a temporary folder do not depend on them", () => {
  const tree = {
    "README.md": "# Milagre",
    "scripts/test-runner-table.test.cjs": `const WEIGHTS = { "packages/core/src/runtime.test.cjs": 117 };`,
    "packages/core/src/runtime.test.cjs": `fs.writeFileSync(path.join(dir, "README.md"), "x");`,
    "packages/core/src/notes.test.cjs": `fs.writeFileSync(path.join(temporary, "scripts"), "x");`,
    "scripts/x.cjs": "1",
  };
  assert.deepEqual(select(tree, ["packages/core/src/runtime.test.cjs"]), ["packages/core/src/runtime.test.cjs"]);
  assert.deepEqual(select(tree, ["README.md"]), []);
  assert.deepEqual(select(tree, ["scripts/x.cjs"]), []);
});

test("a computed require outside tests depends on everything beside it", () => {
  const tree = {
    "packages/core/src/runtime.cjs": `const adapter = require(designAdapter);`,
    "packages/core/src/design/adapter.cjs": `1`,
    "packages/core/src/runtime.test.cjs": `require("./runtime.cjs");`,
    "packages/core/src/mock.test.cjs": `const load = (id) => require(id);`,
    "packages/core/src/other.cjs": `1`,
  };
  assert.deepEqual(select(tree, ["packages/core/src/design/adapter.cjs"]), ["packages/core/src/runtime.test.cjs"]);
  assert.deepEqual(select(tree, ["packages/core/src/other.cjs"]), ["packages/core/src/runtime.test.cjs"], "a test's own mock require is not a dependency");
});

test("changes the graph cannot follow run the whole suite", () => {
  for (const file of [
    "package.json",
    "apps/mobile/package.json",
    "package-lock.json",
    "apps/mobile/patches/react-native+0.86.3.patch",
    ".github/workflows/ci.yml",
    ".github/actions/install-dependencies/action.yml",
    "scripts/test-runner.cjs",
    "scripts/test.cjs",
    "scripts/affected-tests.cjs",
    "apps/desktop/tsconfig.json",
    "apps/desktop/vite.config.ts",
    "postcss.config.mjs",
  ])
    assert.ok(fullSuiteReason(["README.md", file])?.startsWith(file), file);
  for (const file of [".github/workflows/mobile-ota.yml", "scripts/test-chat-pins.cjs", "apps/mobile/src/app/chat.tsx", "docs/development.md"])
    assert.equal(fullSuiteReason([file]), null, file);
  assert.match(select({}, ["package-lock.json"]).full, /the lockfile/);
  const failing = selectAffected({ changed: ["a.cjs"], tests: [], files: ["a.cjs"], read: () => assert.fail("unreadable") });
  assert.equal(failing.full, null, "an unreadable file is skipped, not fatal");
});

test("a directory dependency reaches through the files under it, but never out of a test", () => {
  const graph = new Map([
    ["scripts/scan.test.cjs", new Set(["apps/mobile/"])],
    ["apps/mobile/src/helper.ts", new Set(["packages/shared/src/x.ts"])],
    ["apps/mobile/src/a.test.ts", new Set(["packages/shared/src/y.ts"])],
  ]);
  const tests = ["scripts/scan.test.cjs", "apps/mobile/src/a.test.ts"];
  assert.deepEqual([...affectedTests({ changed: ["packages/shared/src/x.ts"], tests, graph })], ["scripts/scan.test.cjs"]);
  assert.deepEqual([...affectedTests({ changed: ["packages/shared/src/y.ts"], tests, graph })], ["apps/mobile/src/a.test.ts"]);
});

test("the CI plan sizes the Electron matrix to the selected checks and runs Windows only for its own files", () => {
  const seconds = () => 40;
  assert.deepEqual(ciPlan({ full: "the lockfile", unit: [], electron: [], electronSeconds: seconds }), {
    unit: true,
    electron: true,
    native: true,
    shards: Array.from({ length: MAX_SHARDS }, (_, i) => i + 1),
  });
  assert.deepEqual(ciPlan({ full: null, unit: [], electron: [], electronSeconds: seconds }), { unit: false, electron: false, native: false, shards: [1] });
  const some = ciPlan({ full: null, unit: ["apps/mobile/src/a.test.ts"], electron: ["a", "b", "c", "d", "e"], electronSeconds: seconds });
  assert.deepEqual(some, { unit: true, electron: true, native: false, shards: [1, 2, 3] });
  assert.equal(ciPlan({ full: null, unit: [NATIVE_TESTS[0]], electron: [], electronSeconds: seconds }).native, true);
  const many = ciPlan({ full: null, unit: [], electron: Array.from({ length: 200 }, (_, i) => `c${i}`), electronSeconds: seconds });
  assert.equal(many.shards.length, MAX_SHARDS);
  assert.deepEqual(ciPlan({ full: null, unit: [], electron: ["slow"], electronSeconds: () => 500 }).shards, [1], "never more shards than checks");
});

test("--changed narrows the runner's selection and sharding splits only what was selected", () => {
  const unit = ["packages/core/src/a.test.cjs", "apps/mobile/src/b.test.ts"];
  const electron = ["scripts/test-chat-pins.cjs", "scripts/test-desktop.cjs", "scripts/test-ports.cjs"];
  const affected = new Set(["apps/mobile/src/b.test.ts", "scripts/test-chat-pins.cjs", "scripts/test-desktop.cjs"]);
  const pick = (args) => runner.selectTests({ unit, electron, filters: { ...runner.parseArgs(args), affected, platform: "linux", commandExists: () => true } });
  assert.equal(runner.parseArgs(["--changed", "origin/main"]).changed, "origin/main");
  assert.throws(() => runner.parseArgs(["--changed"]), /--changed needs a value/);
  assert.deepEqual(pick(["--changed", "x"]).unit, ["apps/mobile/src/b.test.ts"]);
  assert.deepEqual(pick(["--changed", "x"]).electron, ["scripts/test-chat-pins.cjs", "scripts/test-desktop.cjs"]);
  const shards = [1, 2].map((index) => pick(["--electron", "--changed", "x", "--shard", `${index}/2`]).electron);
  assert.deepEqual(shards.flat().toSorted(), ["scripts/test-chat-pins.cjs", "scripts/test-desktop.cjs"]);
  const empty = runner.selectTests({
    unit,
    electron,
    filters: { ...runner.parseArgs(["--electron"]), affected: new Set(), platform: "linux", commandExists: () => true },
  });
  assert.deepEqual(empty, { unit: [], electron: [], skipped: [] }, "nothing selected runs nothing, rather than everything");
});

test("on this repository: mobile, core, renderer and runner changes reach the tests they should", () => {
  const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  const unit = runner.discoverUnitTests(root);
  const electron = runner.discoverElectronChecks(root);
  const reach = (changed) => runner.affectedSelection({ root, changed, files, unit, electron });

  const mobile = reach(["apps/mobile/src/app/chat.tsx"]).tests;
  assert.ok(![...mobile].some((file) => electron.includes(file)), "a phone screen reaches no Electron check");
  assert.ok([...mobile].every((file) => !file.startsWith("packages/core/") && !file.startsWith("apps/daemon/")));

  const ownership = reach(["packages/core/src/ownership.cjs"]).tests;
  assert.ok(ownership.has("packages/core/src/ownership.test.cjs"));
  assert.ok(ownership.has("scripts/test-desktop.cjs"), "the desktop smoke loads @milagre/core/ownership");
  assert.ok(NATIVE_TESTS.some((file) => ownership.has(file)));

  const middleware = reach(["scripts/async-middleware.cjs"]).tests;
  for (const check of ["scripts/test-chat-pins.cjs", "scripts/test-routines.cjs"]) assert.ok(middleware.has(check), check);

  const renderer = reach(["apps/desktop/app/src/components/SidebarNav.tsx"]).tests;
  assert.ok(renderer.has("scripts/test-chat-pins.cjs"), "its fixture imports /src/components/SidebarNav");
  assert.ok(renderer.has("scripts/test-desktop.cjs"), "a check that loads the built renderer depends on all of it");

  assert.match(reach(["scripts/test-runner.cjs"]).full, /the test runner/);
  for (const file of NATIVE_TESTS) assert.ok(unit.includes(file), `${file} exists`);
});

test("git state lists committed, uncommitted and untracked changes against the merge base", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "affected-tests-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
  git("init", "-q", "-b", "main");
  for (const name of ["a.cjs", "b.cjs", "c.cjs"]) fs.writeFileSync(path.join(repo, name), name);
  git("add", ".");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "topic");
  fs.writeFileSync(path.join(repo, "a.cjs"), "changed");
  git("commit", "-qam", "topic");
  git("checkout", "-q", "main");
  fs.rmSync(path.join(repo, "c.cjs"));
  git("commit", "-qam", "main moves on");
  git("checkout", "-q", "topic");
  fs.writeFileSync(path.join(repo, "b.cjs"), "uncommitted");
  fs.writeFileSync(path.join(repo, "d.cjs"), "untracked");
  const { changed, files } = gitState(repo, "main", { workingTree: true });
  assert.deepEqual(changed, ["a.cjs", "b.cjs", "d.cjs"], "main's own later change is not this branch's");
  assert.deepEqual(files.toSorted(), ["a.cjs", "b.cjs", "c.cjs", "d.cjs"]);
  assert.deepEqual(gitState(repo, "main", { workingTree: false }).changed, ["a.cjs"], "CI compares commits only");
});
