import { test } from "node:test";
import assert from "node:assert/strict";
import { activityContent } from "./live-activity.mjs";

const question = (extra = {}) => ({
  id: "q",
  header: "Scope",
  question: "Add the Share menu flow too?",
  options: [{ label: "Add it (Recommended)" }, { label: "Later" }],
  multiSelect: false,
  secret: false,
  allowOther: true,
  ...extra,
});
const pending = (extra = {}) => ({
  target: "target-1",
  chatId: "/repo#1",
  title: "Screenshot paste",
  at: 20,
  kind: "question",
  request: { requestId: "r", questions: [question()] },
  answers: {},
  ...extra,
});
const chat = (extra = {}) => ({ key: "/repo#1", title: "Screenshot paste", working: true, subagents: [], ...extra });

test("counts active children once and excludes completed and archived children", () => {
  const c = activityContent({
    chats: [
      chat({
        subagents: [
          { id: "a", status: "running" },
          { id: "a", status: "running" },
          { id: "b", status: "completed" },
          { id: "c", status: "running", archived: true },
        ],
      }),
    ],
    pending: [],
    now: 100,
  });
  assert.equal(c.runningCount, 2);
  assert.equal(c.rows[0].status, "Working");
});
test("selects the oldest request, independent of the Chat order", () => {
  const c = activityContent({ chats: [], pending: [pending(), pending({ target: "older", at: 10, title: "Chat history" })], now: 100 });
  assert.equal(c.question.target, "older");
  assert.equal(c.waitingCount, 2);
});
test("preserves option indices and removes only the display recommendation suffix", () => {
  const c = activityContent({ chats: [], pending: [pending()], now: 100 });
  assert.deepEqual(c.question.choices, [
    { index: 0, label: "Add it" },
    { index: 1, label: "Later" },
  ]);
  assert.equal(c.question.canAnswer, true);
});
test("redacts secret questions and choices from the complete serialized payload", () => {
  const c = activityContent({
    chats: [],
    pending: [
      pending({ request: { requestId: "r", questions: [question({ secret: true, question: "Private token: SECRET", options: [{ label: "SECRET" }] })] } }),
    ],
    now: 100,
  });
  assert.equal(c.question.text, "Input needed in Chat");
  assert.equal(c.question.canAnswer, false);
  assert.equal(JSON.stringify(c).includes("SECRET"), false);
});
test("a secret-use approval can't be answered from the Lock Screen and doesn't show its command", () => {
  const c = activityContent({
    chats: [],
    pending: [
      pending({
        request: {
          requestId: "milagre-secret-1",
          questions: [question({ question: "Let the agent use DEPLOY_TOKEN for this command? curl x", options: [{ label: "Allow" }, { label: "Deny" }] })],
        },
      }),
    ],
    now: 100,
  });
  assert.equal(c.question.canAnswer, false);
  assert.equal(JSON.stringify(c).includes("DEPLOY_TOKEN"), false);
});
test("advances multi-question drafts without marking them accepted", () => {
  const c = activityContent({
    chats: [],
    pending: [
      pending({
        request: { requestId: "r", questions: [question(), question({ id: "q2", question: "Which tests?" })] },
        answers: { q: ["Add it (Recommended)"] },
      }),
    ],
    now: 100,
  });
  assert.equal(c.question.position, 2);
  assert.equal(c.question.total, 2);
  assert.equal(c.question.text, "Which tests?");
});
test("opens Chat for multi-select and long choice labels instead of changing their meaning", () => {
  for (const q of [question({ multiSelect: true }), question({ options: [{ label: "Apply every change including the production deployment" }] })]) {
    const c = activityContent({ chats: [], pending: [pending({ request: { requestId: "r", questions: [q] } })], now: 100 });
    assert.equal(c.question.canAnswer, false);
    assert.deepEqual(c.question.choices, []);
  }
});
test("bounds Unicode presentation data below the APNs payload budget", () => {
  const c = activityContent({
    chats: Array.from({ length: 20 }, (_, i) => chat({ key: String(i), title: "界".repeat(5000) })),
    pending: [pending({ title: "界".repeat(5000), request: { requestId: "r", questions: [question({ question: "界".repeat(5000) })] } })],
    now: 100,
  });
  assert.equal(c.rows.length, 3);
  assert.equal(c.runningCount, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(c)) < 3000);
});
test("long questions open Chat without offering answers to an incomplete preview", () => {
  for (const text of ["a".repeat(121), "界".repeat(121)]) {
    const c = activityContent({ pending: [pending({ request: { requestId: "r", questions: [question({ question: text })] } })] });
    assert.equal(Array.from(c.question.text).length, 120);
    assert.equal(c.question.canAnswer, false);
    assert.deepEqual(c.question.choices, []);
  }
  const c = activityContent({ pending: [pending({ request: { requestId: "r", questions: [question({ question: "界".repeat(120) })] } })] });
  assert.equal(c.question.canAnswer, true);
});
test("does not turn permission requests into answer buttons", () => {
  const c = activityContent({ chats: [], pending: [pending({ kind: "approval", request: undefined })], now: 100 });
  assert.equal(c.question.text, "Approval needed in Chat");
  assert.equal(c.question.canAnswer, false);
});
test("questions-only mode removes running details but keeps waiting questions", () => {
  const waiting = activityContent({ chats: [chat()], pending: [pending()], mode: "questions" });
  assert.equal(waiting.runningCount, 0);
  assert.deepEqual(waiting.rows, []);
  assert.equal(waiting.waitingCount, 1);
  assert.equal(waiting.question.text, "Add the Share menu flow too?");
  const running = activityContent({ chats: [chat()], mode: "questions" });
  assert.equal(running.runningCount, 0);
  assert.equal(running.waitingCount, 0);
  assert.equal(running.question, null);
});
