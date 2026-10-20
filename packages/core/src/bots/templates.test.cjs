const assert = require("node:assert/strict");
const test = require("node:test");
const { OPS_TEMPLATE, TEMPLATES, renderBrief, setupFields } = require("./templates.cjs");

test("the Ops brief is rendered from the setup answers", () => {
  const brief = renderBrief(OPS_TEMPLATE, { projects: ["/Code/milagre-ade"], ci: "CI / test, CI / typecheck", linearTeam: "MIL" });
  assert.match(brief, /milagre-ade/);
  assert.match(brief, /CI \/ test, CI \/ typecheck/);
  assert.match(brief, /Linear team: MIL\./);
  assert.doesNotMatch(brief, /the-ptf|asc\.mjs/);
});

test("optional answers can be left out", () => {
  const brief = renderBrief(OPS_TEMPLATE, { projects: ["/Code/app"] });
  assert.match(brief, /Every required check on the main branch counts as CI\./);
  assert.doesNotMatch(brief, /Linear team/);
});

test("the Ops setup card lists the registry's Projects to watch", () => {
  assert.deepEqual(
    TEMPLATES.map((template) => template.id),
    ["ops"],
  );
  const fields = setupFields(OPS_TEMPLATE, { projects: [{ path: "/Code/milagre-ade", name: "milagre-ade" }] });
  assert.deepEqual(
    fields.map((field) => [field.id, field.label, field.kind, field.required]),
    [
      ["projects", "Projects to watch", "projects", true],
      ["ci", "Checks that count as CI", "text", false],
      ["linearTeam", "Linear team", "text", false],
    ],
  );
  assert.deepEqual(fields[0].options, [{ value: "/Code/milagre-ade", label: "milagre-ade" }]);
  assert.equal(OPS_TEMPLATE.role, "Keeps main green and PRs moving");
  assert.equal(OPS_TEMPLATE.color, "#3b82f6");
  assert.equal(OPS_TEMPLATE.body, "circle");
});
