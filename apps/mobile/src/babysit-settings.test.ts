import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { BABYSIT_DEFAULTS, type BabysitSettings } from "@milagre/shared/babysit";
import { babysitSettingsStore, createDebouncedSave, type BabysitHost, type BabysitState } from "./babysit-settings.ts";

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** A Mac whose saves answer only when the test says, merging like babysit-settings.cjs. */
function mac(first: BabysitSettings | null = { ...BABYSIT_DEFAULTS, wake: [...BABYSIT_DEFAULTS.wake] }) {
  let stored = first;
  const answers: { ok: () => void; fail: (message: string) => void }[] = [];
  const reads: (() => void)[] = [];
  let holdReads = false;
  const host: BabysitHost = {
    read: () =>
      holdReads
        ? new Promise((resolve) => {
            const value = stored;
            reads.push(() => resolve(value));
          })
        : Promise.resolve(stored),
    save: (patch) =>
      new Promise<BabysitSettings>((resolve, reject) =>
        answers.push({
          ok: () => {
            stored = { ...(stored as BabysitSettings), ...patch };
            resolve(stored);
          },
          fail: (message) => reject(new Error(message)),
        }),
      ),
  };
  return { host, answers, reads, hold: () => (holdReads = true) };
}

test("overlapping saves keep the newer change shown", async () => {
  const { host, answers } = mac();
  const states: BabysitState[] = [];
  const store = babysitSettingsStore((state) => states.push(state));
  await store.read(host);
  const enable = store.save(host, { enabled: true });
  const wake = store.save(host, (current) => ({ wake: [...current.wake, "behind"] }));
  assert.deepEqual(store.snapshot().settings?.wake, ["comments", "checks", "conflicts", "behind"]);
  answers[0]!.ok();
  await enable;
  assert.equal(store.snapshot().settings?.enabled, true);
  assert.deepEqual(store.snapshot().settings?.wake, ["comments", "checks", "conflicts", "behind"], "the first answer does not undo the second change");
  // A change made now builds on both, not on the first answer alone; the whole rule object goes out.
  const days = store.save(host, (current) => ({ stopAfterDays: { ...current.stopAfterDays, days: 14 } }));
  answers[1]!.ok();
  answers[2]!.ok();
  await Promise.all([wake, days]);
  assert.deepEqual(
    { enabled: store.snapshot().settings?.enabled, wake: store.snapshot().settings?.wake, days: store.snapshot().settings?.stopAfterDays },
    { enabled: true, wake: ["comments", "checks", "conflicts", "behind"], days: { on: true, days: 14 } },
  );
  assert.equal(states.at(-1), store.snapshot(), "each change reaches the screen");
});

test("a failed save goes back, keeps the changes still on their way and says why", async () => {
  const { host, answers } = mac();
  const store = babysitSettingsStore(() => {});
  await store.read(host);
  const enable = store.save(host, { enabled: true });
  const level = store.save(host, { level: 5 });
  answers[0]!.fail("Daemon is not running");
  await assert.rejects(enable, /Daemon is not running/);
  assert.equal(store.snapshot().settings?.enabled, false, "the failed change goes back");
  assert.equal(store.snapshot().settings?.level, 5, "the change still on its way stays");
  assert.equal(store.snapshot().error, "Daemon is not running");
  answers[1]!.ok();
  await level;
  assert.equal(store.snapshot().settings?.level, 5);
  assert.equal(store.snapshot().error, "Daemon is not running", "a later success leaves the error until the next change");
});

test("a read that started before a save answered does not undo it", async () => {
  const { host, answers, reads, hold } = mac();
  const store = babysitSettingsStore(() => {});
  await store.read(host);
  hold();
  const reading = store.read(host);
  const enable = store.save(host, { enabled: true });
  answers[0]!.ok();
  await enable;
  reads[0]!();
  await reading;
  assert.equal(store.snapshot().settings?.enabled, true);
});

test("an older Mac answers null and a refused read shows an error", async () => {
  const older = babysitSettingsStore(() => {});
  const { host } = mac(null);
  await older.read(host);
  assert.deepEqual(older.snapshot(), { settings: null, error: "", unsupported: true });
  await older.save(host, { enabled: true });
  assert.equal(older.snapshot().settings, null, "nothing read: nothing to change");
  const refused = babysitSettingsStore(() => {});
  await refused.read({ read: () => Promise.reject(new Error("offline")), save: () => Promise.reject(new Error("offline")) });
  assert.equal(refused.snapshot().error, "Could not read the Babysit PRs settings.");
});

test("debounced save fires once after 500 ms, and flush saves at once", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const saves: Partial<BabysitSettings>[] = [];
    const states: string[] = [];
    const saver = createDebouncedSave(
      async (patch) => void saves.push(patch),
      500,
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
    assert.deepEqual(states, ["saving", "saved"]);
    saver.edit({ instructions: "Run bun check" });
    await saver.flush();
    assert.deepEqual(saves.at(-1), { instructions: "Run bun check" });
    mock.timers.tick(1000);
    await settle();
    assert.equal(saves.length, 2, "the timer the flush replaced saves nothing more");
  } finally {
    mock.timers.reset();
  }
});

test("an overlapping flush reports saved only when both have landed, and a failure as error", async () => {
  const answers: { ok: () => void; fail: () => void }[] = [];
  const saver = createDebouncedSave(() => new Promise<void>((ok, fail) => answers.push({ ok, fail: () => fail(new Error("no")) })), 500);
  saver.edit({ instructions: "Run" });
  const first = saver.flush();
  saver.edit({ instructions: "Run bun check" });
  const second = saver.flush();
  answers[0]!.ok();
  await first;
  assert.equal(saver.state, "saving", "the first answer does not mark the newer text saved");
  answers[1]!.ok();
  await second;
  assert.equal(saver.state, "saved");
  saver.edit({ instructions: "x" });
  const third = saver.flush();
  answers[2]!.fail();
  await third;
  assert.equal(saver.state, "error");
});

test("cancel drops typed text and a save already on its way no longer marks the field", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const answers: (() => void)[] = [];
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
