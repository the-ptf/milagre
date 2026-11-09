import { test } from "node:test";
import assert from "node:assert/strict";
import { confirm, confirmSheet, confirmationsSettled, currentConfirmation, setConfirmPresenter } from "./confirm-store.ts";

test("a confirmation waits in the store until the sheet answers it", async () => {
  let shown = 0;
  setConfirmPresenter(() => {
    shown++;
  });
  const answer = confirm("Remove Blog?", "Its folder stays.", "Remove");
  assert.equal(shown, 1);
  const entry = currentConfirmation()!;
  assert.deepEqual(
    entry.buttons.map((button) => [button.text, button.style]),
    [
      ["Remove", "destructive"],
      ["Cancel", "cancel"],
    ],
  );
  entry.choose(0);
  assert.equal(await answer, true);
  assert.equal(currentConfirmation(), null);
});

test("a dismissed sheet runs Cancel once, and a newer question dismisses the older one", async () => {
  setConfirmPresenter(() => {});
  const first = confirm("First?", undefined, "Go");
  const second = confirm("Second?", undefined, "Go");
  assert.equal(await first, false);
  const entry = currentConfirmation()!;
  entry.choose(null);
  entry.choose(0);
  assert.equal(await second, false);
});

test("a dismissed alert without Cancel calls onDismiss", () => {
  setConfirmPresenter(() => {});
  let dismissed = 0;
  confirmSheet("Heads up", undefined, [{ text: "OK" }], {
    onDismiss: () => {
      dismissed++;
    },
  });
  currentConfirmation()!.choose(null);
  assert.equal(dismissed, 1);
});

test("confirmationsSettled waits for the open question's answer, not for one that replaces it", async () => {
  setConfirmPresenter(() => {});
  await confirmationsSettled();
  let settled = false;
  void confirm("Delete Link?", undefined, "Delete");
  const waiting = confirmationsSettled().then(() => (settled = true));
  await Promise.resolve();
  assert.equal(settled, false);
  currentConfirmation()!.choose(1);
  await waiting;
  assert.equal(settled, true);
  assert.equal(currentConfirmation(), null);
});
