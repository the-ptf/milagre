const test = require("node:test");
const assert = require("node:assert/strict");
const { fixturePermission, summarizedTurn } = require("./live-design-harness.cjs");

test("live design fixture authorizes only its own named design calls", () => {
  const event = {
    kind: "other",
    tool: "MCP: milagre",
    title: 'Allow the milagre MCP server to run tool "design_show"?',
    detail: JSON.stringify({ id: "daily-notes" }),
  };
  assert.equal(fixturePermission(event, { label: "create" }), true);
  assert.equal(fixturePermission(event, { label: "revise" }), false);
  assert.equal(fixturePermission({ ...event, detail: JSON.stringify({ id: "real-user-design" }) }, { label: "create" }), false);
  assert.equal(fixturePermission({ ...event, tool: "MCP: other" }, { label: "create" }), false);
  assert.equal(fixturePermission({ ...event, title: 'Allow the milagre MCP server to run tool "delegate"?' }, { label: "create" }), false);
  assert.equal(fixturePermission({ ...event, detail: "truncated" }, { label: "create" }), false);
  assert.equal(fixturePermission({ kind: "command", command: "rm -rf Project" }, { label: "create" }), false);
  assert.equal(fixturePermission({ kind: "command", command: "cat /skills/a/../SKILL.md" }, { label: "create" }, ["/skills/SKILL.md"]), true);
  assert.equal(fixturePermission({ kind: "command", command: "cat /skills/SKILL.md; cat /credentials" }, { label: "create" }, ["/skills/SKILL.md"]), false);
  assert.equal(fixturePermission({ kind: "command", command: "cat /skills/SKILL.md" }, { label: "create" }), false);
});

test("per-turn usage subtracts cumulative prior usage", () => {
  const turn = summarizedTurn({
    label: "revise",
    tools: [],
    steps: [],
    usageBefore: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 },
    usage: { total: { inputTokens: 250, outputTokens: 50, cachedInputTokens: 90 } },
  });
  assert.deepEqual(turn.tokenUsageDelta, { inputTokens: 150, outputTokens: 30, cachedInputTokens: 50 });
});
