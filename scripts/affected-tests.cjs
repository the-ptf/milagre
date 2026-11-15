#!/usr/bin/env node
// Which tests a change can reach: a dependency graph over the repository's tracked files, for `npm test -- --changed`
// and the CI change filter. Over-selecting is cheap (the merge queue runs everything anyway); missing a test is not, so
// anything the graph cannot follow sends the whole suite.
const path = require("node:path");

/** Changes the graph cannot reason about: they reach tests through installs, runners, configs or CI itself. */
const FULL_SUITE = [
  [/(^|\/)package\.json$/, "a package manifest"],
  [/^package-lock\.json$/, "the lockfile"],
  [/^apps\/mobile\/patches\//, "a dependency patch"],
  [/^\.github\/workflows\/ci\.yml$/, "the CI workflow"],
  [/^\.github\/actions\//, "a CI action"],
  [/^scripts\/(test|test-runner|affected-tests|electron-warmup)\.cjs$/, "the test runner"],
  [/(^|\/)tsconfig[^/]*\.json$/, "a TypeScript config"],
  [/(^|\/)(vite|vitest|postcss|babel|metro)\.config\.[^/]+$/, "a build config"],
  [/^\.(npmrc|nvmrc|node-version)$/, "the Node setup"],
];

/** The Windows native-tests job runs these files (ci.yml), so it runs when any of them is affected. */
const NATIVE_TESTS = [
  "packages/core/src/agents/codex-provider.test.cjs",
  "packages/core/src/windows-runtime.test.cjs",
  "apps/daemon/src/windows-transport.test.cjs",
  "packages/core/src/link-runtime.test.cjs",
  "packages/core/src/agents/process-tree.test.cjs",
  "packages/core/src/ownership.test.cjs",
  "packages/core/src/agents/command-risk.test.cjs",
  "scripts/test-runner.test.cjs",
  "scripts/launch-env.test.cjs",
];

const SCANNED = /\.(cjs|mjs|js|jsx|ts|tsx|mts|cts|css)$/;
const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css"];
const INDEXES = ["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs"];
/** The desktop renderer's Vite root: Electron check fixtures import `/src/...`, the renderer `@/...`. */
const RENDERER_SRC = "apps/desktop/app/src";
/** Build output is untracked; a path into it depends on the package that builds it. */
const BUILD_OUTPUT = /^((?:apps|packages)\/[^/]+)\/(dist|release|build)(\/|$)/;

function fullSuiteReason(changed) {
  for (const file of changed) for (const [pattern, reason] of FULL_SUITE) if (pattern.test(file)) return `${file} is ${reason}`;
  return null;
}

/**
 * `files`: every tracked path (forward slashes). `read(file)` returns its text. Returns, for each scanned file, the files
 * and directory prefixes (ending in "/") it depends on.
 */
function buildGraph({ files, read }) {
  const universe = new Set(files);
  const dirs = new Set();
  for (const file of files) for (let i = file.indexOf("/"); i !== -1; i = file.indexOf("/", i + 1)) dirs.add(file.slice(0, i + 1));
  const packages = workspacePackages(files, read);

  const asFile = (candidate) => {
    for (const ext of EXTENSIONS) if (universe.has(candidate + ext)) return candidate + ext;
    for (const index of INDEXES) if (universe.has(`${candidate}/${index}`)) return `${candidate}/${index}`;
    // TypeScript sources import siblings by their emitted name: "./x.js" for x.ts.
    const stem = candidate.replace(/\.(m|c)?js$/, "");
    if (stem !== candidate) for (const ext of [".ts", ".tsx", ".mts", ".cts"]) if (universe.has(stem + ext)) return stem + ext;
    return null;
  };
  // An import of a folder loads its index file; a path to a folder (a test scans it, a tool loads it) means all of it.
  const locate = (candidate, { folder = false } = {}) => {
    candidate = path.posix.normalize(candidate).replace(/\/$/, "");
    if (!candidate || candidate === "." || candidate.startsWith("..")) return null;
    if (folder && !universe.has(candidate) && dirs.has(`${candidate}/`)) return `${candidate}/`;
    const file = asFile(candidate);
    if (file) return file;
    if (dirs.has(`${candidate}/`)) return `${candidate}/`;
    const output = BUILD_OUTPUT.exec(candidate);
    if (output && dirs.has(`${output[1]}/`)) return `${output[1]}/`;
    return null;
  };
  const workspace = (specifier) => {
    const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
    const pkg = packages.get(name);
    if (!pkg) return [];
    const subpath = `.${specifier.slice(name.length)}`;
    const targets = exportTargets(pkg.manifest, subpath);
    const found = targets.map((target) => locate(`${pkg.dir}/${target}`)).filter(Boolean);
    if (found.length) return found;
    const direct = locate(`${pkg.dir}/${subpath}`);
    return direct ? [direct] : [`${pkg.dir}/`];
  };

  const topLevel = new Set([...dirs].filter((dir) => dir.indexOf("/") === dir.length - 1));
  const graph = new Map();
  for (const file of files) {
    // A change to a full-suite file runs everything, so what it reaches does not matter; Vite's config would otherwise
    // tie every Electron check to the whole renderer.
    if (!SCANNED.test(file) || fullSuiteReason([file])) continue;
    let source;
    try {
      source = read(file);
    } catch {
      continue;
    }
    const dir = path.posix.dirname(file);
    const deps = new Set();
    const add = (dep) => dep && dep !== file && deps.add(dep);
    // A path named in the source rather than imported: a fixture, a folder a test scans, a script it spawns. Tests
    // name other tests in tables and fixtures without depending on them.
    const refer = (dep) => dep && !TEST_FILE.test(dep) && add(dep);
    const resolveImport = (raw, options) => {
      raw = raw.replace(/[?#].*$/, "");
      if (raw.startsWith("/src/")) return locate(RENDERER_SRC + raw.slice(4), options);
      if (raw.startsWith("@/")) return locate(`${RENDERER_SRC}/${raw.slice(2)}`, options);
      if (raw.startsWith("./") || raw.startsWith("../")) return locate(`${dir}/${raw}`, options);
      return null;
    };
    const folder = { folder: true };

    for (const match of source.matchAll(MODULE_SPECIFIER)) {
      const specifier = match[2] ?? match[4] ?? match[6];
      if (/^(\.|\/|@\/)/.test(specifier)) add(resolveImport(specifier));
      else if (!/^[a-z]+:/.test(specifier)) for (const dep of workspace(specifier)) add(dep);
    }
    for (const [, , literal] of source.matchAll(PATH_LITERAL)) {
      if (!literal.includes("/") || /^(\.\.?\/)+$/.test(literal)) continue;
      if (/^(\.\.?\/|\/src\/|@\/)/.test(literal)) refer(resolveImport(literal, folder));
      else refer(locate(`${dir}/${literal}`, folder) ?? (topLevel.has(`${literal.split("/")[0]}/`) ? locate(literal, folder) : null));
    }
    for (const [, first, rest] of source.matchAll(PATH_JOIN)) {
      const parts = [...rest.matchAll(/(["'`])([^"'`$\s]*)\1/g)].map((part) => part[2]);
      if (!parts.length) continue;
      if (/^(__dirname|import\.meta\.dirname)$/.test(first)) refer(locate(`${dir}/${parts.join("/")}`, folder));
      else if (/root|repo/i.test(first)) refer(locate(parts.join("/"), folder));
    }
    // A require or import of a computed name could load anything beside it. Tests compute names only for mocks and
    // child-process scripts, whose real targets they name as literals above.
    if (!TEST_FILE.test(file) && OPAQUE.test(source)) add(`${dir}/`);
    graph.set(file, deps);
  }
  return graph;
}

// require("x"), require.resolve("x"), import("x"); `from "x"`; a bare `import "x"`.
const MODULE_SPECIFIER = /\b(?:require(?:\.resolve)?|import)\s*\(\s*(["'`])([^"'`$\s]+)\1\s*[,)]|\bfrom\s*(["'])([^"'\s]+)\3|\bimport\s*(["'])([^"'\s]+)\5/g;
const PATH_LITERAL = /(["'`])([\w@.][\w@./-]*)\1/g;
// path.join(__dirname, "..", "apps", "mobile"), resolve(root, "scripts/x.cjs"): the first argument says where from.
const PATH_JOIN = /(?<![.\w])(?:path\.(?:posix\.)?)?(?:join|resolve)\(\s*([\w.$]+)\s*,([^()]*)\)/g;
const OPAQUE = /(?<![.\w])(?:require|import)\s*\(\s*(?:`[^`]*\$\{|[A-Za-z_$])/;
const TEST_FILE = /\.test\.(ts|tsx|mts|cts|js|mjs|cjs)$|^scripts\/test-[^/]+\.cjs$/;

function workspacePackages(files, read) {
  const packages = new Map();
  for (const file of files) {
    if (!/^(apps|packages)\/[^/]+\/package\.json$/.test(file)) continue;
    try {
      const manifest = JSON.parse(read(file));
      if (manifest.name) packages.set(manifest.name, { dir: path.posix.dirname(file), manifest });
    } catch {}
  }
  return packages;
}

function exportTargets(manifest, subpath) {
  const exports = manifest.exports;
  if (!exports) return subpath === "." ? [manifest.main ?? "index.js"] : [];
  const map = typeof exports === "string" || !Object.keys(exports).some((key) => key.startsWith(".")) ? { ".": exports } : exports;
  const strings = (value) => (typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : []);
  if (map[subpath]) return strings(map[subpath]);
  for (const [key, value] of Object.entries(map)) {
    const star = key.indexOf("*");
    if (star === -1) continue;
    const [prefix, suffix] = [key.slice(0, star), key.slice(star + 1)];
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
      const middle = subpath.slice(prefix.length, subpath.length - suffix.length);
      return strings(value).map((target) => target.replace("*", middle));
    }
  }
  return [];
}

/**
 * The tests among `tests` that depend, directly or through other files, on a changed path. A directory dependency
 * covers every path under it, deleted ones included.
 */
function affectedTests({ changed, tests, graph }) {
  const dependents = new Map();
  const dirEdges = [];
  for (const [file, deps] of graph)
    for (const dep of deps) {
      if (dep.endsWith("/")) dirEdges.push([file, dep]);
      else (dependents.get(dep) ?? dependents.set(dep, []).get(dep)).push(file);
    }
  const reached = new Set();
  const queue = [...changed];
  while (queue.length) {
    const file = queue.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    for (const parent of dependents.get(file) ?? []) queue.push(parent);
    if (!TEST_FILE.test(file)) for (const [parent, dir] of dirEdges) if (file.startsWith(dir)) queue.push(parent);
  }
  return new Set(tests.filter((test) => reached.has(test)));
}

/**
 * The whole decision for a change: `{ full: reason }` when the graph cannot be trusted, else the affected test set.
 * `extraDependencies` maps a test to directories it depends on without naming them (a check that builds the renderer).
 */
function selectAffected({ changed, tests, files, read, extraDependencies = {} }) {
  const reason = fullSuiteReason(changed);
  if (reason) return { full: reason };
  let graph;
  try {
    graph = buildGraph({ files, read });
  } catch (error) {
    return { full: `the dependency graph failed: ${error.message}` };
  }
  for (const [test, dirs] of Object.entries(extraDependencies)) for (const dir of dirs) (graph.get(test) ?? graph.set(test, new Set()).get(test)).add(dir);
  return { full: null, tests: affectedTests({ changed, tests, graph }) };
}

/**
 * Changed paths between the merge base with `base` and HEAD, plus uncommitted and untracked ones outside CI (there they
 * are install and build output, which the change filter never saw); every tracked or untracked path.
 */
function gitState(root, base, { workingTree = !process.env.CI } = {}) {
  const { execFileSync } = require("node:child_process");
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\n")
      .filter(Boolean);
  const mergeBase = git("merge-base", base, "HEAD")[0];
  const changed = new Set(git("diff", "--name-only", "--no-renames", mergeBase, "HEAD"));
  if (workingTree)
    for (const file of [...git("diff", "--name-only", "--no-renames", "HEAD"), ...git("ls-files", "--others", "--exclude-standard")]) changed.add(file);
  const files = git("ls-files", "--cached", "--others", "--exclude-standard");
  return { changed: [...changed].sort(), files };
}

/** Electron shards on a PR: about this many seconds of checks each, as on a full run (1000 s over 12 runners). */
const SHARD_SECONDS = 85;
const MAX_SHARDS = 12;

/**
 * What the CI change filter outputs: whether the unit, Electron and Windows jobs run on this PR and over how many
 * Electron shards, from the runner's selection for the Linux runners.
 */
function ciPlan({ full, unit, electron, electronSeconds }) {
  if (full) return { unit: true, electron: true, native: true, shards: range(MAX_SHARDS) };
  const seconds = electron.reduce((sum, file) => sum + electronSeconds(file), 0);
  const shards = electron.length ? Math.min(MAX_SHARDS, electron.length, Math.max(1, Math.ceil(seconds / SHARD_SECONDS))) : 0;
  return {
    unit: unit.length > 0,
    electron: electron.length > 0,
    native: NATIVE_TESTS.some((file) => unit.includes(file)),
    shards: shards ? range(shards) : [1],
  };
}

const range = (count) => Array.from({ length: count }, (_, i) => i + 1);

module.exports = { FULL_SUITE, NATIVE_TESTS, MAX_SHARDS, SHARD_SECONDS, fullSuiteReason, buildGraph, affectedTests, selectAffected, gitState, ciPlan };

// `node scripts/affected-tests.cjs [--base <ref>] [--all] [--github-output]`: the CI change filter. Prints what runs and why.
if (require.main === module) {
  const fs = require("node:fs");
  const root = path.resolve(__dirname, "..");
  const runner = require("./test-runner.cjs");
  const args = process.argv.slice(2);
  const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : null;
  const unitTests = runner.discoverUnitTests(root);
  const electronChecks = runner.discoverElectronChecks(root);
  let full = args.includes("--all") || !base ? "every job runs outside pull requests" : null;
  let affected = null;
  let changed = [];
  if (!full) {
    try {
      const state = gitState(root, base);
      changed = state.changed;
      const result = runner.affectedSelection({ root, changed, files: state.files, unit: unitTests, electron: electronChecks });
      full = result.full;
      affected = result.tests;
    } catch (error) {
      full = `git could not compare with ${base}: ${error.message.split("\n")[0]}`;
    }
  }
  const { unit, electron } = runner.selectTests({
    unit: unitTests,
    electron: electronChecks,
    filters: { ...runner.parseArgs([]), affected, platform: "linux", commandExists: () => true },
  });
  const plan = ciPlan({ full, unit, electron, electronSeconds: runner.electronSeconds });
  const lines = [
    full ? `Full suite: ${full}.` : `${changed.length} changed files.`,
    `unit: ${plan.unit ? `${unit.length} files` : "skipped"}`,
    `electron: ${plan.electron ? `${electron.length} checks over ${plan.shards.length} shards` : "skipped"}`,
    `native (Windows): ${plan.native ? "runs" : "skipped"}`,
  ];
  if (!full) lines.push("", ...unit.map((file) => `unit ${file}`), ...electron.map((file) => `electron ${file}`));
  console.log(lines.join("\n"));
  if (args.includes("--github-output") && process.env.GITHUB_OUTPUT) {
    const outputs = { unit: plan.unit, electron: plan.electron, native: plan.native, shards: JSON.stringify(plan.shards) };
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${lines.join("\n")}\n\`\`\`\n`);
  }
}
