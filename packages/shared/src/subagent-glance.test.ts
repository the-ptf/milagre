import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentTranscriptEntry } from "./model.ts";
import { addProgress, firstSentence, planCounts, subagentOutcome, subagentSteps, toolCategory, toolSummary } from "./subagent-glance.mjs";

const said = (id: string, text: string): SubagentTranscriptEntry => ({ id, kind: "message", text });
const call = (id: string, text: string, tool?: SubagentTranscriptEntry["tool"]): SubagentTranscriptEntry => ({
  id,
  kind: "tool",
  text,
  ...(tool ? { tool } : {}),
});

test("a step is what the agent said, with the tool calls after it counted; calls before any words make a first step", () => {
  const steps = subagentSteps([
    call("c0", "Ran `ls`", "shell"),
    said("m1", "I'll compare the booking screens. Calendly first."),
    call("c1", "Read `sheet-1.jpg`", "read"),
    call("c2", "Read `notes.md`", "read"),
    { id: "result:c2", kind: "tool", text: "# Notes" },
    call("c3", "Ran `curl https://example.com`", "shell"),
    said("m2", "**Now** I want to check the Notion sheet."),
    call("c4", "Read `sheet-notion.jpg`"),
    said("result", "Two patterns are worth copying."),
  ]);
  assert.deepEqual(
    steps.map((step) => [step.said, step.tools, step.lastTool]),
    [
      ["", { commands: 1 }, "Ran `ls`"],
      ["I'll compare the booking screens.", { images: 1, reads: 1, commands: 1 }, "Ran `curl https://example.com`"],
      ["Now I want to check the Notion sheet.", { images: 1 }, "Read `sheet-notion.jpg`"],
    ],
  );
});

test("the outcome is the final answer's first sentence", () => {
  assert.equal(
    subagentOutcome([said("m1", "Looking."), said("result", "Two screenshots are below 1290 px wide. Details follow.")]),
    "Two screenshots are below 1290 px wide.",
  );
  assert.equal(subagentOutcome([said("m1", "Looking.")]), undefined);
});

test("first sentence drops Markdown marks and keeps a line without a sentence end whole", () => {
  assert.equal(firstSentence("## Plan\nMore"), "Plan");
  assert.equal(firstSentence("- Checking `auth.ts` now"), "Checking auth.ts now");
  assert.equal(firstSentence("Version 1.5 is out! Then more."), "Version 1.5 is out!");
  assert.equal(firstSentence(""), "");
});

test("tool categories come from the step kind, else from the title; image reads are images", () => {
  assert.equal(toolCategory("read", "Read `a.PNG`"), "images");
  assert.equal(toolCategory("read", "Read `a.ts`"), "reads");
  assert.equal(toolCategory(undefined, "Edited `a.ts`"), "edits");
  assert.equal(toolCategory(undefined, "Searched for `x`"), "searches");
  assert.equal(toolCategory(undefined, "Fetched `https://a.b`"), "other");
});

test("the summary names the busiest categories first, singular or plural", () => {
  assert.equal(toolSummary({ commands: 2, images: 8, edits: 1, reads: 1 }), "8 images · 2 commands · 1 edit");
  assert.equal(toolSummary({ reads: 1 }), "1 file read");
  assert.equal(toolSummary({}), "");
});

test("progress counts each new entry once: steps, the last thing said, and calls per category", () => {
  let progress = addProgress(undefined, said("m1", "Checking the rate limit. It is low."));
  progress = addProgress(progress, call("c1", "Ran `supabase`", "shell"));
  progress = addProgress(progress, { id: "result:c1", kind: "tool", text: "ok" });
  progress = addProgress(progress, said("result", "Done."));
  assert.deepEqual(progress, { steps: 1, said: "Checking the rate limit.", tools: { commands: 1 } });
});

test("plan counts are null without a list", () => {
  assert.equal(planCounts(undefined), null);
  assert.deepEqual(
    planCounts([
      { id: "1", content: "a", status: "completed" },
      { id: "2", content: "b", status: "in_progress" },
    ]),
    { done: 1, total: 2 },
  );
});
