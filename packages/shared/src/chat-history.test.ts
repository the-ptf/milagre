import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "./model.ts";
import { chatHistory } from "./chat-history.ts";

test("streaming consumers reuse the completed history and refresh after a saved message changes", () => {
  let reads = 0;
  const messages: ChatMessage[] = [
    { id: 1, session_id: 1, role: "user", body: "Continue", context: null },
    {
      id: 2,
      session_id: 1,
      role: "assistant",
      body: "Done",
      context: null,
      get steps() {
        reads++;
        return [];
      },
    },
  ];
  const first = chatHistory(messages);
  for (let i = 0; i < 100; i++) assert.equal(chatHistory(messages), first);
  assert.equal(reads, 1, "completed messages are not scanned again on live ticks");
  assert.deepEqual(first.promptHistory, ["Continue"]);
  const changed = chatHistory([...messages, { id: 3, session_id: 1, role: "user", body: "Next", context: null }]);
  assert.notEqual(changed, first);
  assert.deepEqual(changed.promptHistory, ["Continue", "Next"]);
  assert.deepEqual(first.promptHistory, ["Continue"], "another Chat cannot mutate an existing projection");
});

test("prompt history omits host context, blanks and consecutive duplicates without omitting design feedback", () => {
  const messages = ["A", "A", "", "B"].map((body, id) => ({ id, session_id: 1, role: "user" as const, body, context: null }));
  const history = chatHistory(messages);
  assert.deepEqual(history.promptHistory, ["A", "B"]);
  assert.deepEqual(
    history.userMessages.map((m) => m.body),
    ["A", "A", "", "B"],
  );
});
