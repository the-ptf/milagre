import assert from "node:assert/strict";
import test from "node:test";
import { isLinearIssueContext, linearIssueContext, linearIssuePrompt, linearIssueRequest, routineIssueContext } from "./linear-issue.mjs";
import type { LinearIssue } from "./linear.ts";

const issue: LinearIssue = {
  key: "ENG-12",
  title: "Fix login redirect",
  url: "https://linear.app/acme/issue/ENG-12",
  branchName: "eng-12-fix-login",
  description: "Users bounce to /home.",
  state: { name: "Todo", type: "unstarted", color: "#aaa" },
  workspace: "acme",
};

test("an issue request keeps a valid key, its workspace and a typed note", () => {
  assert.deepEqual(linearIssueRequest({ key: "eng-12", workspace: "acme", note: "  check Safari  " }), {
    key: "ENG-12",
    workspace: "acme",
    note: "check Safari",
  });
  assert.deepEqual(linearIssueRequest({ key: "ENG-12", note: " " }), { key: "ENG-12" });
  for (const request of [null, "ENG-12", { key: "ENG 12" }, { key: "ENG-12", workspace: 3 }, { key: "ENG-12", note: 1 }, { key: "TOOLONGTEAM-1" }])
    assert.equal(linearIssueRequest(request), null, JSON.stringify(request));
});

test("the card context carries the issue and the note, and is recognized", () => {
  const context = linearIssueContext(issue, "check Safari");
  assert.deepEqual(context, {
    kind: "linear-issue",
    key: "ENG-12",
    title: "Fix login redirect",
    url: issue.url,
    state: issue.state,
    workspace: "acme",
    note: "check Safari",
  });
  assert.equal(isLinearIssueContext(context), true);
  assert.equal(isLinearIssueContext({ ...context, state: { name: "x", type: "weird", color: "" } }), false);
  assert.equal(isLinearIssueContext({ kind: "pr-action" }), false);
});

test("the prompt is the first message, then where to read the rest", () => {
  const prompt = linearIssuePrompt(issue, "check Safari");
  assert.ok(prompt.startsWith(`Work on Linear issue ENG-12: Fix login redirect\n\nUsers bounce to /home.\n\n${issue.url}\n\ncheck Safari\n\n`));
  assert.match(prompt, /linear_issue tool/);
});

const snapshot = {
  id: "i1",
  key: "ENG-12",
  title: "Fix login redirect",
  description: "Users bounce to /home.",
  url: "https://linear.app/acme/issue/ENG-12",
  labels: ["bug"],
  state: "In Review",
  stateType: "started",
  stateColor: "#f2c94c",
  team: "ENG",
  workspace: "acme",
};

test("a Linear Run's first message is the issue card carrying its Routine, labelled as a Routine", () => {
  const context = routineIssueContext(snapshot, { routineId: "r1", runId: "run1", name: "Triage", at: 5 });
  assert.deepEqual(context, {
    kind: "linear-issue",
    key: "ENG-12",
    title: "Fix login redirect",
    url: snapshot.url,
    state: { name: "In Review", type: "started", color: "#f2c94c" },
    workspace: "acme",
    routine: { routineId: "r1", runId: "run1", name: "Triage", at: 5, label: "Routine · Triage" },
  });
  assert.equal(isLinearIssueContext(context), true);
});

test("an issue snapshot from before state types were kept still makes a valid card", () => {
  const { stateType: _type, stateColor: _color, ...old } = snapshot;
  const context = routineIssueContext({ ...old, state: "" }, { routineId: "r1", runId: "run1", name: "Triage", at: 5 });
  assert.equal(isLinearIssueContext(context), true);
  assert.equal(context.state.type, "unstarted");
  assert.equal(context.state.name, "Unknown");
  const odd = routineIssueContext({ ...snapshot, stateType: "weird" }, { routineId: "r1", runId: "run1", name: "Triage", at: 5 });
  assert.equal(odd.state.type, "unstarted");
});
