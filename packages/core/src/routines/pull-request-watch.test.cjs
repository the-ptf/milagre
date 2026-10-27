const test = require("node:test");
const assert = require("node:assert/strict");
const { parsePullRequestUrl, readPullRequestSnapshot, diffSnapshots, BABYSIT_MARKER } = require("./pull-request-watch.cjs");

const settings = (patch = {}) => ({
  wake: ["comments", "checks", "conflicts", "behind"],
  stopWhenGreen: true,
  ...patch,
});

const snapshot = (patch = {}) => ({
  state: "OPEN",
  isDraft: false,
  reviewDecision: null,
  mergeable: "MERGEABLE",
  mergeState: "CLEAN",
  headRef: "feature",
  headOid: "a1",
  baseRef: "main",
  behindBy: 0,
  failingChecks: [],
  pendingChecks: 0,
  totalChecks: 0,
  comments: [],
  unresolvedThreads: [],
  ...patch,
});

const comment = (id, body = "please rename this", author = "alice", threadId = null) => ({ id, body, author, threadId });

test("parsePullRequestUrl handles GHE hosts", () => {
  assert.deepEqual(parsePullRequestUrl("https://github.com/o/r/pull/12"), { repo: "github.com/o/r", number: 12 });
  assert.deepEqual(parsePullRequestUrl("https://ghe.example.com/team/app/pull/7/files"), { repo: "ghe.example.com/team/app", number: 7 });
  assert.equal(parsePullRequestUrl("https://github.com/o/r/issues/12"), null);
  assert.equal(parsePullRequestUrl("not a url"), null);
});

test("new comment wakes", () => {
  const prev = snapshot({ comments: [comment("c1")] });
  const next = snapshot({ comments: [comment("c1"), comment("c2", "Looks off, can you check the loop?", "bob")] });
  const { changes, stop } = diffSnapshots(prev, next, settings({ stopWhenGreen: false }));
  assert.deepEqual(changes, [{ id: "comment:c2", text: "Review comment from @bob: Looks off, can you check the loop?" }]);
  assert.equal(stop, null);
});

test("long comments are cut to 200 characters", () => {
  const { changes } = diffSnapshots(snapshot(), snapshot({ comments: [comment("c1", "x".repeat(500))] }), settings());
  assert.equal(changes[0].text, `Review comment from @alice: ${"x".repeat(200)}`);
});

test("marked comment is ignored", () => {
  const next = snapshot({ comments: [comment("c1", `Fixed it.\n${BABYSIT_MARKER}`)] });
  assert.equal(BABYSIT_MARKER, "<!-- milagre-babysit -->");
  assert.deepEqual(diffSnapshots(snapshot(), next, settings()).changes, []);
});

test("comment wake off ignores comments", () => {
  const next = snapshot({ comments: [comment("c1")] });
  assert.deepEqual(diffSnapshots(snapshot(), next, settings({ wake: ["checks"] })).changes, []);
});

test("check turning red wakes once", () => {
  const prev = snapshot();
  const red = snapshot({ failingChecks: ["build"] });
  assert.deepEqual(diffSnapshots(prev, red, settings()).changes, [{ id: "check:build", text: "Check failed: build" }]);
  assert.deepEqual(diffSnapshots(red, red, settings()).changes, []);
});

test("conflict wakes once", () => {
  const conflicting = snapshot({ mergeable: "CONFLICTING", mergeState: "DIRTY" });
  assert.deepEqual(diffSnapshots(snapshot(), conflicting, settings()).changes, [{ id: "conflict", text: "Merge conflicts with main" }]);
  assert.deepEqual(diffSnapshots(conflicting, conflicting, settings()).changes, []);
  assert.deepEqual(diffSnapshots(snapshot(), conflicting, settings({ wake: ["comments"] })).changes, []);
});

test("behind wakes once, from the merge state or the compare count", () => {
  const behind = snapshot({ mergeState: "BEHIND" });
  assert.deepEqual(diffSnapshots(snapshot(), behind, settings()).changes, [{ id: "behind", text: "Branch is behind main" }]);
  assert.deepEqual(diffSnapshots(behind, behind, settings()).changes, []);
  const counted = snapshot({ behindBy: 3 });
  assert.deepEqual(diffSnapshots(snapshot(), counted, settings()).changes, [{ id: "behind", text: "Branch is behind main" }]);
  assert.deepEqual(diffSnapshots(snapshot(), behind, settings({ wake: ["checks"] })).changes, []);
});

test("first snapshot is a baseline", () => {
  const next = snapshot({
    comments: [comment("c1")],
    failingChecks: ["build"],
    mergeable: "CONFLICTING",
    mergeState: "BEHIND",
  });
  const { changes } = diffSnapshots(undefined, next, settings());
  assert.deepEqual(
    changes.map((change) => change.id),
    ["check:build", "conflict"],
  );
});

test("merged stops", () => {
  assert.equal(diffSnapshots(snapshot(), snapshot({ state: "MERGED" }), settings()).stop, "closed");
  assert.equal(diffSnapshots(snapshot(), snapshot({ state: "CLOSED" }), settings()).stop, "closed");
});

test("green and approved stops", () => {
  assert.equal(diffSnapshots(snapshot(), snapshot({ reviewDecision: "APPROVED", totalChecks: 3 }), settings()).stop, "green");
});

test("green with no review required stops", () => {
  assert.equal(diffSnapshots(snapshot(), snapshot({ reviewDecision: null, totalChecks: 3 }), settings()).stop, "green");
});

test("a draft never stops green", () => {
  assert.equal(diffSnapshots(snapshot(), snapshot({ isDraft: true, reviewDecision: "APPROVED", totalChecks: 3 }), settings()).stop, null);
  assert.equal(diffSnapshots(snapshot({ isDraft: true }), snapshot({ isDraft: true, state: "CLOSED" }), settings()).stop, "closed");
});

test("baseline never stops green", () => {
  assert.equal(diffSnapshots(undefined, snapshot({ reviewDecision: "APPROVED", totalChecks: 3 }), settings()).stop, null);
});

test("conflicting PR does not stop green", () => {
  const conflicting = snapshot({ mergeable: "CONFLICTING", mergeState: "DIRTY", reviewDecision: "APPROVED", totalChecks: 3 });
  const { changes, stop } = diffSnapshots(snapshot(), conflicting, settings());
  assert.deepEqual(changes, [{ id: "conflict", text: "Merge conflicts with main" }]);
  assert.equal(stop, null);
});

test("no checks and no approval does not stop green", () => {
  assert.equal(diffSnapshots(snapshot(), snapshot({ reviewDecision: null, totalChecks: 0 }), settings()).stop, null);
  assert.equal(diffSnapshots(snapshot(), snapshot({ reviewDecision: "APPROVED", totalChecks: 0 }), settings()).stop, "green");
});

test("green does not stop when stopWhenGreen is off, or checks, threads are open", () => {
  assert.equal(diffSnapshots(snapshot(), snapshot({ totalChecks: 3 }), settings({ stopWhenGreen: false })).stop, null);
  assert.equal(diffSnapshots(snapshot(), snapshot({ pendingChecks: 1, totalChecks: 3 }), settings()).stop, null);
  assert.equal(diffSnapshots(snapshot(), snapshot({ failingChecks: ["build"], totalChecks: 1 }), settings()).stop, null);
  assert.equal(diffSnapshots(snapshot(), snapshot({ unresolvedThreads: ["t1"], totalChecks: 3 }), settings()).stop, null);
});

test("REVIEW_REQUIRED does not stop", () => {
  assert.equal(diffSnapshots(snapshot(), snapshot({ reviewDecision: "REVIEW_REQUIRED" }), settings()).stop, null);
  assert.equal(diffSnapshots(snapshot(), snapshot({ reviewDecision: "CHANGES_REQUESTED" }), settings()).stop, null);
});

const VIEW = {
  state: "OPEN",
  isDraft: true,
  reviewDecision: "REVIEW_REQUIRED",
  mergeStateStatus: "CLEAN",
  mergeable: "MERGEABLE",
  headRefName: "feature",
  headRefOid: "0123abc",
  baseRefName: "main",
  statusCheckRollup: [
    { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "FAILURE" },
    { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "FAILURE" },
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: "" },
    { __typename: "CheckRun", name: "deploy", status: "COMPLETED", conclusion: "TIMED_OUT" },
    { __typename: "StatusContext", context: "ci/legacy", state: "ERROR" },
    { __typename: "StatusContext", context: "ci/queued", state: "PENDING" },
    { __typename: "StatusContext", context: "ci/ok", state: "SUCCESS" },
  ],
  comments: [{ id: "IC_1", body: "top level", author: { login: "alice" } }],
  reviews: [
    { id: "PRR_1", body: "needs work", author: { login: "bob" } },
    { id: "PRR_2", body: "", author: { login: "bob" } },
  ],
};

const THREADS = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [
            { id: "T_1", isResolved: false, comments: { nodes: [{ id: "RC_1", body: "inline", author: { login: "carol" } }] } },
            { id: "T_2", isResolved: true, comments: { nodes: [{ id: "RC_2", body: "done", author: null }] } },
          ],
        },
      },
    },
  },
};

function fakeExec(overrides = {}) {
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, "gh");
    if (args[0] === "pr") return { stdout: JSON.stringify({ ...VIEW, ...overrides.view }), stderr: "" };
    if (args[0] === "api" && args[1] === "graphql") return { stdout: JSON.stringify(THREADS), stderr: "" };
    if (args[0] === "api") {
      if (overrides.compareError) throw overrides.compareError;
      return { stdout: `${overrides.behindBy ?? 0}\n`, stderr: "" };
    }
    throw new Error(`unexpected gh call ${args.join(" ")}`);
  };
  return { exec, calls };
}

test("readPullRequestSnapshot reads the PR, its threads and its checks", async () => {
  const { exec, calls } = fakeExec();
  const result = await readPullRequestSnapshot({ repo: "ghe.example.com/o/r", number: 12 }, { exec, env: { PATH: "/bin" }, settings: settings() });
  assert.deepEqual(result, {
    state: "OPEN",
    isDraft: true,
    reviewDecision: "REVIEW_REQUIRED",
    mergeable: "MERGEABLE",
    mergeState: "CLEAN",
    headRef: "feature",
    headOid: "0123abc",
    baseRef: "main",
    behindBy: 0,
    failingChecks: ["build", "deploy", "ci/legacy"],
    pendingChecks: 2,
    totalChecks: 7,
    comments: [
      { id: "IC_1", body: "top level", author: "alice", threadId: null },
      { id: "PRR_1", body: "needs work", author: "bob", threadId: null },
      { id: "RC_1", body: "inline", author: "carol", threadId: "T_1" },
      { id: "RC_2", body: "done", author: "ghost", threadId: "T_2" },
    ],
    unresolvedThreads: ["T_1"],
  });
  const view = calls.find((call) => call.args[0] === "pr");
  assert.deepEqual(view.args.slice(0, 5), ["pr", "view", "12", "-R", "ghe.example.com/o/r"]);
  assert.ok(
    view.args.includes("state,isDraft,reviewDecision,mergeStateStatus,mergeable,statusCheckRollup,headRefName,headRefOid,baseRefName,comments,reviews"),
  );
  assert.equal(view.options.env.GH_PROMPT_DISABLED, "1");
  assert.equal(view.options.env.PATH, "/bin");
  const graphql = calls.find((call) => call.args[1] === "graphql");
  assert.ok(graphql.args.join(" ").includes("--hostname ghe.example.com"));
  assert.ok(graphql.args.includes("owner=o") && graphql.args.includes("name=r") && graphql.args.includes("number=12"));
  const compare = calls.find((call) => call.args[1]?.startsWith("repos/"));
  assert.deepEqual(compare.args, ["api", "repos/o/r/compare/main...feature", "--hostname", "ghe.example.com", "--jq", ".behind_by"]);
});

test("behind via compare wakes", async () => {
  const { exec } = fakeExec({ behindBy: 4 });
  const next = await readPullRequestSnapshot({ repo: "github.com/o/r", number: 1 }, { exec, settings: settings() });
  assert.equal(next.behindBy, 4);
  const prev = { ...next, behindBy: 0 };
  assert.deepEqual(diffSnapshots(prev, next, settings()).changes, [{ id: "behind", text: "Branch is behind main" }]);
});

test("the compare call is skipped when the PR is already BEHIND or behind is not watched", async () => {
  const behind = fakeExec({ view: { mergeStateStatus: "BEHIND" } });
  const snap = await readPullRequestSnapshot({ repo: "github.com/o/r", number: 1 }, { exec: behind.exec, settings: settings() });
  assert.equal(snap.mergeState, "BEHIND");
  assert.equal(
    behind.calls.some((call) => call.args[1]?.startsWith("repos/")),
    false,
  );
  const off = fakeExec();
  await readPullRequestSnapshot({ repo: "github.com/o/r", number: 1 }, { exec: off.exec, settings: settings({ wake: ["comments"] }) });
  assert.equal(
    off.calls.some((call) => call.args[1]?.startsWith("repos/")),
    false,
  );
});

async function missingGh() {
  throw Object.assign(new Error("boom"), { code: "ENOENT" });
}

test("a failed compare leaves behindBy at zero; a failed view throws gh's message", async () => {
  const tolerant = fakeExec({ compareError: Object.assign(new Error("404"), { stderr: "gh: Not Found" }) });
  const snap = await readPullRequestSnapshot({ repo: "github.com/o/r", number: 1 }, { exec: tolerant.exec, settings: settings() });
  assert.equal(snap.behindBy, 0);
  await assert.rejects(readPullRequestSnapshot({ repo: "github.com/o/r", number: 1 }, { exec: missingGh }), /Install the GitHub CLI/);
});
