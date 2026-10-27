import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { BabysitSettings } from "@milagre/shared/babysit";

(globalThis as { window?: unknown }).window = { milagre: {} };
const { createDebouncedSave } = await import("./babysit-settings.ts");

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

test("debounced save fires once after 500 ms", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const saves: Partial<BabysitSettings>[] = [];
    const states: string[] = [];
    const saver = createDebouncedSave(
      async (patch) => void saves.push(patch),
      undefined,
      (state) => states.push(state),
    );
    saver.edit({ instructions: "R" });
    mock.timers.tick(300);
    saver.edit({ instructions: "Run" });
    mock.timers.tick(499);
    await settle();
    assert.deepEqual(saves, [], "nothing saves while typing continues");
    mock.timers.tick(1);
    await settle();
    assert.deepEqual(saves, [{ instructions: "Run" }]);
    assert.equal(saver.state, "saved");
    assert.deepEqual(states, ["saving", "saved"]);
  } finally {
    mock.timers.reset();
  }
});

test("flush saves pending text immediately", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const saves: Partial<BabysitSettings>[] = [];
    const saver = createDebouncedSave(async (patch) => void saves.push(patch));
    saver.edit({ ownRuleText: "The PR gets the do-not-merge label" });
    await saver.flush();
    assert.deepEqual(saves, [{ ownRuleText: "The PR gets the do-not-merge label" }]);
    mock.timers.tick(1000);
    await settle();
    assert.equal(saves.length, 1, "the timer it replaced saves nothing more");
    await saver.flush();
    assert.equal(saves.length, 1, "a flush with nothing pending saves nothing");
  } finally {
    mock.timers.reset();
  }
});

test("failed save reports error state", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const states: string[] = [];
    const saver = createDebouncedSave(
      async () => {
        throw new Error("Daemon is not running");
      },
      500,
      (state) => states.push(state),
    );
    saver.edit({ instructions: "Never force-push." });
    mock.timers.tick(500);
    await settle();
    assert.equal(saver.state, "error");
    assert.deepEqual(states, ["saving", "error"]);
  } finally {
    mock.timers.reset();
  }
});
