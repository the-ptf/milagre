// Explicit dedicated-root native check. Never discovers or replaces the installed owner.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
assert.equal(process.argv.length, 4, "Pass the existing dedicated data root and explicit smoke plan");
const [dataRoot, planPath] = await Promise.all(
  process.argv.slice(2).map((p) => {
    assert.ok(isAbsolute(p));
    return realpath(p);
  }),
);
const plan = JSON.parse(await readFile(planPath, "utf8"));
assert.ok(["observe", "send", "content"].includes(plan.mode));
const sending = plan.mode === "send" || (plan.mode === "content" && !plan.resumeContent);
const source = dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(join(await realpath("/tmp"), "milagre-native-chat-observer-"));
await chmod(root, 0o700);
const bundle = join(root, "Milagre Rust Chat.app");
const bin = join(bundle, "Contents/MacOS");
await mkdir(bin, { recursive: true, mode: 0o700 });
for (const [from, name] of [
  [join(source, "target/debug/milagre-rust-chat"), "milagre-rust-chat"],
  [join(source, "../rust-runtime/target/debug/chat-runtime"), "chat-runtime"],
]) {
  await copyFile(from, join(bin, name));
  await chmod(join(bin, name), 0o700);
}
await writeFile(
  join(bundle, "Contents/Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>milagre-rust-chat</string><key>CFBundleIdentifier</key><string>com.milagre.rust-chat</string><key>CFBundleName</key><string>Milagre Rust Chat</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>NSHighResolutionCapable</key><true/><key>LSUIElement</key><true/></dict></plist>`,
  { mode: 0o600 },
);
execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "pipe" });
const summary = {
  source: "background native WKWebView, production React, dedicated Rust backend",
  root,
  dataRoot,
  mode: plan.mode,
  startedAt: new Date().toISOString(),
  binaries: [],
  passed: false,
};
for (const name of ["milagre-rust-chat", "chat-runtime"])
  summary.binaries.push({
    name,
    sha256: createHash("sha256")
      .update(await readFile(join(bin, name)))
      .digest("hex"),
  });
const child = spawn(join(bin, "milagre-rust-chat"), ["open", dataRoot], {
  env: { HOME: homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", MILAGRE_BACKGROUND: "1", MILAGRE_CHAT_SMOKE_CONFIG: planPath },
  stdio: ["ignore", "pipe", "pipe"],
});
summary.pid = child.pid;
let output = "",
  stderr = "",
  overflow = false,
  timer;
child.stdout.on("data", (bytes) => {
  if (output.length + bytes.length <= 64 * 1024) output += bytes;
  else overflow = true;
});
child.stderr.on("data", (bytes) => {
  stderr = (stderr + bytes).slice(-64 * 1024);
});
const exit = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
async function absent(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}
try {
  summary.exit = await Promise.race([
    exit,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("Observer exceeded 215 seconds after the shell's own Quit deadline")), 215000);
    }),
  ]);
  clearTimeout(timer);
  assert.equal(overflow, false, "Shell output overflow");
  const records = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const receipt = records.find((r) => r.chatDesktop && r.evidenceRoot);
  assert.ok(receipt, "Missing native smoke receipt");
  summary.receipt = receipt;
  assert.equal(receipt.chatDesktop.shellPid, child.pid);
  assert.equal(await realpath(receipt.chatDesktop.dataRoot), dataRoot);
  const report = JSON.parse(await readFile(join(receipt.evidenceRoot, "report.json"), "utf8"));
  summary.report = report;
  if (report.passed !== true) {
    const failed = report.stages?.find((stage) => !stage.passed) ?? report.pendingStage;
    throw Error(failed?.error ?? report.timeout ?? `Native smoke incomplete at ${report.progress?.label ?? "unknown stage"}`);
  }
  assert.deepEqual(summary.exit, { code: 0, signal: null });
  assert.equal(stderr, "", "Shell stderr");
  assert.equal(report.passed, true, JSON.stringify(report.stages?.find((s) => !s.passed) ?? report.timeout));
  assert.equal(report.isPersistent, false);
  assert.equal(report.stages.length, 2);
  assert.deepEqual(report.exit, { cleanOwnerExit: true, shellStorageRemoved: true, dataRootPreserved: true });
  const [first, reloaded] = report.stages;
  assert.deepEqual(reloaded.before, { total: first.after.total, ids: first.after.ids }, "Saved transcript changed at renderer reload");
  assert.deepEqual(reloaded.after, first.after, "Renderer reload changed message counts or IDs");
  assert.equal(reloaded.nativeId, first.nativeId);
  assert.equal(typeof first.nativeId, "string");
  assert.ok(first.nativeId.length > 0);
  assert.equal(reloaded.epoch, first.epoch, "Renderer reload should retain the daemon epoch");
  assert.equal(first.sendCalls, sending ? 1 : 0);
  assert.equal(first.sendClicks, sending ? 1 : 0);
  assert.equal(reloaded.sendCalls, 0);
  assert.equal(reloaded.sendClicks, 0);
  if (sending) {
    assert.equal(first.after.total, first.before.total + 2);
    assert.equal(first.events.filter((event) => event.type === "turn-completed").length, 1);
    assert.ok(first.events.some((event) => event.type === "text-delta"));
    if (plan.mode !== "content") assert.equal(first.permissionClicks, plan.permission ? 1 : 0);
  }
  if (plan.mode === "content") {
    if (plan.resumeContent) assert.equal(first.content.resumedExisting, true);
    else assert.equal(first.content.absentBeforeSend, true);
    assert.equal(first.content.saveClicks, 1);
    assert.equal(first.content.applyCalls, 1);
    assert.equal(reloaded.content.saveClicks, 0);
    assert.equal(reloaded.content.applyCalls, 0);
    assert.equal(reloaded.permissionClicks, 0);
    assert.deepEqual(reloaded.content.permissions, []);
    assert.deepEqual(reloaded.content.html, first.content.html, "HTML source or version changed at reload");
    assert.deepEqual(reloaded.content.designBefore, first.content.designSaved, "Reload did not read the saved Design edit");
    assert.deepEqual(reloaded.content.designSaved, first.content.designSaved, "Reload saved or changed the Design");
    assert.equal(first.content.designBefore.text, plan.content.design.beforeText);
    assert.equal(first.content.designSaved.version, first.content.designBefore.version + 1);
    assert.notEqual(first.content.designSaved.sha256, first.content.designBefore.sha256);
    assert.equal(first.permissionClicks, first.content.permissions.length);
    assert.ok(first.content.permissions.length <= 2);
    const permissions = new Set();
    for (const permission of first.content.permissions) {
      assert.ok(!permissions.has(permission.tool), "Repeated content approval");
      permissions.add(permission.tool);
      assert.equal(permission.decision, "allow");
      assert.equal(permission.button, "Allow once");
      assert.equal(permission.detailVisible, true);
      assert.ok(first.events.some((event) => event.type === "permission-resolved" && event.requestId === permission.requestId));
      if (["mcp__milagre__artifact_show", "Artifact Show"].includes(permission.tool)) {
        assert.equal(permission.input.id, plan.content.html.id);
        assert.ok(permission.input.html.includes(plan.content.html.marker));
        assert.ok(!permission.input.tabs && !permission.input.assets?.length);
      } else {
        assert.ok(["mcp__milagre__design_show", "Design Show"].includes(permission.tool));
        assert.equal(permission.input.id, plan.content.design.id);
        assert.ok(!permission.input.from && !permission.input.operations);
        const nodes = permission.input.document.nodes.filter((node) => node.id === plan.content.design.nodeId);
        assert.equal(nodes.length, 1);
        assert.equal(nodes[0].type, "text");
        assert.equal(nodes[0].text, plan.content.design.beforeText);
      }
    }
    for (const stage of report.stages) {
      assert.equal(stage.content.html.id, plan.content.html.id);
      assert.equal(stage.content.html.sourceMarker, plan.content.html.marker);
      assert.match(stage.content.html.sha256, /^[a-f0-9]{64}$/);
      assert.equal(stage.content.designSaved.id, plan.content.design.id);
      assert.equal(stage.content.designSaved.nodeId, plan.content.design.nodeId);
      assert.equal(stage.content.designSaved.text, plan.content.design.afterText);
      assert.match(stage.content.designSaved.sha256, /^[a-f0-9]{64}$/);
      assert.equal(stage.content.htmlPreview.ready, true);
      assert.equal(stage.content.htmlPreview.parentReadDenied, true);
      assert.ok(stage.content.htmlPreview.width > 0 && stage.content.htmlPreview.height > 0);
      assert.equal(stage.content.designPreview.canvasPainted, true);
      assert.equal(stage.content.designPreview.editorVisible, true);
      assert.equal(stage.content.designPreview.inspectorText, plan.content.design.afterText);
      assert.ok(stage.content.designPreview.width > 0 && stage.content.designPreview.height > 0);
      for (const [id, tool] of [
        [plan.content.html.id, "artifact_show"],
        [plan.content.design.id, "design_show"],
      ])
        assert.ok(
          stage.content.toolSteps.some((step) => step.artifact.id === id && step.tool === tool && step.status === "done"),
          "Missing saved content-tool provenance",
        );
    }
    assert.deepEqual(reloaded.content.toolSteps, first.content.toolSteps);
    assert.equal(report.contentCaptures.length, 2);
    summary.contentScope = first.content.opaqueFrameLimit;
  }
  if (plan.expectedText) for (const stage of report.stages) assert.equal(stage.visibleText, plan.expectedText);
  summary.captures = [];
  const captures = [];
  for (const [phase, stage] of report.stages.entries()) {
    assert.equal(stage.phase, phase);
    assert.equal(stage.passed, true);
    assert.ok(!stage.rendererErrors.some((error) => error.method === "chat:patch"), "Opening a Chat failed to save its read status");
    assert.equal(stage.capture.file, phase === 0 ? "before-reload.png" : "after-reload.png");
    captures.push(stage.capture);
    if (plan.mode === "content") {
      assert.ok(
        !stage.rendererErrors.some((error) => ["artifact:apply", "artifact:get", "artifact:list", "artifact-preview:register"].includes(error.method)),
        "Content operation failed",
      );
      const checkpoint = report.contentCaptures[phase];
      assert.equal(checkpoint.phase, phase);
      assert.equal(checkpoint.capture.file, phase === 0 ? "html-before-reload.png" : "html-after-reload.png");
      captures.push(checkpoint.capture);
    }
  }
  for (const capture of captures) {
    const bytes = await readFile(join(receipt.evidenceRoot, capture.file));
    const png = PNG.sync.read(bytes);
    assert.equal(bytes.length, capture.bytes);
    assert.equal(png.width, capture.width);
    assert.equal(png.height, capture.height);
    assert.ok(png.width >= 980 && png.height >= 680);
    const colors = new Set();
    for (let i = 0; i < png.data.length && colors.size < 64; i += 64) colors.add(png.data.readUInt32BE(i));
    assert.ok(colors.size >= 16, "Native capture is blank or nearly uniform");
    summary.captures.push({ file: capture.file, sha256: createHash("sha256").update(bytes).digest("hex"), colors: colors.size });
  }
  summary.cleanup = [];
  for (const delay of [0, 250, 1000]) {
    await pause(delay);
    const row = {
      delay,
      shellAbsent: await absent(receipt.chatDesktop.shellRoot),
      profileAbsent: await absent(receipt.chatDesktop.profile),
      projectRetained: !(await absent(receipt.chatDesktop.project)),
      dataRootRetained: !(await absent(dataRoot)),
    };
    assert.ok(row.shellAbsent && row.profileAbsent && row.projectRetained && row.dataRootRetained);
    summary.cleanup.push(row);
  }
  summary.passed = true;
} catch (error) {
  summary.error = error.message;
  process.exitCode = 1;
  if (child.exitCode === null && child.signalCode === null) {
    // Only this retained shell handle, after its own bounded graceful Quit attempt.
    summary.forcedShellTermination = child.kill("SIGTERM");
    summary.exit = await Promise.race([exit, pause(5000).then(() => ({ unknown: true }))]);
    if (summary.exit.unknown) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }
  }
} finally {
  clearTimeout(timer);
  summary.finishedAt = new Date().toISOString();
  await writeFile(join(root, "stdout.log"), output, { mode: 0o600 });
  await writeFile(join(root, "stderr.log"), stderr, { mode: 0o600 });
  await writeFile(join(root, "observer.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({ passed: summary.passed, error: summary.error, observer: join(root, "observer.json"), evidenceRoot: summary.receipt?.evidenceRoot }),
  );
}
