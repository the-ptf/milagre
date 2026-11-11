// Fixed isolated binaries only. This never installs or discovers a live daemon.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";

assert.equal(process.argv.length, 2, "This observer accepts no inputs");
const source = dirname(fileURLToPath(import.meta.url));
const temp = await realpath("/tmp");
const root = await mkdtemp(join(temp, "milagre-native-fixture-observer-"));
await chmod(root, 0o700);
const bundle = join(root, "Milagre Rust Fixture.app");
const bin = join(bundle, "Contents/MacOS");
await mkdir(bin, { recursive: true, mode: 0o700 });
for (const [from, to] of [
  [join(source, "target/debug/milagre-rust-fixture"), "milagre-rust-fixture"],
  [join(source, "../rust-runtime/target/debug/app-fixture"), "app-fixture"],
]) {
  await copyFile(from, join(bin, to));
  await chmod(join(bin, to), 0o700);
}
await writeFile(
  join(bundle, "Contents/Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>milagre-rust-fixture</string><key>CFBundleIdentifier</key><string>com.milagre.rust-fixture</string><key>CFBundleName</key><string>Milagre Rust Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>NSHighResolutionCapable</key><true/><key>LSUIElement</key><true/></dict></plist>`,
  { mode: 0o600 },
);
execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "pipe" });
const watched = [
  join(homedir(), "Library/Application Support/Milagre/preferences.json"),
  join(homedir(), "Library/Application Support/com.milagre.rust-poc/preferences.json"),
];
async function fingerprints() {
  return Promise.all(
    watched.map(async (path) => {
      try {
        const info = await lstat(path);
        assert.ok(info.isFile() && info.size <= 1024 * 1024, "Preference observation bound");
        return {
          path,
          bytes: info.size,
          sha256: createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        };
      } catch (error) {
        if (error.code === "ENOENT") return { path, absent: true };
        throw error;
      }
    }),
  );
}
const binaries = await Promise.all(
  ["milagre-rust-fixture", "app-fixture"].map(async (name) => ({
    name,
    sha256: createHash("sha256")
      .update(await readFile(join(bin, name)))
      .digest("hex"),
  })),
);
const summary = {
  schemaVersion: 1,
  source: "isolated background WKWebView fixture, scripted Rust owner",
  root,
  binaries,
  productionPreferencesBefore: await fingerprints(),
  runs: [],
  passed: false,
  omissions: ["cookies", "full WebKit filesystem attribution", "native object deallocation", "real providers", "performance comparison"],
};
async function save() {
  await writeFile(join(root, "observer.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
}
async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function run(index) {
  const child = spawn(join(bin, "milagre-rust-fixture"), [], {
    env: { HOME: homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", MILAGRE_BACKGROUND: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entry = { index, pid: child.pid };
  summary.runs.push(entry);
  let output = "",
    errors = "",
    overflow = false;
  child.stdout.on("data", (bytes) => {
    if (output.length + bytes.length <= 16384) output += bytes;
    else overflow = true;
  });
  child.stderr.on("data", (bytes) => {
    errors = (errors + bytes).slice(-65536);
  });
  const timer = setTimeout(() => {
    entry.timedOut = true;
    child.kill("SIGKILL");
  }, 110000);
  const status = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error: error.message }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  entry.status = status;
  entry.stderr = errors;
  entry.stdoutOverflow = overflow;
  const receipt = output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((value) => value?.fixtureSmoke);
  entry.receipt = receipt;
  if (!receipt) {
    await save();
    throw Error("Fixture emitted no bounded smoke receipt");
  }
  assert.equal(receipt.fixtureSmoke.shellPid, child.pid);
  for (const [path, prefix] of [
    [receipt.evidenceRoot, "milagre-fixture-evidence-"],
    [receipt.fixtureSmoke.shellRoot, "milagre-rust-shell-"],
  ]) {
    assert.equal(dirname(path), temp);
    assert.ok(path.slice(temp.length + 1).startsWith(prefix));
  }
  assert.ok(receipt.fixtureSmoke.profile.startsWith(`${temp}/milagre-rust-wire-`));
  entry.report = JSON.parse(await readFile(join(receipt.evidenceRoot, "report.json"), "utf8"));
  entry.cleanup = [];
  let previous = 0;
  for (const ms of [0, 250, 1000, 5000]) {
    await pause(ms - previous);
    previous = ms;
    entry.cleanup.push({
      millisecondsAfterExit: ms,
      shellRootExists: await exists(receipt.fixtureSmoke.shellRoot),
      daemonProfileExists: await exists(receipt.fixtureSmoke.profile),
    });
  }
  await save();
  assert.equal(status.code, 0, `Fixture failed; evidence ${root}`);
  assert.equal(overflow, false);
  assert.equal(entry.report.passed, true);
  assert.equal(entry.report.isPersistent, false);
  assert.equal(entry.report.ownerStop.ok, true);
  assert.equal(entry.report.exitCleanup.ok, true);
  assert.equal(entry.report.stages.length, 2);
  if (entry.report.scenario === "send") {
    const [sent, reloaded] = entry.report.stages.map((stage) => stage.send);
    assert.equal(sent.sendClicks, 1);
    assert.equal(sent.sendCalls, 1);
    assert.equal(sent.stage, "complete");
    assert.equal(reloaded.sendClicks, 0);
    assert.equal(reloaded.sendCalls, 0);
    assert.equal(reloaded.reloadSurvived, true);
    assert.deepEqual(reloaded.transcript, sent.transcript);
  }
  for (const stage of entry.report.stages) {
    assert.equal(stage.passed, true);
    assert.equal(stage.storage.outboxStateUnchanged, true);
    const png = await readFile(join(receipt.evidenceRoot, stage.capture.file));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.length, stage.capture.bytes);
  }
  assert.ok(entry.cleanup.every((item) => !item.shellRootExists && !item.daemonProfileExists));
}
try {
  await run(1);
  await run(2);
  assert.notEqual(summary.runs[0].receipt.fixtureSmoke.profile, summary.runs[1].receipt.fixtureSmoke.profile);
  assert.notEqual(summary.runs[0].receipt.fixtureSmoke.shellRoot, summary.runs[1].receipt.fixtureSmoke.shellRoot);
  summary.productionPreferencesAfter = await fingerprints();
  summary.productionPreferencesUnchanged = JSON.stringify(summary.productionPreferencesBefore) === JSON.stringify(summary.productionPreferencesAfter);
  summary.passed = true;
} catch (error) {
  summary.error = error.message;
  process.exitCode = 1;
}
summary.productionPreferencesAfter = await fingerprints();
summary.productionPreferencesUnchanged = JSON.stringify(summary.productionPreferencesBefore) === JSON.stringify(summary.productionPreferencesAfter);
await save();
process.stdout.write(`${JSON.stringify({ passed: summary.passed, report: join(root, "observer.json"), error: summary.error })}\n`);
