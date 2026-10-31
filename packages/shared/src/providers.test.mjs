import assert from "node:assert/strict";
import test from "node:test";
import { pickerProviders } from "./providers.mjs";

const ready = { state: "ready" };
const missing = { state: "missing", message: "m" };

test("the picker hides providers whose CLI is not installed", () => {
  assert.deepEqual(pickerProviders({ codex: ready, claude: ready, antigravity: missing, kiro: missing }, "claude"), ["codex", "claude"]);
});

test("the picker keeps the current provider and other unready ones", () => {
  assert.deepEqual(pickerProviders({ codex: { state: "outdated" }, claude: ready, antigravity: missing, kiro: missing }, "antigravity"), [
    "codex",
    "claude",
    "antigravity",
  ]);
});

test("the picker keeps the open tab when its CLI goes missing", () => {
  assert.deepEqual(pickerProviders({ codex: ready, claude: ready, antigravity: missing, kiro: missing }, "codex", "antigravity"), [
    "codex",
    "claude",
    "antigravity",
  ]);
});

test("the picker shows every provider until the status is known", () => {
  assert.deepEqual(pickerProviders(null, "claude"), ["codex", "claude", "antigravity", "kiro"]);
});
