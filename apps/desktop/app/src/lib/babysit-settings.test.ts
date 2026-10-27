import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { BABYSIT_DEFAULTS, type BabysitSettings } from "@milagre/shared/babysit";
import type { MilagreBridge } from "../electron.d.ts";

(globalThis as { window?: unknown }).window = { milagre: {} };
const { babysitSettingsStore, createDebouncedSave } = await import("./babysit-settings.ts");

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

test("a flush that overlaps a slower one reports saved only when both have landed", async () => {
  const answers: Array<() => void> = [];
  const states: string[] = [];
  const saver = createDebouncedSave(
    () => new Promise<void>((resolve) => answers.push(resolve)),
    500,
    (state) => states.push(state),
  );
  saver.edit({ instructions: "Run" });
  const first = saver.flush();
  saver.edit({ instructions: "Run bun check" });
  const second = saver.flush();
  answers[0]();
  await first;
  assert.equal(saver.state, "saving", "the first answer does not mark the newer text saved");
  answers[1]();
  await second;
  assert.equal(saver.state, "saved");
  assert.deepEqual(states, ["saving", "saving", "saved"]);
});

/** A host whose saves answer only when the test says, merging like babysit-settings.cjs. */
function host() {
  let stored: BabysitSettings = { ...BABYSIT_DEFAULTS, wake: [...BABYSIT_DEFAULTS.wake] };
  const answers: Array<{ ok: () => void; fail: (message: string) => void }> = [];
  const fake = {
    readBabysitSettings: async () => stored,
    saveBabysitSettings: (patch: Partial<BabysitSettings>) =>
      new Promise<BabysitSettings>((resolve, reject) =>
        answers.push({
          ok: () => {
            stored = { ...stored, ...patch };
            resolve(stored);
          },
          fail: (message) => reject(new Error(message)),
        }),
      ),
    onBabysitSettings: () => () => {},
  } as unknown as MilagreBridge;
  return { fake, answers };
}

test("overlapping saves keep the newer optimistic change", async () => {
  const { fake, answers } = host();
  const store = babysitSettingsStore(fake);
  const stop = store.subscribe(() => {});
  await settle();
  const enable = store.save({ enabled: true });
  const wake = store.save((current) => ({ wake: [...current.wake, "behind"] }));
  assert.deepEqual(store.snapshot().settings?.wake, ["comments", "checks", "conflicts", "behind"]);
  answers[0].ok();
  await enable;
  assert.equal(store.snapshot().settings?.enabled, true);
  assert.deepEqual(store.snapshot().settings?.wake, ["comments", "checks", "conflicts", "behind"], "the first answer does not undo the second change");
  // A change made now builds on both, not on the first answer alone.
  const days = store.save((current) => ({ stopAfterDays: { ...current.stopAfterDays, days: 14 } }));
  answers[1].ok();
  answers[2].ok();
  await Promise.all([wake, days]);
  assert.deepEqual(
    { enabled: store.snapshot().settings?.enabled, wake: store.snapshot().settings?.wake, days: store.snapshot().settings?.stopAfterDays },
    { enabled: true, wake: ["comments", "checks", "conflicts", "behind"], days: { on: true, days: 14 } },
  );
  stop();
});

test("a failed save goes back and keeps the changes still on their way", async () => {
  const { fake, answers } = host();
  const store = babysitSettingsStore(fake);
  const stop = store.subscribe(() => {});
  await settle();
  const enable = store.save({ enabled: true });
  const level = store.save({ level: 5 });
  answers[0].fail("Daemon is not running");
  await assert.rejects(enable, /Daemon is not running/);
  assert.equal(store.snapshot().settings?.enabled, false, "the failed change goes back");
  assert.equal(store.snapshot().settings?.level, 5, "the change still on its way stays");
  assert.equal(store.snapshot().error, "Daemon is not running");
  answers[1].ok();
  await level;
  assert.equal(store.snapshot().settings?.level, 5);
  stop();
});

test("cancel drops typed text and a save already on its way no longer marks the field", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const answers: Array<() => void> = [];
    const saves: Partial<BabysitSettings>[] = [];
    const states: string[] = [];
    const saver = createDebouncedSave(
      (patch) => {
        saves.push(patch);
        return new Promise<void>((resolve) => answers.push(resolve));
      },
      500,
      (state) => states.push(state),
    );
    saver.edit({ instructions: "Run" });
    const first = saver.flush();
    saver.edit({ instructions: "Run bun" });
    saver.cancel();
    mock.timers.tick(1000);
    await settle();
    assert.deepEqual(saves, [{ instructions: "Run" }], "the text typed after it is dropped");
    answers[0]!();
    await first;
    assert.deepEqual(states, ["saving"], "the answer from before Reset marks nothing");
    // A later edit saves and marks as usual.
    saver.edit({ instructions: "Never force-push." });
    const next = saver.flush();
    answers[1]!();
    await next;
    assert.equal(saver.state, "saved");
  } finally {
    mock.timers.reset();
  }
});
