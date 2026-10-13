import assert from "node:assert/strict";
import test from "node:test";
import { planPillLabel } from "./plan-label.ts";

test("pill shows leaf counts, the phase when there are no tasks, and nothing without a plan", () => {
  assert.equal(planPillLabel(undefined), null);
  assert.equal(planPillLabel({ source: "milagre", tasks: [], phases: [], updatedAt: 0 }), null);
  assert.equal(
    planPillLabel({
      source: "milagre",
      tasks: [
        {
          id: "1",
          title: "A",
          status: "pending",
          children: [
            { id: "1.1", title: "a", status: "completed" },
            { id: "1.2", title: "b", status: "pending" },
          ],
        },
      ],
      phases: [],
      updatedAt: 0,
    }),
    "1/2",
  );
  assert.equal(planPillLabel({ source: "milagre", tasks: [], phases: [{ phase: "review", at: 1 }], updatedAt: 0 }), "Review");
});
