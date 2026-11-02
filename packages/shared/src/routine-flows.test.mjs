import assert from "node:assert/strict";
import test from "node:test";
import {
  checkFlowSteps,
  checkOutput,
  fieldsBefore,
  fillTemplate,
  flattenSteps,
  flowChanges,
  flowProblems,
  flowRunText,
  insertStep,
  moveStep,
  newStep,
  newStepId,
  removeStep,
  runRows,
  testCondition,
  triggerValues,
  usedBy,
} from "./routine-flows.mjs";

// The pilot: Linear label -> Classify -> If large (Ask) -> Implement -> Open pull request -> Review.
const pilot = () => [
  {
    id: "classify",
    name: "Classify",
    kind: "agent",
    prompt: "Read {{trigger.issue.title}} and {{trigger.issue.description}}.",
    chat: "run",
    output: [
      { name: "complexity", type: "choice", choices: ["small", "medium", "large"] },
      { name: "area", type: "text" },
    ],
    retries: 2,
    onInvalid: "ask-once",
  },
  {
    id: "if-large",
    name: "If",
    kind: "if",
    field: "classify.complexity",
    test: "is",
    value: "large",
    yes: [{ id: "ask", name: "Ask before implementing", kind: "ask", message: "{{classify.area}}", expiresInHours: 24 }],
    otherwise: [],
  },
  {
    id: "implement",
    name: "Implement",
    kind: "agent",
    prompt: "Fix {{trigger.issue.key}} in {{classify.area}}",
    chat: "run",
    output: [],
    retries: 1,
    onInvalid: "ask-once",
  },
  { id: "pr", name: "Open pull request", kind: "pull-request", title: "{{trigger.issue.title}}", body: "", draft: true, askFirst: true },
  {
    id: "review",
    name: "Review",
    kind: "agent",
    prompt: "Review {{pr.url}}",
    chat: "own",
    output: [{ name: "verdict", type: "choice", choices: ["approve", "changes"] }],
    retries: 1,
    onInvalid: "ask-once",
  },
];

test("the pilot flow checks clean under a Linear trigger", () => {
  assert.deepEqual(flowProblems(pilot(), "linear"), []);
  assert.equal(checkFlowSteps(pilot(), "linear").length, 5);
});

test("a step can't read a field no earlier step gives, nor a path's field after the If", () => {
  const steps = pilot();
  steps[2].prompt = "{{ask.decision}} {{review.verdict}}";
  const messages = flowProblems(steps, "linear").map((problem) => problem.message);
  assert.ok(messages.some((message) => message.includes("ask.decision")));
  assert.ok(messages.some((message) => message.includes("review.verdict")));
});

test("Linear steps need a Linear trigger and a review wait needs a pull request first", () => {
  const steps = [
    { id: "c", name: "Comment", kind: "linear-comment", body: "hi" },
    { id: "w", name: "Wait", kind: "wait", until: { kind: "pr-review" }, timeoutHours: 4 },
  ];
  const messages = flowProblems(steps, "schedule").map((problem) => problem.message);
  assert.ok(messages.some((message) => message.includes("needs a Linear trigger")));
  assert.ok(messages.some((message) => message.includes("pull request must come first")));
});

test("checkFlowSteps rejects bad shapes with the step's name", () => {
  assert.throws(() => checkFlowSteps([{ id: "Bad Id", name: "x", kind: "ask" }], "linear"), /isn't a step id/);
  assert.throws(() => checkFlowSteps([{ id: "a", name: "A", kind: "agent", prompt: "" }], "linear"), /Step "A": add a prompt/);
  assert.throws(
    () => checkFlowSteps([{ id: "a", name: "A", kind: "agent", prompt: "x", output: [{ name: "c", type: "choice", choices: ["one"] }] }], "linear"),
    /two choices/,
  );
  assert.throws(() => checkFlowSteps([], "linear"), /at least one step/);
});

test("Ifs nest three deep at most", () => {
  const nest = (depth) => ({
    id: `if-${depth}`,
    name: "If",
    kind: "if",
    field: "trigger.issue.key",
    test: "is-set",
    yes: depth < 4 ? [nest(depth + 1)] : [],
    otherwise: [],
  });
  assert.throws(() => checkFlowSteps([nest(1)], "linear"), /nest 3 deep/);
});

test("fieldsBefore sees the trigger, earlier outputs and an earlier pull request's url", () => {
  const refs = new Set(fieldsBefore(pilot(), "review", "linear").map((field) => field.ref));
  assert.ok(refs.has("trigger.issue.title"));
  assert.ok(refs.has("classify.complexity"));
  assert.ok(refs.has("pr.url"));
  assert.ok(!refs.has("review.verdict"));
  assert.deepEqual(
    fieldsBefore(pilot(), "classify", "linear")
      .map((field) => field.ref)
      .filter((ref) => !ref.startsWith("trigger.")),
    [],
  );
});

test("tree edits: insert into a path, move, remove an If with its paths", () => {
  let steps = pilot();
  const step = newStep("linear-comment", steps);
  steps = insertStep(steps, { parentId: "if-large", branch: "otherwise", index: 0 }, step);
  assert.equal(steps[1].otherwise[0].id, step.id);
  steps = moveStep(steps, "implement", -1);
  assert.equal(steps[1].id, "implement");
  steps = removeStep(steps, "if-large");
  assert.equal(flattenSteps(steps).length, 4);
  assert.throws(() => insertStep(steps, { parentId: "nope", branch: "yes", index: 0 }, step), /No such place/);
});

test("newStepId never repeats an id", () => {
  assert.equal(newStepId(pilot(), "Classify"), "classify-2");
  assert.equal(newStepId(pilot(), "Wait for CI"), "wait-for-ci");
});

test("fillTemplate reads the trigger and outputs, empty for nothing", () => {
  const values = { trigger: triggerValues({ kind: "linear", issue: { key: "MIL-1", title: "T", labels: ["a", "b"] } }), classify: { area: "relay" } };
  assert.equal(fillTemplate("{{trigger.issue.key}} {{classify.area}} {{x.y}}|{{trigger.issue.labels}}", values), "MIL-1 relay |a, b");
});

test("testCondition: is, is not, a list of choices, contains, is set", () => {
  const values = { classify: { complexity: "Large", ok: false } };
  assert.equal(testCondition({ field: "classify.complexity", test: "is", value: "large" }, values), true);
  assert.equal(testCondition({ field: "classify.complexity", test: "is", value: "small or medium" }, values), false);
  assert.equal(testCondition({ field: "classify.complexity", test: "is-not", value: "small, medium" }, values), true);
  assert.equal(testCondition({ field: "classify.complexity", test: "contains", value: "arg" }, values), true);
  assert.equal(testCondition({ field: "classify.ok", test: "is-set" }, values), false);
});

test("checkOutput types each field and says what's wrong", () => {
  const fields = [
    { name: "complexity", type: "choice", choices: ["small", "large"] },
    { name: "tests", type: "yes-no" },
    { name: "count", type: "number" },
    { name: "link", type: "link" },
  ];
  assert.deepEqual(checkOutput(fields, { complexity: "LARGE", tests: "yes", count: "3", link: "https://x.y/1" }), {
    ok: true,
    output: { complexity: "large", tests: true, count: 3, link: "https://x.y/1" },
  });
  const bad = checkOutput(fields, { complexity: "huge", tests: "maybe" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /complexity must be one of small, large; tests must be yes or no; count is missing/);
});

test("flowChanges lists what a draft adds, removes and changes", () => {
  const draft = pilot();
  draft[0].prompt = "new";
  draft.splice(4, 1);
  draft.push(newStep("linear-comment", draft));
  assert.deepEqual(flowChanges(pilot(), draft), ["Classify: prompt changed", "Added Comment on Linear", "Removed Review"]);
});

test("usedBy counts the steps reading a ref", () => {
  assert.equal(usedBy(pilot(), "classify.area"), 2);
  assert.equal(usedBy(pilot(), "classify.complexity"), 1);
});

test("runRows marks the path not taken and flowRunText reads the Run", () => {
  const flow = {
    revision: 4,
    steps: pilot(),
    status: "waiting",
    state: {
      classify: { status: "done" },
      "if-large": { status: "done", taken: "yes" },
      ask: { status: "done" },
      implement: { status: "done" },
      pr: { status: "waiting", approval: { askedAt: 1, expiresAt: 2, message: "" } },
    },
  };
  const rows = runRows(flow);
  const otherwise = rows.find((row) => row.kind === "path" && row.path === "otherwise");
  assert.equal(otherwise.taken, false);
  assert.equal(otherwise.empty, true);
  assert.equal(rows.find((row) => row.kind === "step" && row.step.id === "ask").status, "done");
  assert.equal(flowRunText({ flow }), "Waiting for you at Open pull request");
  assert.equal(flowRunText({ flow: { ...flow, status: "failed", state: { ...flow.state, pr: { status: "failed" } } } }), "Stopped at Open pull request");
});

test("a step cannot overwrite the trigger namespace or read inherited object properties", () => {
  assert.throws(() => checkFlowSteps([{ ...pilot()[0], id: "trigger" }], "linear"), /reserved/);
  assert.equal(fillTemplate("{{trigger.constructor}}", { trigger: {} }), "");
});
