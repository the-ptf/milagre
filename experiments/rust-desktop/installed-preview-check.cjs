// Normal installed Preview acceptance. Node is an external verifier, never the daemon.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const readline = require("node:readline");
const { connect } = require("../../apps/daemon/src/client.cjs");
const { socketPath } = require("../../apps/daemon/src/paths.cjs");

const app = path.resolve(process.argv[2] ?? "");
const dataRoot = path.resolve(process.argv[3] ?? "");
assert.equal(process.argv.length, 4, "Pass the explicit Preview.app and its dedicated data root");
assert.equal(path.basename(app), "Milagre Rust Preview.app");
assert.equal(fs.realpathSync(app), app);
assert.equal(fs.realpathSync(dataRoot), dataRoot);
const identifier = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", path.join(app, "Contents/Info.plist")], {
  encoding: "utf8",
}).trim();
assert.equal(identifier, "com.milagre.rust-preview");
const reportRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "milagre-installed-preview-check-"));
fs.chmodSync(reportRoot, 0o700);
const report = {
  kind: "normal-installed-preview-noargs-read-native-quit",
  app,
  dataRoot,
  reportRoot,
  startedAt: new Date().toISOString(),
  passed: false,
  sendCalls: 0,
  forced: false,
};
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
let child,
  client,
  receipt,
  exit,
  exited = false,
  stderr = "",
  stdoutBytes = 0;
function bounded(promise, label, milliseconds = 15000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("Deadline: " + label)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}
const helperSource = `import AppKit
import Foundation
if CommandLine.arguments.count != 3 { exit(2) }
guard let pid = Int32(CommandLine.arguments[1]) else { exit(2) }
let expected = URL(fileURLWithPath: CommandLine.arguments[2]).resolvingSymlinksInPath()
let deadline = Date().addingTimeInterval(15)
while Date() < deadline {
    if let app = NSRunningApplication(processIdentifier: pid), let actual = app.bundleURL?.resolvingSymlinksInPath() {
        guard actual == expected else { fputs("Task-owned Preview identity mismatch\\n", stderr); exit(3) }
        if app.isFinishedLaunching {
            let accepted = app.terminate()
            print("Native termination requested: \\(accepted)")
            // A cleanup-owning delegate may cancel this immediate termination.
            // The observer requires the later exact process exit and removed roots.
            exit(0)
        }
    }
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
}
fputs("Preview did not finish AppKit registration within 15 seconds\\n", stderr)
exit(3)
`;
(async () => {
  const source = path.join(reportRoot, "request-quit.swift"),
    helper = path.join(reportRoot, "request-quit");
  fs.writeFileSync(source, helperSource, { mode: 0o600 });
  execFileSync("/usr/bin/swiftc", [source, "-o", helper], { timeout: 60000, stdio: "pipe" });
  report.observerSha256 = hash(__filename);
  report.quitHelperSha256 = hash(helper);
  report.binaries = ["milagre-rust-chat", "chat-runtime"].map((name) => ({ name, sha256: hash(path.join(app, "Contents/MacOS", name)) }));
  child = spawn(path.join(app, "Contents/MacOS/milagre-rust-chat"), [], {
    env: { HOME: os.homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", MILAGRE_BACKGROUND: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  report.pid = child.pid;
  exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => {
      exited = true;
    });
    // Wait for captured stdout/stderr to close before accepting empty stderr.
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + bytes).slice(-65536);
  });
  const lines = readline.createInterface({ input: child.stdout });
  receipt = await bounded(
    new Promise((resolve, reject) => {
      lines.on("line", (line) => {
        stdoutBytes += Buffer.byteLength(line);
        if (stdoutBytes > 65536) return reject(Error("Launch stdout exceeded its bound"));
        try {
          const value = JSON.parse(line);
          if (value.chatDesktop) resolve(value.chatDesktop);
        } catch (error) {
          reject(error);
        }
      });
      child.once("exit", () => reject(Error("Shell exited before its receipt")));
    }),
    "no-arguments launch receipt",
  );
  assert.equal(receipt.shellPid, child.pid);
  assert.equal(receipt.dataRoot, dataRoot);
  assert.equal(receipt.project, path.join(dataRoot, "project"));
  report.receipt = receipt;
  report.socket = socketPath(receipt.profile);
  assert.ok(fs.existsSync(report.socket), "Actual socket must exist before Quit");
  client = await connect({ dataDir: receipt.profile, timeoutMs: 10000 });
  const status = await client.call("daemon:status");
  assert.equal(status.pid, receipt.daemonPid);
  await client.call("project:open", [receipt.project]);
  const state = await client.call("project:read", [receipt.project]);
  assert.ok(state && typeof state === "object");
  const first = await client.call("chat:messages", [receipt.project, 1]);
  assert.ok(Array.isArray(first.messages));
  assert.equal(typeof first.total, "number");
  const second = await client.call("chat:messages", [receipt.project, 1]);
  assert.deepEqual(second, first, "No-send reads must preserve the saved transcript");
  report.savedRead = {
    total: first.total,
    ids: first.messages.map((message) => message.id),
    sha256: createHash("sha256").update(JSON.stringify(first)).digest("hex"),
  };
  report.quit = execFileSync(helper, [String(child.pid), app], { encoding: "utf8", timeout: 20000 }).trim();
  report.exit = await bounded(exit, "native Quit and retained cleanup", 35000);
  assert.deepEqual(report.exit, { code: 0, signal: null });
  assert.equal(stderr, "", "Normal shell stderr");
  report.cleanup = {
    profileAbsent: !fs.existsSync(receipt.profile),
    socketAbsent: !fs.existsSync(report.socket),
    shellAbsent: !fs.existsSync(receipt.shellRoot),
    projectRetained: fs.existsSync(receipt.project),
    lockAbsent: !fs.existsSync(path.join(receipt.project, ".milagre/runtime.lock")),
  };
  assert.ok(Object.values(report.cleanup).every(Boolean), "Quit exited before exact cleanup completed");
  report.passed = true;
})()
  .catch((error) => {
    report.error = error.stack;
    process.exitCode = 1;
  })
  .finally(async () => {
    if (child && !exited) {
      try {
        if (client && receipt?.shellPid === child.pid) {
          await client.call("agent:interrupt", [receipt.project + "#1"]);
          await client.call("daemon:stop");
        }
        const helper = path.join(reportRoot, "request-quit");
        report.recoveryQuit = execFileSync(helper, [String(child.pid), app], { encoding: "utf8", timeout: 20000 }).trim();
        report.recoveryExit = await bounded(exit, "recovery native Quit", 15000);
      } catch (error) {
        report.recoveryError = error.message;
        if (!exited && receipt?.shellPid === child.pid) {
          report.forced = child.kill("SIGTERM");
          await bounded(exit, "retained exact-child fallback", 5000).catch(() => {});
        }
      }
    }
    client?.close();
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(reportRoot, "stderr.log"), stderr, { mode: 0o600 });
    fs.writeFileSync(path.join(reportRoot, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ passed: report.passed, report: path.join(reportRoot, "report.json"), error: report.error, cleanup: report.cleanup }));
  });
