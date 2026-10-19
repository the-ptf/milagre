import { test } from "node:test";
import assert from "node:assert/strict";
import { canOpenRunChat } from "./run-chats.ts";

test("a Run's Chat opens while its held Project has it, archived or not, and not once it is gone", () => {
  const states = { "/p": { sessions: { 4: { id: 4 }, 5: { id: 5, archived: true } } } };
  assert.equal(canOpenRunChat(states, "/p#4"), true);
  assert.equal(canOpenRunChat(states, "/p#5"), true);
  assert.equal(canOpenRunChat(states, "/p#6"), false);
});

test("a Run's Chat in a Project the phone holds no state for opens, and the Chat screen loads that Project", () => {
  assert.equal(canOpenRunChat({}, "/q#4"), true);
  assert.equal(canOpenRunChat({ "/p": { sessions: {} } }, "/q#4"), true);
});
