const assert = require("node:assert/strict");
const test = require("node:test");
const { CANCELLED_MESSAGE } = require("./permissions.cjs");
const {
  DISMISSED_MESSAGE,
  UNSHOWN_MESSAGE,
  PendingQuestions,
  claudeQuestionRequest,
  claudeQuestionResult,
  codexQuestionRequest,
  codexQuestionResponse,
  validAnswers,
  answerImages,
  withAnswerImages,
} = require("./questions.cjs");

const colors = {
  id: "0",
  header: "Color",
  question: "Which color?",
  options: [{ label: "Red" }, { label: "Green" }],
  multiSelect: false,
  allowOther: true,
  secret: false,
};
const sizes = {
  id: "1",
  header: "Size",
  question: "Which size?",
  options: [{ label: "S" }, { label: "L" }],
  multiSelect: true,
  allowOther: true,
  secret: false,
};

function pending() {
  const events = [];
  const settled = [];
  const questions = new PendingQuestions((event) => events.push(event));
  const ask = (requestId, asked = [colors, sizes]) =>
    questions.add({ requestId, questions: asked }, (outcome, answers) => settled.push({ requestId, outcome, answers }));
  return { questions, events, settled, ask };
}

test("each question is announced, then settled exactly once with the answers it asked for", () => {
  const { questions, events, settled, ask } = pending();
  ask("a");
  assert.equal(questions.size, 1);
  assert.equal(questions.answer("a", { 0: [" Green "], 1: ["S", "", "  "], other: ["x"] }), true);
  assert.equal(questions.answer("a", { 0: ["Red"] }), false);
  assert.equal(questions.answer("missing", null), false);
  assert.deepEqual(settled, [{ requestId: "a", outcome: "answered", answers: { 0: ["Green"], 1: ["S"] } }]);
  assert.deepEqual(events, [
    { type: "question-request", requestId: "a", questions: [colors, sizes] },
    { type: "question-resolved", requestId: "a", outcome: "answered" },
  ]);
  assert.equal(questions.size, 0);
});

test("no answers, or only blank ones, dismiss the question", () => {
  const { questions, settled, ask } = pending();
  ask("a");
  ask("b");
  questions.answer("a", null);
  questions.answer("b", { 0: ["  "], other: ["Green"] });
  assert.deepEqual(
    settled.map(({ outcome, answers }) => ({ outcome, answers })),
    [
      { outcome: "dismissed", answers: {} },
      { outcome: "dismissed", answers: {} },
    ],
  );
});

test("dismissAll and cancelAll settle every open question", () => {
  const { questions, events, settled, ask } = pending();
  ask("a");
  ask("b");
  questions.dismissAll();
  ask("c");
  questions.cancel("c");
  assert.equal(questions.cancel("c"), false);
  ask("d");
  questions.cancelAll();
  assert.deepEqual(
    settled.map(({ requestId, outcome }) => `${requestId}:${outcome}`),
    ["a:dismissed", "b:dismissed", "c:cancelled", "d:cancelled"],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "question-resolved").map((event) => event.outcome),
    ["dismissed", "dismissed", "cancelled", "cancelled"],
  );
  assert.equal(questions.size, 0);
});

test("forget drops a withdrawn question without settling it", () => {
  const { questions, events, settled, ask } = pending();
  ask("a");
  assert.equal(questions.forget("a"), true);
  assert.equal(questions.forget("a"), false);
  assert.deepEqual(settled, []);
  assert.deepEqual(events.at(-1), { type: "question-resolved", requestId: "a", outcome: "cancelled" });
});

const claudeInput = {
  questions: [
    {
      question: "Which color?",
      header: "Color",
      options: [
        { label: "Red", description: "Warm" },
        { label: "Green", description: "" },
      ],
      multiSelect: false,
    },
    {
      question: "Which sizes?",
      header: "Size",
      options: [
        { label: "S", description: "Small" },
        { label: "L", description: "Large" },
      ],
      multiSelect: true,
    },
  ],
};

test("Claude: AskUserQuestion becomes a request with one id per position", () => {
  assert.deepEqual(claudeQuestionRequest(claudeInput, { requestId: "r1", toolUseID: "t1" }), {
    requestId: "r1",
    questions: [
      {
        id: "0",
        header: "Color",
        question: "Which color?",
        options: [{ label: "Red", description: "Warm" }, { label: "Green" }],
        multiSelect: false,
        allowOther: true,
        secret: false,
      },
      {
        id: "1",
        header: "Size",
        question: "Which sizes?",
        options: [
          { label: "S", description: "Small" },
          { label: "L", description: "Large" },
        ],
        multiSelect: true,
        allowOther: true,
        secret: false,
      },
    ],
  });
  assert.equal(claudeQuestionRequest(claudeInput, { toolUseID: "t1" }).requestId, "t1");
  assert.equal(claudeQuestionRequest({ questions: [] }, { requestId: "r" }), null);
  assert.equal(claudeQuestionRequest({}, { requestId: "r" }), null);
  assert.equal(claudeQuestionRequest({ questions: [{ header: "x", options: [] }] }, { requestId: "r" }), null);
});

test("Claude: answers are keyed by question text, several picks joined as Claude's own dialog does", () => {
  assert.deepEqual(claudeQuestionResult("answered", claudeInput, { 0: ["Purple"], 1: ["S", "L"] }), {
    behavior: "allow",
    updatedInput: { ...claudeInput, answers: { "Which color?": "Purple", "Which sizes?": "S, L" } },
  });
  assert.deepEqual(claudeQuestionResult("answered", claudeInput, { 1: ["L"] }).updatedInput.answers, { "Which sizes?": "L" });
  assert.deepEqual(claudeQuestionResult("dismissed", claudeInput), { behavior: "deny", message: DISMISSED_MESSAGE });
  assert.deepEqual(claudeQuestionResult("cancelled", claudeInput), { behavior: "deny", message: CANCELLED_MESSAGE, interrupt: true });
  assert.deepEqual(claudeQuestionResult("unshown", claudeInput), { behavior: "deny", message: UNSHOWN_MESSAGE });
});

test("Codex: requestUserInput becomes a request keyed by Codex's own ids", () => {
  const params = {
    threadId: "th",
    turnId: "tu",
    itemId: "call-1",
    isBlocking: false,
    autoResolutionMs: null,
    questions: [
      {
        id: "color",
        header: "Color",
        question: "Which color?",
        isOther: false,
        isSecret: false,
        options: [
          { label: "Red", description: "Warm" },
          { label: "Green", description: "" },
        ],
      },
      { id: "token", header: "Token", question: "Paste your token", isOther: false, isSecret: true, options: null },
      { id: "", header: "Broken", question: "No id", isOther: true, isSecret: false, options: null },
    ],
  };
  assert.deepEqual(codexQuestionRequest(7, params), {
    requestId: "7",
    questions: [
      {
        id: "color",
        header: "Color",
        question: "Which color?",
        options: [{ label: "Red", description: "Warm" }, { label: "Green" }],
        multiSelect: false,
        allowOther: false,
        secret: false,
      },
      { id: "token", header: "Token", question: "Paste your token", options: [], multiSelect: false, allowOther: true, secret: true },
    ],
  });
  assert.equal(codexQuestionRequest(8, { questions: [] }), null);
  assert.equal(codexQuestionRequest(9, {}), null);
});

test("Codex: answers go back per question id, and anything else is no answer", () => {
  assert.deepEqual(codexQuestionResponse("answered", { color: ["Green"], token: ["abc"] }), {
    answers: { color: { answers: ["Green"] }, token: { answers: ["abc"] } },
  });
  assert.deepEqual(codexQuestionResponse("dismissed"), { answers: {} });
  assert.deepEqual(codexQuestionResponse("cancelled"), { answers: {} });
});

test("only null or a few short strings per question id count as answers", () => {
  assert.equal(validAnswers(null), true);
  assert.equal(validAnswers({}), true);
  assert.equal(validAnswers({ 0: ["Green", "my own answer"] }), true);
  for (const bad of [
    undefined,
    "Green",
    ["Green"],
    { 0: "Green" },
    { 0: [1] },
    { 0: ["x".repeat(10_001)] },
    { 0: Array(21).fill("x") },
    Object.fromEntries(Array.from({ length: 11 }, (_, index) => [String(index), ["x"]])),
  ]) {
    assert.equal(validAnswers(bad), false, JSON.stringify(bad)?.slice(0, 40));
  }
});

test("images on answers: the agent reads each path in its question's answer, the card counts them", () => {
  assert.deepEqual(answerImages(undefined), {});
  assert.deepEqual(answerImages({ a: [], b: [{ dataUrl: "x" }] }), { b: [{ dataUrl: "x" }] });
  assert.throws(() => answerImages([]), /Invalid images/);
  assert.throws(() => answerImages({ a: "x" }), /Invalid images/);
  assert.throws(() => answerImages({ a: Array.from({ length: 11 }, () => ({})) }), /at most 10/);
  const { agent, shown } = withAnswerImages({ a: ["Grid"], b: [] }, { a: [{ path: "/p/1.png" }], b: [{ path: "/p/2.png" }, { path: "/p/3.png" }] });
  assert.deepEqual(agent, {
    a: ["Grid", "Image the user attached: /p/1.png (open the file to see it)"],
    b: ["Image the user attached: /p/2.png (open the file to see it)", "Image the user attached: /p/3.png (open the file to see it)"],
  });
  assert.deepEqual(shown, { a: ["Grid", "1 image"], b: ["2 images"] });
});
