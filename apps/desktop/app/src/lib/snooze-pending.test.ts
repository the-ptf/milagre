import assert from "node:assert/strict";
import { test } from "node:test";

test("a Snooze or Wake moves the row before its host answers, and the host's rows take over once they agree", async () => {
  const patches: unknown[] = [];
  let answer!: (value?: unknown) => void;
  (globalThis as { window?: unknown }).window = {
    milagre: {
      patchChat: (...args: unknown[]) => {
        patches.push(args);
        return new Promise((resolve) => (answer = resolve));
      },
    },
  };
  const { inSnoozed, pendingSnoozeMarks, settleSnoozePending, snoozeChat, withSnoozePending } = await import("./snooze-pending.ts");
  const rows = [
    { id: "1", label: "One" },
    { id: "2", label: "Two", snoozedUntil: 5_000 },
  ];

  const saving = snoozeChat("/p", 1, 9_000);
  assert.deepEqual(patches.at(-1), ["/p", 1, { snoozed_until: 9_000 }]);
  const shown = withSnoozePending("/p", rows, pendingSnoozeMarks());
  assert.equal(shown[0]!.snoozedUntil, 9_000, "the row is snoozed at once");
  assert.ok(inSnoozed(shown[0]!));
  assert.equal(shown[1], rows[1], "other rows stay the same objects");
  assert.equal(withSnoozePending("/other", rows, pendingSnoozeMarks()), rows, "another scope's rows are untouched");

  answer();
  await saving;
  // The host hasn't sent its rows yet: the mark holds.
  settleSnoozePending("/p", rows);
  assert.equal(withSnoozePending("/p", rows, pendingSnoozeMarks())[0]!.snoozedUntil, 9_000);
  settleSnoozePending("/p", [{ id: "1", label: "One", snoozedUntil: 9_000 }]);
  assert.equal(pendingSnoozeMarks().size, 0);

  const waking = snoozeChat("/p", 2, null);
  assert.deepEqual(patches.at(-1), ["/p", 2, { snoozed_until: false }], "Wake clears the field");
  assert.equal(withSnoozePending("/p", rows, pendingSnoozeMarks())[1]!.snoozedUntil, undefined, "a woken row leaves Snoozed at once");
  answer();
  await waking;
  settleSnoozePending("/p", [{ id: "2", label: "Two" }]);
  assert.equal(pendingSnoozeMarks().size, 0);
});

test("Done wins over a snooze, and marking Done drops a Snooze still on its way", async () => {
  (globalThis as { window?: unknown }).window = { milagre: { patchChat: () => Promise.resolve() } };
  const { inSnoozed, pendingSnoozeMarks, snoozeChat } = await import("./snooze-pending.ts");
  const { patchChatShowingDone, settleDonePending } = await import("./done-pending.ts");
  assert.equal(inSnoozed({ id: "1", label: "One", snoozedUntil: 9_000, doneAt: 1 }), false);
  await snoozeChat("/p", 4, 9_000);
  assert.equal(pendingSnoozeMarks().get("/p#4"), 9_000);
  await patchChatShowingDone("/p", 4, { done: true });
  assert.equal(pendingSnoozeMarks().has("/p#4"), false);
  settleDonePending("/p", [{ id: "4", label: "Four", doneAt: 2 }]);
});

test("a failed Snooze puts the row back", async () => {
  (globalThis as { window?: unknown }).window = { milagre: { patchChat: () => Promise.reject(new Error("offline")) } };
  const { pendingSnoozeMarks, snoozeChat } = await import("./snooze-pending.ts");
  await assert.rejects(snoozeChat("/p", 3, 9_000), /offline/);
  assert.equal(pendingSnoozeMarks().has("/p#3"), false);
});
