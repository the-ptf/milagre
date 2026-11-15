#!/usr/bin/env node
// `npm test`: every node:test file in one process, then each Electron check serially (each owns a Vite port and an Electron profile).
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  failureLine,
  failureReason,
  testEnv,
  needsShell,
  shouldRetry,
  discoverUnitTests,
  discoverElectronChecks,
  selectTests,
  affectedSelection,
  parseArgs,
  MANIFEST,
} = require("./test-runner.cjs");

const root = path.resolve(__dirname, "..");
const commandExists = (name) => spawnSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "ignore" }).status === 0;
let filters;
try {
  filters = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  console.error("Usage: npm test [-- --unit | --electron] [--workspace <name>] [--only <substring>] [--shard <index>/<count>] [--changed <ref>] [--list]");
  process.exit(2);
}

let selected;
try {
  const unit = discoverUnitTests(root);
  const electron = discoverElectronChecks(root);
  let affected = null;
  if (filters.changed) {
    let result;
    try {
      const { changed, files } = require("./affected-tests.cjs").gitState(root, filters.changed);
      result = affectedSelection({ root, changed, files, unit, electron });
    } catch (error) {
      result = { full: `git could not compare with ${filters.changed}: ${error.message.split("\n")[0]}` };
    }
    if (result.full) console.log(`--changed ${filters.changed}: running every selected test, since ${result.full}.`);
    else affected = result.tests;
  }
  selected = selectTests({ unit, electron, filters: { ...filters, affected, platform: process.platform, commandExists } });
  if (affected && !filters.list) console.log(`--changed ${filters.changed}: ${selected.unit.length + selected.electron.length} tests reach the change.`);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

if (filters.list) {
  for (const file of [...selected.unit, ...selected.electron]) console.log(file);
  process.exit(0);
}

const failures = [];
const failedTests = [];
const flaky = [];
// Streams the command's output as it comes and keeps its last 64 KB, which `failed` reads a check's error from.
function attempt(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ["inherit", "pipe", "pipe"],
      shell: needsShell(command, process.platform),
      env: testEnv(process.env),
    });
    let tail = "";
    const keep = (to) => (chunk) => {
      to.write(chunk);
      tail = (tail + chunk).slice(-65_536);
    };
    child.stdout.on("data", keep(process.stdout));
    child.stderr.on("data", keep(process.stderr));
    child.on("error", (error) => resolve({ status: 1, output: `${tail}\n${error.message}` }));
    child.on("close", (status) => resolve({ status: status ?? 1, output: tail }));
  });
}
async function run(label, command, args, { retryable = false, failed = () => [] } = {}) {
  const started = Date.now();
  let result = await attempt(command, args);
  let retried = false;
  if (result.status !== 0 && retryable && shouldRetry({ platform: process.platform, ci: process.env.CI, attempt: 1 })) {
    for (const line of failed(result.output)) console.log(line);
    console.log(`RETRY: ${label} failed, running it once more`);
    retried = true;
    result = await attempt(command, args);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    failures.push(label);
    for (const line of failed(result.output)) {
      console.log(line);
      failedTests.push(line);
    }
  } else if (retried) flaky.push(label);
  console.log(`${result.status === 0 ? "PASS" : "FAIL"}: ${label} (${seconds}s)`);
}

async function main() {
  if (selected.unit.length) {
    // A second reporter writes one FAILED-TEST line per failing test to a file the summary reads back.
    const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "milagre-test-")), "failed.txt");
    const reporters = [
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      `--test-reporter=${pathToFileURL(path.join(__dirname, "failed-test-reporter.cjs")).href}`,
    ];
    await run(
      `${selected.unit.length} unit test files`,
      process.execPath,
      ["--test", ...reporters, `--test-reporter-destination=${report}`, ...selected.unit],
      {
        failed: () => (fs.existsSync(report) ? fs.readFileSync(report, "utf8").split("\n").filter(Boolean) : []),
      },
    );
    fs.rmSync(path.dirname(report), { recursive: true, force: true });
  }
  if (selected.electron.length) await electron();
  for (const file of flaky) console.log(`FLAKY: ${file} (passed on retry)`);
  for (const { file, reason } of selected.skipped) console.log(`SKIP: ${file} (${reason})`);
  console.log(failures.length ? `\n${failures.length} failed:\n  ${failures.join("\n  ")}` : "\nAll selected tests passed.");
  if (failedTests.length) console.log(`\n${failedTests.join("\n")}`);
  if (selected.electron.length > 5 && !filters.only) console.log("Tip: npm test -- --only <name> runs one Electron check; --unit skips them.");
  process.exit(failures.length ? 1 : 0);
}

async function electron() {
  // Checks write screenshots straight into this folder; with sharding, the one that used to create it may run elsewhere.
  if (process.env.MILAGRE_SCREENSHOT_DIR) fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
  if (selected.electron.some((file) => MANIFEST[path.basename(file)]?.needsBuild))
    await run("build renderer", "npm", ["run", "build:renderer", "--workspace", "milagre"]);
  // The first Electron launch on a fresh Linux runner is unreliable (see electron-warmup.cjs); spend it on a throwaway window.
  // A failed warm-up is not a failed check.
  const warmUp = (script) =>
    spawnSync(process.execPath, [path.join(__dirname, script)], {
      cwd: root,
      stdio: "inherit",
      env: testEnv(process.env),
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
  if (process.platform === "linux" && process.env.CI) {
    warmUp("electron-warmup.cjs");
    if (selected.electron.some((file) => MANIFEST[path.basename(file)]?.previewsHtml)) warmUp("html-preview-warmup.cjs");
  }
  for (const file of selected.electron)
    await run(file, process.execPath, [file], { retryable: true, failed: (output) => [failureLine(file, null, failureReason(output))] });
}

void main();
