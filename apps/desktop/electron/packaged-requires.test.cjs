const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The packaged main process loads @milagre/shared from app.asar/node_modules, where Node refuses to strip TypeScript
// types (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Source runs pass because the workspace link is not under
// node_modules, so only the release build would catch a .ts export.
const root = path.resolve(__dirname, "../../..");
const exportsMap = require(path.join(root, "packages/shared/package.json")).exports;
const RUNTIME = /(?:\brequire\(|^\s*(?:import|export)\b[^"'\n]*\bfrom\s*|\bawait import\()\s*["']@milagre\/shared\/([^"']+)["']/gm;

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(file);
    return /\.(?:c|m)?js$/.test(entry.name) && !/\.test\./.test(entry.name) ? [file] : [];
  });
}

test("main process and core load only JavaScript exports of @milagre/shared", () => {
  const offenders = [];
  for (const file of [...sources(__dirname), ...sources(path.join(root, "packages/core/src"))]) {
    for (const [, subpath] of fs.readFileSync(file, "utf8").matchAll(RUNTIME)) {
      const entry = exportsMap[`./${subpath}`];
      const target = typeof entry === "string" ? entry : entry?.default;
      if (!target || /\.tsx?$/.test(target)) offenders.push(`${path.relative(root, file)}: @milagre/shared/${subpath} -> ${target}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the design rasterizer's WebAssembly ships outside the asar", () => {
  const unpack = require(path.join(root, "package.json")).build.asarUnpack;
  assert.ok(unpack.includes("node_modules/@resvg/resvg-wasm/**/*"));
});

test("core resolves the rasterizer's WebAssembly and worker thread", () => {
  const core = path.join(root, "packages/core/src");
  assert.ok(fs.existsSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm", { paths: [core] })));
  assert.match(fs.readFileSync(path.join(core, "design-raster.cjs"), "utf8"), /path\.join\(__dirname, "design-raster-worker\.cjs"\)/);
  assert.ok(fs.existsSync(path.join(core, "design-raster-worker.cjs")));
});
