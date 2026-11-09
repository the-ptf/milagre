import test from "node:test";
import assert from "node:assert/strict";
import { archiveSubagent, archiveFinishedSubagents } from "./project-edits.mjs";
import { applyAgentEvent } from "./agent-runs.mjs";
import type { CoordinatorState, Subagent } from "./model.ts";
const child: Subagent = {
  id: "child",
  title: "Review auth",
  status: "running",
  startedAt: 1,
  updatedAt: 2,
  transcript: [{ id: "m", kind: "message", text: "Partial review" }],
};
const base = (): CoordinatorState => ({
  next_id: 10,
  sessions: { 1: { id: 1, worktree_id: 2, agent_name: "main", status: "Created", provider: "claude", subagents: [child] } },
  projects: {},
  worktrees: {},
  messages: [],
  connections: {},
  events: [],
  approvals: [],
  tasks: {},
  artifacts: {},
  outputs: [],
  conflicts: [],
});
test("archiving a child preserves its output and survives later provider updates", () => {
  let state = archiveSubagent(base(), 1, "child", true);
  assert.equal(state.sessions[1].subagents?.[0].archived, true);
  ({ state } = applyAgentEvent(state, {}, "/repo", "/repo#1", { type: "subagent-update", agent: { ...child, status: "completed", updatedAt: 3 } }));
  assert.equal(state.sessions[1].subagents?.[0].archived, true);
  assert.equal(state.sessions[1].subagents?.[0].transcript[0].text, "Partial review");
  state = archiveSubagent(state, 1, "child", false);
  assert.equal(Boolean(state.sessions[1].subagents?.[0].archived), false);
});
test("archive finished hides only known terminal children and preserves their output", () => {
  const state = base();
  const statuses = ["initializing", "running", "waiting", "completed", "failed", "cancelled", "unknown"] as const;
  state.sessions[1].subagents = statuses.map((status) => ({ ...child, id: status, status }));
  const next = archiveFinishedSubagents(state, 1);
  assert.deepEqual(
    next.sessions[1].subagents?.filter((agent) => agent.archived).map((agent) => agent.id),
    ["completed", "failed", "cancelled"],
  );
  assert.equal(next.sessions[1].subagents?.find((agent) => agent.id === "failed")?.transcript[0].text, "Partial review");
  assert.equal(next.sessions[1].subagents?.find((agent) => agent.id === "unknown")?.archived, undefined);
  assert.equal(archiveFinishedSubagents(next, 1), next);
  assert.equal(archiveFinishedSubagents(state, 42), state);
});

test("provider replay keeps the spawning parent and the archived flag", () => {
  const state = base();
  state.sessions[1].subagents = [{ ...child, parentId: "parent", archived: true }];
  const result = applyAgentEvent(state, {}, "/repo", "/repo#1", { type: "subagent-update", agent: { ...child, updatedAt: 30 } });
  const saved = result.state.sessions[1].subagents?.[0];
  assert.equal(saved?.parentId, "parent");
  assert.equal(saved?.archived, true);
});

test("the main provider thread never becomes its own saved subagent", () => {
  const state = base();
  state.sessions[1].native_session_id = "root";
  const result = applyAgentEvent(state, {}, "/repo", "/repo#1", { type: "subagent-update", agent: { ...child, id: "root" } });
  assert.equal(result.changed, false);
  assert.equal(result.state, state);
});

test("a child update removes an earlier phantom main agent from saved state", () => {
  const state = base();
  state.sessions[1].native_session_id = "root";
  state.sessions[1].subagents = [child, { ...child, id: "root" }];
  const result = applyAgentEvent(state, {}, "/repo", "/repo#1", { type: "subagent-update", agent: { ...child, updatedAt: 3 } });
  assert.deepEqual(
    result.state.sessions[1].subagents?.map((agent) => agent.id),
    ["child"],
  );
});
