import assert from "node:assert/strict";
import { test } from "node:test";
import { qaFleetFirst, qaPersona } from "./qa-personas.ts";

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
