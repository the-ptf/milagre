import assert from "node:assert/strict";
import test from "node:test";
import { installableProviders, pickerProviders, startingProvider } from "./providers.mjs";

const ready = { state: "ready" };
const missing = { state: "missing", message: "m" };

test("the picker hides providers whose CLI is not installed", () => {
  assert.deepEqual(pickerProviders({ codex: ready, claude: ready, antigravity: missing, kiro: missing, pi: missing }, "claude"), ["codex", "claude"]);
});

test("the picker keeps the current provider and other unready ones", () => {
  assert.deepEqual(pickerProviders({ codex: { state: "outdated" }, claude: ready, antigravity: missing, kiro: missing, pi: missing }, "antigravity"), [
    "codex",
    "claude",
    "antigravity",
  ]);
});

test("the picker keeps the open tab when its CLI goes missing", () => {
  assert.deepEqual(pickerProviders({ codex: ready, claude: ready, antigravity: missing, kiro: missing, pi: missing }, "codex", "antigravity"), [
    "codex",
    "claude",
    "antigravity",
  ]);
});

test("the picker shows every provider until the status is known, except Pi, which waits for it", () => {
  assert.deepEqual(pickerProviders(null, "claude"), ["codex", "claude", "antigravity", "kiro"]);
  assert.deepEqual(pickerProviders({ codex: ready, claude: ready }, "claude"), ["codex", "claude", "antigravity", "kiro"]);
  assert.deepEqual(pickerProviders({ codex: ready, claude: ready, pi: { state: "logged-out" } }, "claude"), ["codex", "claude", "antigravity", "kiro", "pi"]);
  assert.deepEqual(pickerProviders(null, "pi"), ["codex", "claude", "antigravity", "kiro", "pi"]);
});

test("a new Chat leaves a saved default whose CLI this computer lacks for the first provider it has", () => {
  assert.equal(startingProvider("pi", { codex: ready, claude: ready, pi: missing }), "codex");
  assert.equal(startingProvider("pi", { codex: ready, pi: ready }), "pi");
  assert.equal(startingProvider("pi", null), "pi");
  assert.equal(startingProvider("claude", { codex: missing, claude: ready }), "claude");
});

test("a missing Pi is offered to install instead of shown as a tab", () => {
  assert.deepEqual(installableProviders({ codex: ready, pi: missing }), ["pi"]);
  assert.deepEqual(installableProviders({ codex: ready, pi: ready }), []);
  assert.deepEqual(installableProviders(null), []);
});
