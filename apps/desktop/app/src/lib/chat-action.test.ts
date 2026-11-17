import assert from "node:assert/strict";
import { test } from "node:test";
test("a failed Chat action surfaces its IPC cause, while successful actions stay quiet", async () => {
  const { reportChatAction } = await import("./chat-action.ts");
  const notices: string[] = [];
  await reportChatAction(Promise.reject(new Error("Error invoking remote method 'chat:patch': Error: disk full")), "Could not update Chat", (text) =>
    notices.push(text),
  );
  assert.deepEqual(notices, ["Could not update Chat: disk full"]);
  await reportChatAction(Promise.resolve(), "Could not update Chat", (text) => notices.push(text));
  assert.equal(notices.length, 1);
});
