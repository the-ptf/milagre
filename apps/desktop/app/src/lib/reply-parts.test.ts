import assert from "node:assert/strict";
import test from "node:test";
import type { ChatStep } from "../model";
import { desktopStepApps, desktopStepLabel } from "@milagre/shared/desktop-steps";
import { activitySummary, isHeartbeatCard, replyActivity, replyParts, titleSpans, unspokenThought } from "./reply-parts.ts";

const step = (id: string, offset?: number): ChatStep => ({
  id,
  kind: "shell",
  title: `Ran \`${id}\``,
  status: "done",
  ...(offset === undefined ? {} : { offset }),
});

test("steps sit between the text around them, in order", () => {
  const body = "Checking.\n\nNow editing.\n\nDone.";
  assert.deepEqual(replyParts(body, [step("a", 9), step("b", 9), step("c", 23)]), [
    { type: "text", text: "Checking." },
    { type: "steps", steps: [step("a", 9), step("b", 9)] },
    { type: "text", text: "\n\nNow editing." },
    { type: "steps", steps: [step("c", 23)] },
    { type: "text", text: "\n\nDone." },
  ]);
});

test("a reply without steps is its text; steps alone are one group", () => {
  assert.deepEqual(replyParts("Hello"), [{ type: "text", text: "Hello" }]);
  assert.deepEqual(replyParts("", [step("a", 0), step("b", 0)]), [{ type: "steps", steps: [step("a", 0), step("b", 0)] }]);
  assert.deepEqual(replyParts("", []), []);
});

test("whitespace between steps doesn't split their group", () => {
  assert.deepEqual(replyParts("Go.\n\n", [step("a", 3), step("b", 5)]), [
    { type: "text", text: "Go." },
    { type: "steps", steps: [step("a", 3), step("b", 5)] },
  ]);
});

test("offsets past the text, missing or out of order still keep every step once", () => {
  assert.deepEqual(replyParts("Hi", [step("a", 99), step("b")]), [
    { type: "text", text: "Hi" },
    { type: "steps", steps: [step("a", 99), step("b")] },
  ]);
  assert.deepEqual(replyParts("abcdef", [step("a", 4), step("b", 1)]), [
    { type: "text", text: "abcd" },
    { type: "steps", steps: [step("a", 4), step("b", 1)] },
    { type: "text", text: "ef" },
  ]);
});

test("titles split into text and code", () => {
  assert.deepEqual(titleSpans("Ran `npm test`"), [
    { text: "Ran ", code: false },
    { text: "npm test", code: true },
  ]);
  assert.deepEqual(titleSpans("Searched for `greet` in `src`"), [
    { text: "Searched for ", code: false },
    { text: "greet", code: true },
    { text: " in ", code: false },
    { text: "src", code: true },
  ]);
  assert.deepEqual(titleSpans("Updated the to-do list"), [{ text: "Updated the to-do list", code: false }]);
});

const thought = (id: string, offset: number, durationMs?: number): ChatStep => ({
  id,
  kind: "thinking",
  title: "Thought",
  status: "done",
  offset,
  ...(durationMs === undefined ? {} : { durationMs }),
});

test("a reply's last text is its answer; everything before it is activity, in order", () => {
  const body = "Checking.\n\nNow editing.\n\nDone.";
  assert.deepEqual(replyActivity(body, [thought("t", 0), step("a", 9), step("c", 23)]), {
    setup: [],
    activity: [
      { type: "step", step: thought("t", 0) },
      { type: "text", text: "Checking." },
      { type: "step", step: step("a", 9) },
      { type: "text", text: "\n\nNow editing." },
      { type: "step", step: step("c", 23) },
    ],
    images: [],
    artifacts: [],
    heartbeats: [],
    desktop: [],
    answer: "\n\nDone.",
  });
});

test("a reply without steps is all answer; steps alone are all activity", () => {
  assert.deepEqual(replyActivity("Hello"), { setup: [], activity: [], images: [], artifacts: [], heartbeats: [], desktop: [], answer: "Hello" });
  assert.deepEqual(replyActivity("", [step("a", 0)]), {
    setup: [],
    activity: [{ type: "step", step: step("a", 0) }],
    images: [],
    artifacts: [],
    heartbeats: [],
    desktop: [],
    answer: "",
  });
});

test("text before steps that end the reply is still its answer", () => {
  assert.deepEqual(replyActivity("Running it now.", [step("a", 15)]), {
    setup: [],
    activity: [{ type: "step", step: step("a", 15) }],
    images: [],
    artifacts: [],
    heartbeats: [],
    desktop: [],
    answer: "Running it now.",
  });
});

test("the summary counts thinking time, files, searches, commands and tools", () => {
  const steps: ChatStep[] = [
    thought("t1", 0, 4_000),
    thought("t2", 0, 8_400),
    { id: "r1", kind: "read", title: "Read `a.ts`", status: "done" },
    { id: "r2", kind: "read", title: "Read `b.ts`", status: "done" },
    { id: "r3", kind: "read", title: "Read `a.ts`", status: "done" },
    { id: "s1", kind: "search", title: "Searched for `x`", status: "done" },
    { id: "e1", kind: "edit", title: "Edited `a.ts`", status: "done" },
    { id: "e2", kind: "edit", title: "Edited `a.ts`", status: "done" },
    { id: "c1", kind: "shell", title: "Ran `npm test`", status: "failed" },
    { id: "c2", kind: "shell", title: "Ran `npm test`", status: "done" },
    { id: "o1", kind: "other", title: "Used `x`", status: "done" },
  ];
  assert.deepEqual(activitySummary(steps), {
    text: "Thought for 12s · read 2 files · searched once · edited 1 file · ran 2 commands · used 1 tool",
    failed: 1,
  });
});

test("a turn's credits close the summary when the agent reported them", () => {
  assert.deepEqual(activitySummary([step("a")], { credits: 0.0416 }), { text: "Ran 1 command · 0.04 credits", failed: 0 });
  assert.equal(activitySummary([step("a")], { credits: 1 }).text, "Ran 1 command · 1 credit");
  assert.equal(activitySummary([step("a")], { credits: 0.004 }).text, "Ran 1 command · <0.01 credits");
  assert.equal(activitySummary([step("a")], {}).text, "Ran 1 command");
});

test("the summary starts with a capital and leaves out what didn't happen", () => {
  assert.deepEqual(activitySummary([step("a"), step("b")]), { text: "Ran 2 commands", failed: 0 });
  assert.deepEqual(activitySummary([thought("t", 0)]), { text: "Thought", failed: 0 });
  assert.deepEqual(
    activitySummary([
      thought("t", 0, 75_000),
      { id: "s", kind: "search", title: "x", status: "done" },
      { id: "s2", kind: "search", title: "y", status: "done" },
    ]),
    { text: "Thought for 1m 15s · searched 2 times", failed: 0 },
  );
});

test("a reply surfaces its last thinking when it wrote nothing after it", () => {
  const withDetail = (id: string, detail: string, offset = 0): ChatStep => ({ ...thought(id, offset), detail });
  assert.equal(
    unspokenThought("", [withDetail("t1", "Looking."), step("a", 0), withDetail("t2", "So the answer is no."), withDetail("t3", "  ")]),
    "So the answer is no.",
  );
  assert.equal(unspokenThought("No, it isn't.", [withDetail("t1", "So the answer is no.")]), "");
  // Text before the thinking, then a question with nothing written after it.
  assert.equal(unspokenThought("Checking.", [withDetail("t1", "T3 tries every route.", 9), step("a", 9)]), "T3 tries every route.");
  assert.equal(unspokenThought("Checking. Done.", [withDetail("t1", "Hm.", 9)]), "");
  assert.equal(unspokenThought("", [{ ...withDetail("t1", "Still going"), status: "running" }]), "");
  assert.equal(unspokenThought("", [step("a", 0)]), "");
});

const setupStep = (status: ChatStep["status"] = "done"): ChatStep => ({
  id: "setup",
  kind: "setup",
  title: "Ran setup `npm ci`",
  note: "3s",
  status,
  offset: 0,
});

test("the worktree setup is pulled out of the activity and left out of its summary", () => {
  const steps = [setupStep(), thought("t", 0, 4_000), step("a", 0)];
  assert.deepEqual(replyActivity("Done.", steps), {
    setup: [setupStep()],
    activity: [
      { type: "step", step: thought("t", 0, 4_000) },
      { type: "step", step: step("a", 0) },
    ],
    images: [],
    artifacts: [],
    heartbeats: [],
    desktop: [],
    answer: "Done.",
  });
  assert.deepEqual(activitySummary(steps), { text: "Thought for 4s · ran 1 command", failed: 0 });
  assert.deepEqual(activitySummary([setupStep("failed")]), { text: "", failed: 0 });
  assert.deepEqual(replyActivity("", [setupStep()]), {
    setup: [setupStep()],
    activity: [],
    images: [],
    artifacts: [],
    heartbeats: [],
    desktop: [],
    answer: "",
  });
});

test("replyActivity: generated images come back apart from the activity", () => {
  const image: ChatStep = { id: "ig", kind: "image", title: "Generated an image", status: "done", offset: 5, file: "/tmp/ig.png" };
  const read: ChatStep = { id: "r", kind: "read", title: "Read `a.ts`", status: "done", offset: 0 };
  const { activity, images, answer } = replyActivity("Done. Here it is.", [read, image]);
  assert.deepEqual(images, [image]);
  assert.deepEqual(activity, [{ type: "step", step: read }]);
  assert.equal(answer, "Done. Here it is.");
});

test("a heartbeat_create step that set a Heartbeat comes out of the activity as its own card", () => {
  const beat: ChatStep = { ...step("hb", 0), kind: "other", title: "Set Heartbeat", routine: { id: "r1", name: "Babysit PR #473" } };
  const reply = replyActivity("Opened #473. I'll check back.", [step("a", 0), beat]);
  assert.deepEqual(reply.heartbeats, [beat]);
  assert.deepEqual(reply.activity, [{ type: "step", step: step("a", 0) }]);
  assert.equal(isHeartbeatCard(beat), true);
  assert.equal(isHeartbeatCard(step("a", 0)), false);
});

test("only a finished heartbeat_create step is a card; a running or failed one stays in the activity", () => {
  for (const status of ["running", "failed"] as const) {
    const beat: ChatStep = { ...step("hb", 0), kind: "other", status, routine: { id: "r1", name: "Babysit" } };
    assert.equal(isHeartbeatCard(beat), false);
    const reply = replyActivity("Done.", [beat]);
    assert.deepEqual(reply.heartbeats, []);
    assert.deepEqual(reply.activity, [{ type: "step", step: beat }]);
  }
});

test("computer use steps leave the activity for their own card", () => {
  const desktopStep = (id: string, name: string, input: object, offset = 0): ChatStep => ({
    id,
    kind: "other",
    title: `Used \`${name}\` from milagre`,
    status: "done",
    offset,
    source: { name, server: "milagre" },
    input: JSON.stringify(input),
  });
  const launch = desktopStep("d1", "desktop_launch", { app: "TextEdit" });
  const act = desktopStep("d2", "desktop_act", { action: "type", ref: "@s1:e2", text: "Hello", intent: "Typing the greeting" });
  const read = step("r1");
  const reply = replyActivity("Done.", [launch, read, act]);
  assert.deepEqual(reply.desktop, [launch, act]);
  assert.deepEqual(
    reply.activity.map((entry) => (entry.type === "step" ? entry.step.id : entry.text)),
    ["r1"],
  );
  assert.equal(desktopStepLabel(launch), "Opened TextEdit");
  assert.equal(desktopStepLabel(act), "Typing the greeting");
  assert.equal(desktopStepLabel(desktopStep("d3", "desktop_act", { action: "type", text: "Hi" })), 'Typed "Hi"');
  assert.deepEqual(desktopStepApps([launch, act]), ["TextEdit"]);
});
