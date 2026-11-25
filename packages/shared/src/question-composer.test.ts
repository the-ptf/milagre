import assert from "node:assert/strict";
import { test } from "node:test";
import type { QuestionRequest } from "./model.ts";
import { answerPlaceholder, asksInComposer } from "./question-composer.ts";

const question = { id: "q", header: "Pick", question: "Which one?", options: [{ label: "A" }], multiSelect: false, allowOther: true, secret: false };

test("ordinary questions are asked in the composer; secrets, bug reports and masked questions keep their card", () => {
  const ordinary: QuestionRequest = { requestId: "1", questions: [question] };
  assert.equal(asksInComposer(ordinary), true);
  assert.equal(asksInComposer({ ...ordinary, secretRequest: { description: "Token" } }), false);
  assert.equal(asksInComposer({ ...ordinary, bugReport: { repo: "o/r", title: "t", body: "b" } }), false);
  assert.equal(asksInComposer({ requestId: "2", questions: [question, { ...question, id: "p", secret: true }] }), false);
});

test("the prompt's placeholder says what typing does for the question", () => {
  assert.equal(answerPlaceholder(question), "Or type your own answer…");
  assert.equal(answerPlaceholder({ options: [], allowOther: true }), "Type your answer…");
  assert.equal(answerPlaceholder({ options: [{ label: "A" }], allowOther: false }), "Choose an option above");
});
