import { test } from "node:test";
import assert from "node:assert/strict";
import { allowQuestion } from "./pending-computers.ts";
import { thisComputer } from "./shortcut-hints.ts";

test("the prompt names the computer that asks, or says a computer when it sent no name", () => {
  assert.equal(allowQuestion({ name: "studio" }), `studio wants to drive ${thisComputer}'s chats`);
  assert.equal(allowQuestion({ name: null }), `A computer wants to drive ${thisComputer}'s chats`);
});
