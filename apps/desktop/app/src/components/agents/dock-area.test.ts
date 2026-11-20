import assert from "node:assert/strict";
import { test } from "node:test";
import { panelsToClose } from "./dock-area.ts";

const artifact = { name: "artifacts", width: 572, openedAt: 1 };
const simulator = { name: "simulator", width: 412, openedAt: 2 };
const changes = { name: "changes", width: 332, openedAt: 3 };

test("on a narrow window the third side panel closes the one opened first", () => {
  assert.deepEqual(panelsToClose([changes, artifact, simulator], 1100), ["artifacts"]);
  assert.deepEqual(panelsToClose([{ ...artifact, openedAt: 4 }, simulator, changes], 1100), ["simulator"]);
});

test("two side panels always stay, and a window wide enough keeps all three", () => {
  assert.deepEqual(panelsToClose([artifact, simulator], 600), []);
  assert.deepEqual(panelsToClose([artifact, simulator, changes], 1800), []);
  assert.deepEqual(panelsToClose([artifact, simulator, changes], 1700), ["artifacts"], "the chat needs 420px beside them");
});
