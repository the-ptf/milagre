import assert from "node:assert/strict";
import { test } from "node:test";
import { qaFleetFirst, qaFleetRoster, qaPersona } from "./qa-personas.ts";

test("a subagent plays a QA persona by its agent type, or by a QA title from a provider without types", () => {
  assert.equal(qaPersona({ agentType: "qa-mobile", title: "Checkout run" })?.name, "Mobile");
  assert.equal(qaPersona({ title: "QA Breaker: checkout" })?.type, "qa-breaker");
  assert.equal(qaPersona({ agentType: "Explore", title: "Find the checkout routes" }), undefined);
  const agents = [{ title: "Find routes" }, { agentType: "qa-skeptic", title: "Pricing" }, { title: "QA Literal" }];
  assert.deepEqual(
    Object.values(qaFleetFirst(agents)).map((group) => group.map((agent) => agent.title)),
    [["Pricing", "QA Literal"], ["Find routes"]],
  );
});

test("the fleet roster keeps each persona's latest unarchived launch, in persona order", () => {
  const agents = [
    { id: "b1", agentType: "qa-breaker", title: "QA Breaker run 1", startedAt: 1, status: "failed" },
    { id: "i1", agentType: "qa-impatient", title: "QA Impatient run 1", startedAt: 2, status: "running" },
    { id: "b2", agentType: "qa-breaker", title: "QA Breaker run 1", startedAt: 3, status: "running" },
    { id: "s1", agentType: "qa-skeptic", title: "QA Skeptic run 1", startedAt: 4, status: "completed", archived: true },
    { id: "e1", agentType: "Explore", title: "Find routes", startedAt: 5, status: "running" },
  ];
  assert.deepEqual(
    qaFleetRoster(agents).map(({ persona, agent }) => [persona.type, agent.id]),
    [
      ["qa-impatient", "i1"],
      ["qa-breaker", "b2"],
    ],
  );
});
