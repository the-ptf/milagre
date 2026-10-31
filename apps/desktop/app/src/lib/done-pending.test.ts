import assert from "node:assert/strict";
import { test } from "node:test";

test("a Done or Reopen moves the row before its host answers, and the host's rows take over once they agree", async () => {
  let answer!: (value?: unknown) => void;
  (globalThis as { window?: unknown }).window = {
    milagre: { patchChat: () => new Promise((resolve) => (answer = resolve)) },
  };
  const { patchChatShowingDone, pendingDoneMarks, settleDonePending, withDonePending } = await import("./done-pending.ts");
  const rows = [
    { id: "1", label: "One" },
    { id: "2", label: "Two", doneAt: 5 },
  ];

  const saving = patchChatShowingDone("/p", 1, { done: true, unread: false });
  const shown = withDonePending("/p", rows, pendingDoneMarks());
  assert.ok(shown[0]!.doneAt, "the row is Done at once");
  assert.equal(shown[1], rows[1], "other rows stay the same objects");
  assert.equal(withDonePending("/other", rows, pendingDoneMarks()), rows, "another scope's rows are untouched");

  answer();
  await saving;
  // The host hasn't sent its rows yet: the mark holds.
  settleDonePending("/p", rows);
  assert.ok(withDonePending("/p", rows, pendingDoneMarks())[0]!.doneAt);
  // Its rows now agree: the mark goes, so a later reopen on the host shows.
  settleDonePending("/p", [{ id: "1", label: "One", doneAt: 9 }]);
  assert.equal(pendingDoneMarks().size, 0);

  const reopening = patchChatShowingDone("/p", 2, { done: false });
  assert.equal(withDonePending("/p", rows, pendingDoneMarks())[1]!.doneAt, undefined, "a reopened row leaves Done at once");
  answer();
  await reopening;
  settleDonePending("/p", [{ id: "2", label: "Two" }]);
  assert.equal(pendingDoneMarks().size, 0);
});

test("a failed Done puts the row back", async () => {
  (globalThis as { window?: unknown }).window = { milagre: { patchChat: () => Promise.reject(new Error("offline")) } };
  const { patchChatShowingDone, pendingDoneMarks } = await import("./done-pending.ts");
  await assert.rejects(patchChatShowingDone("/p", 3, { done: true }), /offline/);
  assert.equal(pendingDoneMarks().has("/p#3"), false);
});
