#!/usr/bin/env node
// Deterministic code-health report and the size ratchet behind `npm run lint`.
// Same tree and git history always give the same output.
//
// Report metrics per file:
//   lines     physical lines
//   fn        longest function in code lines, its name and line (oxlint max-lines-per-function)
//   cx        highest cyclomatic complexity of any function in the file (oxlint complexity)
//   hooks     React hook calls (use[A-Z]...) in the file
//   commits   commits that touched the file
//   fixes     of those, commits whose subject starts with fix / revert / hotfix (regression proxy)
//   score     lines/1000 * (1 + commits/10) * (1 + fixes/5); bigger = riskier to change
//
// The size ratchet: .oxlintrc.json sets global limits for max-lines, max-lines-per-function and
// complexity. Files already over a limit get a per-file cap at their current value in
// .oxlintrc.size-baseline.json, so they can shrink but never grow, and new files meet the limits.
// --write-baseline regenerates that file and only ever lowers caps (or drops a file once it is
// under the limits). --allow-raise lets a cap go up, for a deliberate exception.
//
// Usage:
//   node scripts/code-health-report.cjs                  # markdown table, top 40
//   node scripts/code-health-report.cjs --top 100 --min-lines 800
//   node scripts/code-health-report.cjs --json > report.json
//   node scripts/code-health-report.cjs --write-baseline [--allow-raise]
//   node scripts/code-health-report.cjs --check          # CI: fails when the baseline is stale
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const CONFIG = path.join(root, ".oxlintrc.json");
const BASELINE = path.join(root, ".oxlintrc.size-baseline.json");
const RULES = ["max-lines", "max-lines-per-function", "complexity"];
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

// Test files are exempt from the size rules (see the matching override in .oxlintrc.json).
function isTest(file) {
  return /\.test\.|\.spec\.|(^|\/)__tests__\//.test(file) || /^scripts\/test-[^/]*\.cjs$/.test(file);
}

function git(argv) {
  return execFileSync("git", argv, { cwd: root, encoding: "utf8", maxBuffer: 1 << 30 });
}

// Reads JSON, allowing the whole-line // comments the generated baseline starts with.
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, ""));
}

// The global limits live in .oxlintrc.json; this reads them so there is one source of truth.
function limits() {
  const rules = readJson(CONFIG).rules ?? {};
  const out = {};
  for (const rule of RULES) {
    const setting = rules[rule];
    if (!Array.isArray(setting)) throw new Error(`.oxlintrc.json must configure ${rule} as [level, options]`);
    out[rule] = { options: setting[1], max: typeof setting[1] === "number" ? setting[1] : setting[1].max };
  }
  return out;
}

// The repo's pinned copy of a dev tool (oxlint, oxfmt), through npx when node_modules is missing.
function bin(name) {
  const local = path.join(root, "node_modules", ".bin", name);
  if (fs.existsSync(local)) return { cmd: local, pre: [] };
  const version = readJson(path.join(root, "package.json")).devDependencies?.[name] ?? "latest";
  return { cmd: "npx", pre: ["-y", `${name}@${version.replace(/^[^\d]*/, "")}`] };
}

// Runs oxlint over everything the real config lints, with every size limit at 0, so each file
// reports its own numbers counted exactly the way `npm run lint` counts them.
function measure() {
  const config = readJson(CONFIG);
  const lim = limits();
  const zero = (rule) => {
    const options = lim[rule].options;
    return ["error", typeof options === "number" ? 0 : { ...options, max: 0 }];
  };
  const tmp = path.join(root, ".oxlintrc.code-health.tmp.json");
  fs.writeFileSync(
    tmp,
    JSON.stringify({
      plugins: ["typescript", "react"],
      categories: { correctness: "off", suspicious: "off", perf: "off" },
      rules: Object.fromEntries(RULES.map((rule) => [rule, zero(rule)])),
      ignorePatterns: config.ignorePatterns ?? [],
    }),
  );
  const { cmd, pre } = bin("oxlint");
  let raw;
  try {
    raw = execFileSync(cmd, [...pre, "-c", tmp, "-f", "json"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 30,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    raw = error.stdout; // oxlint exits 1 because every file breaks a limit of 0
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const byFile = new Map();
  for (const d of JSON.parse(raw).diagnostics ?? []) {
    const file = d.filename.split(path.sep).join("/");
    const entry = byFile.get(file) ?? { codeLines: 0, fn: 0, fnName: "", fnLine: 0, cx: 0, cxName: "" };
    const name = /`([^`]+)`/.exec(d.message)?.[1] ?? "(anonymous)";
    const line = d.labels?.[0]?.span?.line ?? 0;
    const n = Number(/\((\d+)\)|complexity of (\d+)/.exec(d.message)?.slice(1).find(Boolean) ?? 0);
    if (d.code === "eslint(max-lines)") entry.codeLines = n;
    if (d.code === "eslint(max-lines-per-function)" && n > entry.fn) Object.assign(entry, { fn: n, fnName: name, fnLine: line });
    if (d.code === "eslint(complexity)" && n > entry.cx) Object.assign(entry, { cx: n, cxName: name });
    byFile.set(file, entry);
  }
  return byFile;
}

// One git log pass: per file, commits and fix commits.
function history() {
  const out = git(["log", "--no-merges", "--name-only", "--format=%x00%s", "--no-renames"]);
  const commits = new Map();
  const fixes = new Map();
  for (const block of out.split("\0").slice(1)) {
    const [subject, ...files] = block.split("\n");
    const isFix = /^(fix|revert|hotfix)\b/i.test(subject);
    for (const file of new Set(files.filter(Boolean))) {
      commits.set(file, (commits.get(file) ?? 0) + 1);
      if (isFix) fixes.set(file, (fixes.get(file) ?? 0) + 1);
    }
  }
  return { commits, fixes };
}

function readBaseline() {
  return fs.existsSync(BASELINE) ? (readJson(BASELINE).overrides ?? []) : [];
}

function buildBaseline(metrics, allowRaise) {
  const lim = limits();
  const previous = new Map(readBaseline().map((o) => [o.files[0], o.rules]));
  const current = (m, rule) => (rule === "max-lines" ? m.codeLines : rule === "complexity" ? m.cx : m.fn);
  const overrides = [];
  const raised = [];
  for (const [file, m] of [...metrics].sort(([a], [b]) => a.localeCompare(b))) {
    if (isTest(file)) continue;
    const rules = {};
    for (const rule of RULES) {
      const value = current(m, rule);
      if (value <= lim[rule].max) continue;
      const before = previous.get(file)?.[rule];
      const beforeMax = before ? (typeof before[1] === "number" ? before[1] : before[1].max) : undefined;
      let cap = value;
      if (beforeMax !== undefined && value > beforeMax && !allowRaise) {
        cap = beforeMax; // keep the old cap: lint goes on failing until the file shrinks back
        raised.push(`${file} ${rule}: ${value} > cap ${beforeMax}`);
      }
      const options = lim[rule].options;
      rules[rule] = ["error", typeof options === "number" ? cap : { ...options, max: cap }];
    }
    if (Object.keys(rules).length > 0) overrides.push({ files: [file], rules });
  }
  return { overrides, raised };
}

// --check: fails when a cap sits above the file's current size (room to grow back unnoticed)
// or a file under the limits still has an entry. Lint already fails on files over their cap.
function checkBaseline(metrics) {
  const { overrides } = buildBaseline(metrics, false);
  if (JSON.stringify(overrides) === JSON.stringify(readBaseline())) {
    process.stdout.write(`${path.relative(root, BASELINE)} is current (${overrides.length} files).\n`);
    return;
  }
  process.stdout.write(
    `${path.relative(root, BASELINE)} is stale: a file shrank. Run \`node scripts/code-health-report.cjs --write-baseline\` and commit the lower caps.\n`,
  );
  process.exitCode = 1;
}

function writeBaseline(metrics) {
  const { overrides, raised } = buildBaseline(metrics, process.argv.includes("--allow-raise"));
  const header = [
    "// Generated by `node scripts/code-health-report.cjs --write-baseline`. Do not edit by hand.",
    "// Per-file caps for files that were already over the global size limits in .oxlintrc.json.",
    "// Caps only go down: split the file, rerun the command, and commit the lower numbers.",
  ];
  fs.writeFileSync(BASELINE, `${header.join("\n")}\n${JSON.stringify({ overrides }, null, 2)}\n`);
  const fmt = bin("oxfmt");
  execFileSync(fmt.cmd, [...fmt.pre, BASELINE], { cwd: root, stdio: "ignore" }); // match the pre-commit format check
  process.stdout.write(`Wrote ${path.relative(root, BASELINE)}: ${overrides.length} files over the global limits.\n`);
  if (raised.length > 0) {
    process.stdout.write(`Kept old caps (file grew; shrink it or rerun with --allow-raise):\n  ${raised.join("\n  ")}\n`);
    process.exitCode = 1;
  }
}

function main() {
  const args = process.argv.slice(2);
  const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const metrics = measure();
  if (args.includes("--write-baseline")) return writeBaseline(metrics);
  if (args.includes("--check")) return checkBaseline(metrics);

  const top = Number(value("--top", "40"));
  const minLines = Number(value("--min-lines", "0"));
  const { commits, fixes } = history();
  const tracked = new Set(git(["ls-files"]).split("\n"));
  const empty = { codeLines: 0, fn: 0, fnName: "", fnLine: 0, cx: 0, cxName: "" };
  const rows = [...tracked]
    .filter((file) => SOURCE.test(file) && fs.existsSync(path.join(root, file)) && metrics.has(file))
    .map((file) => {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      const hooks = (text.match(/\buse[A-Z]\w*\s*\(/g) ?? []).length;
      const c = commits.get(file) ?? 0;
      const f = fixes.get(file) ?? 0;
      const score = Math.round((lines / 1000) * (1 + c / 10) * (1 + f / 5) * 100) / 100;
      return { file, test: isTest(file), lines, ...(metrics.get(file) ?? empty), hooks, commits: c, fixes: f, score };
    });
  rows.sort((a, b) => b.score - a.score || b.lines - a.lines || a.file.localeCompare(b.file));

  const lim = limits();
  const prod = rows.filter((r) => !r.test);
  const summary = {
    files: prod.length,
    overLines: prod.filter((r) => r.codeLines > lim["max-lines"].max).length,
    overFunction: prod.filter((r) => r.fn > lim["max-lines-per-function"].max).length,
    overComplexity: prod.filter((r) => r.cx > lim.complexity.max).length,
    limits: Object.fromEntries(RULES.map((rule) => [rule, lim[rule].max])),
  };
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ summary, rows }, null, 2)}\n`);
    return;
  }
  const shown = prod.filter((r) => r.lines >= minLines).slice(0, top);
  process.stdout.write(
    [
      `Production files: ${summary.files} · over max-lines ${summary.limits["max-lines"]}: ${summary.overLines} · over max-lines-per-function ${summary.limits["max-lines-per-function"]}: ${summary.overFunction} · over complexity ${summary.limits.complexity}: ${summary.overComplexity}`,
      "",
      "| # | file | lines | longest fn | max cx | hooks | commits | fixes | score |",
      "|---|---|---:|---|---:|---:|---:|---:|---:|",
      ...shown.map(
        (r, i) => `| ${i + 1} | ${r.file} | ${r.lines} | ${r.fn} \`${r.fnName}\`:${r.fnLine} | ${r.cx} | ${r.hooks} | ${r.commits} | ${r.fixes} | ${r.score} |`,
      ),
      "",
    ].join("\n"),
  );
}

main();
