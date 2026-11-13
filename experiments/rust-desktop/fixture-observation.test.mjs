import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installedApplications,
  preferenceObservation,
  preferenceFingerprint,
  fixtureFailure,
  assertContentHealth,
  assertFixtureScenario,
} from "./fixture-observation.mjs";

test("live app metadata includes only installed executable identities, not fixture or command arguments", () => {
  const result = installedApplications(`16468 1 Tue Nov 10 23:32:28 2026 /Users/test/Applications/Milagre Rust.app/Contents/MacOS/milagre-rust
55099 1 Tue Nov 10 08:32:03 2026 /Applications/Milagre.app/Contents/MacOS/Milagre
55108 55099 Tue Nov 10 08:32:04 2026 /Applications/Milagre.app/Contents/MacOS/Milagre
100 1 Tue Nov 10 08:32:04 2026 /private/tmp/staging/Milagre Rust Fixture.app/Contents/MacOS/milagre-rust-fixture
101 1 Tue Nov 10 08:32:04 2026 /usr/bin/unrelated`);
  assert.equal(result.length, 3);
  assert.deepEqual(result[0], {
    pid: 16468,
    parentPid: 1,
    started: "Tue Nov 10 23:32:28 2026",
    executable: "/Users/test/Applications/Milagre Rust.app/Contents/MacOS/milagre-rust",
  });
  assert.equal(result[2].parentPid, 55099);
  assert.equal(installedApplications(Array(100).fill("1 1 Tue Nov 10 08:32:04 2026 /Applications/Milagre.app/Contents/MacOS/Milagre").join("\n")).length, 16);
});
const file = { path: "/observed/preferences.json", bytes: 20, sha256: "before", mtimeMs: 1, readStable: true };
const absent = { applications: [] };
const active = { applications: [{ pid: 1 }] };
test("changed content is noisy and unattributed with or without live applications", () => {
  for (const processes of [absent, active]) {
    const result = preferenceObservation([file], [{ ...file, sha256: "after", mtimeMs: 2 }], processes, processes);
    assert.equal(result.status, "environment-noisy");
    assert.equal(result.contentUnchanged, false);
    assert.equal(result.attribution, "unattributed");
    assert.equal(result.isolationClaim, false);
  }
});
test("same bytes do not hide a metadata change or an unstable read", () => {
  for (const after of [
    { ...file, mtimeMs: 2 },
    { ...file, readStable: false },
  ]) {
    const result = preferenceObservation([file], [after], active, active);
    assert.equal(result.status, "environment-noisy");
    assert.equal(result.contentUnchanged, true);
  }
});
test("quiet observations retain the limited scope, and failed process discovery is visible", () => {
  const result = preferenceObservation([file], [file], absent, { applications: [], error: "unavailable" });
  assert.equal(result.status, "no-change-observed");
  assert.equal(result.isolationClaim, false);
  assert.equal(result.processMetadataAvailable, false);
});
test("failure summary surfaces the native stage and separates timeout termination", () => {
  const entry = {
    status: { code: 1, signal: null },
    report: { stages: [{ phase: 0, passed: false, error: "Expected one listed Chat; observed 0", send: { stage: "sidebar-after-send" } }] },
  };
  assert.deepEqual(fixtureFailure(entry), {
    reason: "Expected one listed Chat; observed 0",
    phase: 0,
    stage: "sidebar-after-send",
    exitCode: 1,
    signal: null,
    timedOut: false,
  });
  const killed = fixtureFailure({ ...entry, timedOut: true, status: { code: null, signal: "SIGKILL" } });
  assert.match(killed.reason, /external observer timeout/);
  assert.equal(killed.signal, "SIGKILL");
  assert.equal(killed.timedOut, true);
  assert.equal(fixtureFailure({ status: { code: 0 }, report: { passed: false } }).reason, "native report did not pass");
});

test("preference read detects a real file changing between its two metadata checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "milagre-observation-test-"));
  const path = join(root, "preferences.json");
  try {
    await writeFile(path, "{}");
    const stable = await preferenceFingerprint(path);
    assert.equal(stable.readStable, true);
    const changed = await preferenceFingerprint(path, {
      lstat,
      readFile: async (name) => {
        const bytes = await readFile(name);
        await writeFile(name, '{"changed":true}');
        return bytes;
      },
    });
    assert.equal(changed.sha256, stable.sha256, "returned bytes still match the first observation");
    assert.equal(changed.readStable, false, "metadata detects the concurrent write despite equal read bytes");
    assert.equal(preferenceObservation([stable], [changed], absent, absent).status, "environment-noisy");
    assert.deepEqual(await preferenceFingerprint(join(root, "missing")), { path: join(root, "missing"), absent: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("content evidence rejects lost transcripts, renderer errors and unexpected or truncated CSP reports", () => {
  const valid = {
    rendererErrorCount: 0,
    rendererErrors: [],
    violationCount: 2,
    violations: [
      { directive: "img-src", blockedURI: "https://fixture.invalid/offline-probe.png" },
      { directive: "img-src", blockedURI: "milagre-media://file/?path=/fixture-csp-canary.png" },
    ],
    retainedChat: { messageId: 11, activeChatId: "1", replyVisible: true, inViewport: true, width: 400, height: 50 },
  };
  const transcript = { sessionId: 1, assistantId: 11 };
  assert.doesNotThrow(() => assertContentHealth(valid, transcript));
  const cases = [
    [
      "reply missing",
      (value) => {
        value.retainedChat.replyVisible = false;
      },
    ],
    [
      "wrong message",
      (value) => {
        value.retainedChat.messageId = 12;
      },
    ],
    [
      "wrong Chat",
      (value) => {
        value.retainedChat.activeChatId = "2";
      },
    ],
    [
      "offscreen",
      (value) => {
        value.retainedChat.inViewport = false;
      },
    ],
    [
      "empty area",
      (value) => {
        value.retainedChat.width = 0;
      },
    ],
    [
      "error counter",
      (value) => {
        value.rendererErrorCount = 1;
      },
    ],
    [
      "recorded error",
      (value) => {
        value.rendererErrors.push("renderer failed");
      },
    ],
    [
      "truncated violations",
      (value) => {
        value.violationCount = 3;
      },
    ],
    [
      "wrong directive",
      (value) => {
        value.violations[0].directive = "connect-src";
      },
    ],
    [
      "unexpected target",
      (value) => {
        value.violations[0].blockedURI = "https://unexpected.invalid";
      },
    ],
    [
      "missing probe",
      (value) => {
        value.violations[1] = value.violations[0];
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    const value = structuredClone(valid);
    mutate(value);
    assert.throws(() => assertContentHealth(value, transcript), { name: "AssertionError" }, name);
  }
  assert.equal(
    fixtureFailure({ report: { stages: [{ passed: false, content: { stage: "retained-chat-after-content" }, send: { stage: "complete" } }] } }).stage,
    "retained-chat-after-content",
  );
});

test("an explicitly requested content run cannot pass a storage or send build", () => {
  assert.doesNotThrow(() => assertFixtureScenario({ scenario: "content" }, "content"));
  for (const scenario of [undefined, "storage", "send"]) assert.throws(() => assertFixtureScenario({ scenario }, "content"), /wrong smoke scenario/);
});
