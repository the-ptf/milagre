// External Node verifier for the installed normal Rust Preview. No Node backend.
// This check sends exactly once, then restarts to verify disk persistence without replay.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const readline = require("node:readline");
const notBefore = "2026-11-12T07:00:00.000Z";
if (Date.now() < Date.parse(notBefore)) {
  console.error(JSON.stringify({ passed: false, blocked: "ACCOUNT_QUOTA_RESET_PENDING", notBefore, appLaunches: 0, sendCalls: 0 }));
  process.exit(2);
}
assert.deepEqual(process.argv.slice(2), ["--run"], "Explicit --run is required after the quota reset; never retries automatically");
const { connect } = require("../../apps/daemon/src/client.cjs");
const { socketPath } = require("../../apps/daemon/src/paths.cjs");
const app = path.join(os.homedir(), "Applications/Milagre Rust Preview.app");
const dataRoot = path.join(os.homedir(), "Library/Application Support/Milagre Rust Preview/data");
assert.equal(fs.realpathSync(app), app);
assert.equal(fs.realpathSync(dataRoot), dataRoot);
assert.equal(
  execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", path.join(app, "Contents/Info.plist")], { encoding: "utf8" }).trim(),
  "com.milagre.rust-preview",
);
const reportRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "milagre-installed-preview-live-"));
fs.chmodSync(reportRoot, 0o700);
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const report = {
  kind: "installed-normal-preview-real-send-stream-save-reopen-native-quit",
  app,
  dataRoot,
  reportRoot,
  startedAt: new Date().toISOString(),
  notBefore,
  passed: false,
  sendCalls: 0,
  phases: [],
};
const records = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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

const helper = path.join(reportRoot, "request-quit");
function save() {
  for (const record of records) fs.writeFileSync(path.join(reportRoot, `phase-${record.phase.phase}-stderr.log`), record.stderr, { mode: 0o600 });
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(reportRoot, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}
async function launch(number) {
  const phase = { phase: number, sendCalls: 0, forced: false, events: [], stderrOverflow: false, stdoutOverflow: false, eventOverflow: false };
  report.phases.push(phase);
  const child = spawn(path.join(app, "Contents/MacOS/milagre-rust-chat"), [], {
    env: { HOME: os.homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", MILAGRE_BACKGROUND: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = { child, phase, stderr: "", exited: false, eventBytes: 0, stdoutBytes: 0 };
  records.push(record);
  phase.shellPid = child.pid;
  record.exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => {
      record.exited = true;
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stderr.on("data", (bytes) => {
    if (Buffer.byteLength(record.stderr) + bytes.length > 65536) phase.stderrOverflow = true;
    record.stderr = (record.stderr + bytes).slice(-65536);
  });
  const lines = readline.createInterface({ input: child.stdout });
  record.receipt = await bounded(
    new Promise((resolve, reject) => {
      lines.on("line", (line) => {
        record.stdoutBytes += Buffer.byteLength(line);
        if (record.stdoutBytes > 65536) {
          phase.stdoutOverflow = true;
          reject(Error("Launch stdout exceeds bound"));
          return;
        }
        try {
          const value = JSON.parse(line);
          if (value.chatDesktop) resolve(value.chatDesktop);
        } catch (error) {
          reject(error);
        }
      });
      child.once("exit", () => reject(Error("Shell exited before receipt")));
    }),
    "normal no-arguments launch receipt",
  );
  const receipt = record.receipt;
  assert.equal(receipt.shellPid, child.pid);
  assert.equal(receipt.dataRoot, dataRoot);
  assert.equal(receipt.project, path.join(dataRoot, "project"));
  assert.equal(receipt.model, "sonnet", "This check uses the explicitly selected Sonnet launch only");
  phase.receipt = receipt;
  phase.socket = socketPath(receipt.profile);
  assert.ok(fs.existsSync(phase.socket), "Actual socket must be observed before Quit");
  const client = (record.client = await connect({ dataDir: receipt.profile, timeoutMs: 10000 }));
  const status = await client.call("daemon:status");
  assert.equal(status.pid, receipt.daemonPid);
  client.on("event", (event) => {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (phase.events.length >= 512 || record.eventBytes + bytes > 2 * 1024 * 1024) {
      phase.eventOverflow = true;
      return;
    }
    record.eventBytes += bytes;
    phase.events.push(event);
  });
  await client.call("project:open", [receipt.project]);
  return record;
}
async function quit(record, recovery = false) {
  const { child, phase, receipt } = record;
  if (receipt) assert.equal(receipt.shellPid, child.pid);
  const result = execFileSync(helper, [String(child.pid), app], { encoding: "utf8", timeout: 20000 }).trim();
  phase[recovery ? "recoveryQuit" : "quit"] = result;
  phase.exit = await bounded(record.exit, "exact child native Quit with cleanup", 35000);
  if (recovery) return;
  assert.deepEqual(phase.exit, { code: 0, signal: null });
  assert.equal(record.stderr, "", "Drained normal shell stderr");
  assert.equal(phase.stderrOverflow, false);
  assert.equal(phase.stdoutOverflow, false);
  assert.equal(phase.eventOverflow, false);
  phase.cleanup = {
    profileAbsent: !fs.existsSync(receipt.profile),
    socketAbsent: !fs.existsSync(phase.socket),
    shellAbsent: !fs.existsSync(receipt.shellRoot),
    projectRetained: fs.existsSync(receipt.project),
    dataRetained: fs.existsSync(dataRoot),
    projectLockAbsent: !fs.existsSync(path.join(receipt.project, ".milagre/runtime.lock")),
  };
  assert.ok(Object.values(phase.cleanup).every(Boolean), "Native Quit must finish actual child/profile/socket cleanup");
  record.client.close();
}
(async () => {
  const source = path.join(reportRoot, "request-quit.swift");
  fs.writeFileSync(source, helperSource, { mode: 0o600 });
  execFileSync("/usr/bin/swiftc", [source, "-o", helper], { timeout: 60000, stdio: "pipe" });
  report.observerSha256 = hash(__filename);
  report.quitHelperSha256 = hash(helper);
  report.binaries = ["milagre-rust-chat", "chat-runtime"].map((name) => ({ name, sha256: hash(path.join(app, "Contents/MacOS", name)) }));
  const first = await launch(0);
  const before = await first.client.call("chat:messages", [first.receipt.project, 1]);
  assert.ok(Array.isArray(before.messages));
  first.phase.before = before;
  const clientMessageId = "installed-live-" + randomUUID();
  const marker = "INSTALLED_RUST_READY_" + randomUUID().replaceAll("-", "").slice(0, 16);
  const body = "Installed Rust preview verification. Do not use tools or read files. Reply with exactly this text and nothing else: " + marker;
  report.clientMessageId = clientMessageId;
  report.marker = marker;
  // Set count before enqueue: even a lost receipt must never trigger a retry.
  assert.ok(Date.now() >= Date.parse(notBefore));
  report.sendCalls = first.phase.sendCalls = 1;
  report.sendReceipt = await first.client.call("chat:send", [
    {
      projectPath: first.receipt.project,
      sessionId: 1,
      provider: "claude",
      model: first.receipt.model,
      permissionMode: "ask",
      replies: "concise",
      tldrEnabled: true,
      clientMessageId,
      body,
    },
  ]);
  let terminal;
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    if (first.phase.eventOverflow) throw Error("Bounded event evidence overflowed");
    const events = first.phase.events
      .filter((event) => event.channel === "agent:event" && event.payload?.chatId === first.receipt.project + "#1")
      .map((event) => event.payload.event);
    const permission = events.find((event) => event.type === "permission-request");
    if (permission) {
      first.phase.unexpectedPermission = permission;
      first.phase.permissionDenied = await first.client.call("agent:respond-permission", [
        { chatId: first.receipt.project + "#1", requestId: permission.requestId, decision: "deny" },
      ]);
      throw Error("Unexpected permission request was denied; no approval was granted");
    }
    terminal = events.find((event) => ["turn-completed", "turn-failed", "turn-cancelled"].includes(event.type));
    if (terminal) break;
    await pause(50);
  }
  first.phase.terminal = terminal ?? null;
  const after = await first.client.call("chat:messages", [first.receipt.project, 1]);
  first.phase.after = after; // Includes bounded saved failure/limit details, not just event type.
  assert.equal(terminal?.type, "turn-completed", "Real turn must complete; retained failure is not a pass");
  assert.equal(after.total, before.total + 2);
  assert.equal(after.messages.length, before.messages.length + 2);
  assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages);
  assert.equal(after.messages.at(-2).clientMessageId, clientMessageId);
  assert.equal(after.messages.at(-2).body, body);
  assert.equal(after.messages.at(-1).body.trim(), marker);
  assert.equal(after.messages.at(-1).outcome, "completed");
  first.phase.streamed = first.phase.events.some(
    (event) => event.channel === "agent:event" && event.payload?.chatId === first.receipt.project + "#1" && event.payload.event.type === "text-delta",
  );
  assert.ok(first.phase.streamed, "Real text delta required");
  await quit(first);
  const reopened = await launch(1);
  assert.notEqual(reopened.receipt.daemonPid, first.receipt.daemonPid);
  assert.notEqual(reopened.receipt.profile, first.receipt.profile);
  const saved = await reopened.client.call("chat:messages", [reopened.receipt.project, 1]);
  reopened.phase.saved = saved;
  assert.equal(saved.total, after.total);
  assert.deepEqual(saved.messages, after.messages, "Second runtime must read the exact persisted transcript");
  assert.equal(reopened.phase.sendCalls, 0);
  await quit(reopened);
  assert.equal(report.sendCalls, 1);
  report.passed = true;
})()
  .catch((error) => {
    report.error = error.stack;
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const record of records) {
      if (!record.exited) {
        try {
          if (record.client && record.receipt?.shellPid === record.child.pid)
            await bounded(record.client.call("agent:interrupt", [record.receipt.project + "#1"]), "recovery interrupt", 11000);
        } catch (error) {
          record.phase.recoveryInterruptError = error.message;
        }
        try {
          await quit(record, true);
        } catch (error) {
          record.phase.recoveryError = error.message;
          if (!record.exited) {
            record.phase.forced = record.child.kill("SIGTERM");
            await bounded(record.exit, "exact retained child fallback", 5000).catch(() => {});
          }
        }
      }
      record.client?.close();
    }
    save();
    console.log(JSON.stringify({ passed: report.passed, sendCalls: report.sendCalls, report: path.join(reportRoot, "report.json"), error: report.error }));
  });
