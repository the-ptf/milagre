import assert from "node:assert/strict";
import test from "node:test";
import { activityBoundary, earlierStepsLabel } from "./activity-window.ts";
import type { ActivityEntry } from "./reply-parts";

const entries = (count: number): ActivityEntry[] =>
  Array.from({ length: count }, (_, index) => ({ type: "step", step: { id: String(index), kind: "shell", title: `Command ${index}`, status: "done" } }));

test("first open shows every entry through 200, then the last 150", () => {
  for (const count of [0, 1, 150, 200]) assert.equal(activityBoundary(entries(count), []), 0);
  assert.equal(activityBoundary(entries(201), []), 51);
  assert.equal(activityBoundary(entries(250), []), 100);
  assert.equal(activityBoundary(entries(1805), []), 1655);
});

test("appending never moves the fixed boundary, including when a small block grows beyond the cap", () => {
  assert.equal(activityBoundary(entries(300), [], 100), 100);
  assert.equal(activityBoundary(entries(300), [], 0), 0);
});

test("the earliest running or waiting step lowers the boundary, including on a later update", () => {
  const list = entries(250);
  if (list[25]?.type === "step") list[25].step.status = "running";
  assert.equal(activityBoundary(list, []), 25);
  assert.equal(activityBoundary(list, ["10"], 25), 10);
  assert.equal(activityBoundary(list, ["175"], 0), 0);
});

test("text counts toward the cap but not the command or failure label", () => {
  const list = entries(250);
  list[2] = { type: "text", text: "A note" };
  list[3] = { type: "step", step: { id: "thought", kind: "thinking", title: "Thought", status: "done" } };
  for (const index of [0, 99, 100]) if (list[index]?.type === "step") list[index].step.status = "failed";
  assert.equal(activityBoundary(list, []), 100);
  assert.equal(earlierStepsLabel(list, 100), `Show earlier steps (${(98).toLocaleString()}, 2 failed)`);
  assert.equal(earlierStepsLabel(entries(250), 100), `Show earlier steps (${(100).toLocaleString()})`);
  assert.equal(earlierStepsLabel(entries(1805), 1655), `Show earlier steps (${(1655).toLocaleString()})`);
});
