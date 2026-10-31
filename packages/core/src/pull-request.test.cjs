const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readPullRequest, readPullRequestState, readPullRequests, createPullRequestReader } = require("./pull-request.cjs");

const title = "Show pull requests in the chat sidebar";
const url = "https://github.com/example/project/pull/10213";
for (const state of ["OPEN", "MERGED", "CLOSED"]) {
  test(`reads the current worktree's ${state.toLowerCase()} PR`, async () => {
    const exec = async (command, args, options) => {
      if (command === "git") return { stdout: "feature/sidebar\n" };
      assert.equal(command, "gh");
      assert.deepEqual(args, [
        "pr",
        "list",
        "--head",
        "feature/sidebar",
        "--state",
        "all",
        "--limit",
        "1",
        "--json",
        "number,url,state,title,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup",
      ]);
      assert.equal(options.cwd, "/project/worktree");
      assert.ok(options.timeout > 0);
      return { stdout: JSON.stringify([{ number: 10213, url, state, title }]) };
    };
    assert.deepEqual(await readPullRequest("/project/worktree", exec), {
      number: 10213,
      url,
      state,
      title,
      isDraft: false,
      readyToMerge: false,
      hasConflicts: false,
      conflictStatusKnown: false,
      isBehind: false,
      changesRequested: false,
    });
  });
}

test("hides invalid metadata", async () => {
  for (const pr of [{ number: 10213, url: "javascript:alert(1)", state: "OPEN" }, { number: 0, url, state: "OPEN" }, null]) {
    assert.equal(await readPullRequest("/project", async () => ({ stdout: JSON.stringify(pr ? [pr] : []) })), null);
  }
});

test("missing PRs, unavailable gh, authentication failures and malformed responses do not break the sidebar", async () => {
  for (const message of ["no pull requests found", "ENOENT", "authentication required", "timeout"]) {
    assert.equal(
      await readPullRequest("/project", async () => {
        throw new Error(message);
      }),
      null,
    );
  }
  assert.equal(await readPullRequest("/project", async () => ({ stdout: "not json" })), null);
});

// Fork PRs can be absent from `gh pr view` even though `gh pr list --head` finds them.
test("uses the checked-out branch for fork PRs instead of its upstream base", async () => {
  const exec = async (command, args) => {
    if (command === "git") {
      assert.deepEqual(args, ["-C", "/project", "symbolic-ref", "--quiet", "--short", "HEAD"]);
      return { stdout: "project-menu\n" };
    }
    assert.deepEqual(args, [
      "pr",
      "list",
      "--head",
      "project-menu",
      "--state",
      "all",
      "--limit",
      "1",
      "--json",
      "number,url,state,title,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup",
    ]);
    return { stdout: JSON.stringify([{ number: 49, url: "https://github.com/example/project/pull/49", state: "MERGED", title }]) };
  };
  assert.deepEqual(await readPullRequest("/project", exec), {
    number: 49,
    url: "https://github.com/example/project/pull/49",
    state: "MERGED",
    title,
    isDraft: false,
    readyToMerge: false,
    hasConflicts: false,
    conflictStatusKnown: false,
    isBehind: false,
    changesRequested: false,
  });
});

for (const [name, overrides, ready] of [
  ["approved and clean", {}, true],
  ["not yet approved", { reviewDecision: "REVIEW_REQUIRED" }, false],
  ["changes requested", { reviewDecision: "CHANGES_REQUESTED" }, false],
  ["no review decision", { reviewDecision: null }, false],
  ["draft", { isDraft: true }, false],
  ["blocked", { mergeStateStatus: "BLOCKED" }, false],
  ["conflicts", { mergeStateStatus: "DIRTY" }, false],
  ["outdated branch", { mergeStateStatus: "BEHIND" }, false],
  ["non-passing checks", { mergeStateStatus: "UNSTABLE" }, false],
  ["unknown merge status", { mergeStateStatus: "UNKNOWN" }, false],
  ["already merged", { state: "MERGED" }, false],
]) {
  test(`merge readiness: ${name}`, async () => {
    const pr = { number: 10213, url, title, state: "OPEN", isDraft: false, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", ...overrides };
    const result = await readPullRequest("/project", async (command) => ({ stdout: command === "git" ? "feature/sidebar\n" : JSON.stringify([pr]) }));
    assert.equal(result.readyToMerge, ready);
  });
}

test("an open draft says so; a merged or closed one no longer counts as a draft", async () => {
  for (const [state, expected] of [
    ["OPEN", true],
    ["MERGED", false],
    ["CLOSED", false],
  ]) {
    const pr = { number: 10213, url, title, state, isDraft: true, mergeStateStatus: "DRAFT" };
    const result = await readPullRequest("/project", async (command) => ({ stdout: command === "git" ? "feature/sidebar\n" : JSON.stringify([pr]) }));
    assert.equal(result.isDraft, expected, state);
  }
});

for (const [state, mergeStateStatus, expected] of [
  ["OPEN", "DIRTY", true],
  ["OPEN", "CLEAN", false],
  ["OPEN", "UNKNOWN", false],
  ["OPEN", "BLOCKED", false],
  ["MERGED", "DIRTY", false],
]) {
  test(`conflict status: ${state} / ${mergeStateStatus}`, async () => {
    const pr = { number: 10213, url, title, state, mergeStateStatus };
    const result = await readPullRequest("/project", async (command) => ({ stdout: command === "git" ? "feature/sidebar\n" : JSON.stringify([pr]) }));
    assert.equal(result.hasConflicts, expected);
    assert.equal(result.conflictStatusKnown, mergeStateStatus !== "UNKNOWN");
  });
}

test("reads a PR the chat created or merged by its URL or number", async () => {
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push([command, args, options.cwd]);
    const ref = args[2];
    const number = Number(ref.split("/").at(-1));
    return {
      stdout: JSON.stringify({
        number,
        url: `https://github.com/example/project/pull/${number}`,
        state: number === 84 ? "MERGED" : "OPEN",
        title,
        mergeStateStatus: number === 90 ? "DIRTY" : "CLEAN",
      }),
    };
  };
  assert.deepEqual(await readPullRequests("/project", ["https://github.com/example/project/pull/84", "90"], exec), [
    {
      number: 84,
      url: "https://github.com/example/project/pull/84",
      state: "MERGED",
      title,
      isDraft: false,
      readyToMerge: false,
      hasConflicts: false,
      conflictStatusKnown: true,
      isBehind: false,
      changesRequested: false,
    },
    {
      number: 90,
      url: "https://github.com/example/project/pull/90",
      state: "OPEN",
      title,
      isDraft: false,
      readyToMerge: false,
      hasConflicts: true,
      conflictStatusKnown: true,
      isBehind: false,
      changesRequested: false,
    },
  ]);
  assert.deepEqual(
    calls.map(([command, args, cwd]) => [command, args.slice(0, 3), cwd]),
    [
      ["gh", ["pr", "view", "https://github.com/example/project/pull/84"], "/project"],
      ["gh", ["pr", "view", "90"], "/project"],
    ],
  );
});

test("never passes a ref gh could read as a flag, and a failed lookup is null", async () => {
  let ran = 0;
  const exec = async () => {
    ran++;
    throw new Error("not found");
  };
  assert.deepEqual(await readPullRequests("/project", ["--web", "-R", "javascript:alert(1)", "feature/x", 12, "91"], exec), [
    null,
    null,
    null,
    null,
    null,
    null,
  ]);
  assert.equal(ran, 1, "Only the numeric ref reached gh");
  assert.deepEqual(await readPullRequests("/project", "90", exec), []);
});

for (const [name, overrides, behind, changesRequested] of [
  ["outdated branch", { mergeStateStatus: "BEHIND" }, true, false],
  ["changes requested", { reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "BLOCKED" }, false, true],
  ["both", { reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "BEHIND" }, true, true],
  ["clean and approved", {}, false, false],
  ["merged", { state: "MERGED", reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "BEHIND" }, false, false],
]) {
  test(`blocking status: ${name}`, async () => {
    const pr = { number: 10213, url, title, state: "OPEN", isDraft: false, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", ...overrides };
    const result = await readPullRequest("/project", async (command) => ({ stdout: command === "git" ? "feature/sidebar\n" : JSON.stringify([pr]) }));
    assert.equal(result.isBehind, behind);
    assert.equal(result.changesRequested, changesRequested);
  });
}

const checkRun = (status, conclusion = null) => ({ __typename: "CheckRun", name: "CI / javascript", status, conclusion });
const commitStatus = (state) => ({ __typename: "StatusContext", context: "ci/legacy", state });
for (const [name, rollup, expected] of [
  ["one check still running", [checkRun("COMPLETED", "SUCCESS"), checkRun("IN_PROGRESS")], "running"],
  ["a queued check", [checkRun("QUEUED")], "running"],
  ["a pending commit status", [commitStatus("PENDING")], "running"],
  ["an expected commit status", [commitStatus("EXPECTED")], "running"],
  ["a failed check outranks running ones", [checkRun("IN_PROGRESS"), checkRun("COMPLETED", "FAILURE")], "failed"],
  ["a cancelled check", [checkRun("COMPLETED", "CANCELLED")], "failed"],
  ["a timed out check", [checkRun("COMPLETED", "TIMED_OUT")], "failed"],
  ["a failed commit status", [commitStatus("FAILURE")], "failed"],
  ["an errored commit status", [commitStatus("ERROR")], "failed"],
  ["all passed", [checkRun("COMPLETED", "SUCCESS"), commitStatus("SUCCESS")], undefined],
  ["skipped and neutral checks", [checkRun("COMPLETED", "SKIPPED"), checkRun("COMPLETED", "NEUTRAL")], undefined],
  ["no checks", [], undefined],
  ["rollup missing", undefined, undefined],
  ["malformed entries", [null, "x", {}], undefined],
]) {
  test(`checks state: ${name}`, async () => {
    const pr = { number: 10213, url, title, state: "OPEN", mergeStateStatus: "BLOCKED", statusCheckRollup: rollup };
    const result = await readPullRequest("/project", async (command) => ({ stdout: command === "git" ? "feature/sidebar\n" : JSON.stringify([pr]) }));
    assert.equal(result.checks, expected);
    assert.equal("checks" in result, expected !== undefined, "The field is only present while checks are running or failed");
  });
}

test("a merged PR reports no checks state even if its last run failed", async () => {
  const pr = { number: 10213, url, title, state: "MERGED", statusCheckRollup: [checkRun("COMPLETED", "FAILURE")] };
  const result = await readPullRequest("/project", async (command) => ({ stdout: command === "git" ? "feature/sidebar\n" : JSON.stringify([pr]) }));
  assert.equal("checks" in result, false);
});

// A gh/git stub: `branches` maps a worktree to its checked-out branch, `prs` is what `gh pr list` returns for the repository.
function batchStub({ branches, prs, repo = require("node:os").tmpdir() }) {
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push([command, args, options]);
    if (command === "git") {
      if (args.includes("symbolic-ref")) return { stdout: `${branches[args[1]]}\n` };
      if (args.includes("--git-common-dir")) return { stdout: `${repo}\n` };
      throw new Error(`unexpected git ${args.join(" ")}`);
    }
    assert.equal(command, "gh");
    if (args.includes("--head")) return { stdout: JSON.stringify(prs.filter((pr) => pr.headRefName === args[args.indexOf("--head") + 1]).slice(0, 1)) };
    return { stdout: JSON.stringify(args[args.indexOf("--state") + 1] === "open" ? prs.filter((pr) => pr.state === "OPEN") : prs) };
  };
  // Each batch is two lists: every PR without checks, and the open ones with them.
  return { exec, ghCalls: () => calls.filter(([command]) => command === "gh") };
}
const listed = (number, headRefName, state = "OPEN") => ({
  number,
  headRefName,
  url: `https://github.com/example/project/pull/${number}`,
  state,
  title: `PR ${number}`,
});
const shape = (number, state = "OPEN") => ({
  number,
  url: `https://github.com/example/project/pull/${number}`,
  state,
  title: `PR ${number}`,
  isDraft: false,
  readyToMerge: false,
  hasConflicts: false,
  conflictStatusKnown: false,
  isBehind: false,
  changesRequested: false,
});

test("worktrees of one repository share one batch: every PR without checks, the open ones with them", async () => {
  const { exec, ghCalls } = batchStub({
    branches: { "/a": "feature/a", "/b": "feature/b", "/c": "no-pr" },
    prs: [listed(2, "feature/b", "MERGED"), listed(1, "feature/a")],
  });
  const read = createPullRequestReader({ exec });
  assert.deepEqual(await Promise.all(["/a", "/b", "/c"].map((path) => read(path))), [shape(1), shape(2, "MERGED"), null]);
  assert.deepEqual(
    ghCalls().map(([, args]) => args),
    [
      ["pr", "list", "--state", "all", "--limit", "100", "--json", "number,url,state,title,isDraft,reviewDecision,mergeStateStatus,headRefName"],
      [
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        "number,url,state,title,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,headRefName",
      ],
    ],
  );
  assert.ok(["/a", "/b", "/c"].includes(ghCalls()[0][2].cwd), "gh runs from one of the repository's worktrees");
});

test("the batch is reused within the TTL and read again after it", async () => {
  let clock = 0;
  const { exec, ghCalls } = batchStub({ branches: { "/a": "feature/a" }, prs: [listed(1, "feature/a")] });
  const read = createPullRequestReader({ exec, now: () => clock, ttlMs: 2000 });
  await read("/a");
  clock = 1999;
  await read("/a");
  assert.equal(ghCalls().length, 2);
  clock = 2000;
  await read("/a");
  assert.equal(ghCalls().length, 4);
});

test("separate repositories are batched separately", async () => {
  const stub = batchStub({ branches: { "/a": "x" }, prs: [listed(1, "x")] });
  const other = batchStub({ branches: { "/b": "x" }, prs: [listed(7, "x")], repo: __dirname });
  const exec = (command, args, options) => (options.cwd === "/b" ? other.exec : stub.exec)(command, args, options);
  const read = createPullRequestReader({ exec });
  assert.deepEqual([await read("/a"), await read("/b")], [shape(1), shape(7)]);
  assert.equal(stub.ghCalls().length + other.ghCalls().length, 4);
});

test("the newest PR for a branch wins, a closed one too, like the per-branch query", async () => {
  const { exec } = batchStub({
    branches: { "/a": "feature/a", "/b": "feature/b" },
    prs: [listed(9, "feature/a"), listed(3, "feature/a", "MERGED"), listed(8, "feature/b", "CLOSED"), listed(4, "feature/b", "MERGED")],
  });
  const read = createPullRequestReader({ exec });
  assert.deepEqual(await read("/a"), shape(9));
  assert.deepEqual(await read("/b"), shape(8, "CLOSED"));
});

test("a branch missing from a full batch falls back to its own query", async () => {
  const prs = Array.from({ length: 100 }, (_, index) => listed(index + 1, `branch-${index}`));
  const old = listed(500, "old-branch", "MERGED");
  const { exec, ghCalls } = batchStub({ branches: { "/a": "branch-3", "/b": "old-branch" }, prs });
  const stub = async (command, args, options) =>
    command === "gh" && args.includes("--head") ? { stdout: JSON.stringify([old]) } : exec(command, args, options);
  const read = createPullRequestReader({ exec: stub });
  assert.deepEqual(await read("/a"), shape(4));
  assert.deepEqual(await read("/b"), shape(500, "MERGED"));
  assert.equal(ghCalls().length, 2, "only the counted batch calls; the fallback went through the stub");
});

test("a failed batch falls back to the per-branch query and is retried next time", async () => {
  let failing = true;
  const { exec } = batchStub({ branches: { "/a": "feature/a" }, prs: [listed(1, "feature/a")] });
  const calls = [];
  const flaky = async (command, args, options) => {
    if (command === "gh") calls.push(args.includes("--head") ? "branch" : "batch");
    if (command === "gh" && !args.includes("--head") && failing) throw new Error("timeout");
    return exec(command, args, options);
  };
  const read = createPullRequestReader({ exec: flaky });
  assert.deepEqual(await read("/a"), shape(1));
  failing = false;
  assert.deepEqual(await read("/a"), shape(1));
  assert.deepEqual(calls, ["batch", "batch", "branch", "batch", "batch"]);
});

test("an open PR takes its checks from the open list; one the open list missed falls back to its own query", async () => {
  const rollup = [checkRun("COMPLETED", "FAILURE")];
  const prs = [{ ...listed(3, "feature/a"), statusCheckRollup: rollup }, listed(2, "feature/b"), listed(1, "feature/b", "MERGED")];
  const { exec } = batchStub({ branches: { "/a": "feature/a", "/b": "feature/b" }, prs });
  const branchQueries = [];
  const stub = async (command, args, options) => {
    if (command === "gh" && args.includes("--head")) branchQueries.push(args[args.indexOf("--head") + 1]);
    // The open list lost #2, as when it opens between the two reads.
    if (command === "gh" && args.includes("open")) return { stdout: JSON.stringify([prs[0]]) };
    return exec(command, args, options);
  };
  const read = createPullRequestReader({ exec: stub });
  assert.equal((await read("/a")).checks, "failed");
  assert.equal((await read("/b")).number, 2);
  assert.deepEqual(branchQueries, ["feature/b"]);
});

test("no branch, no gh and bad output are null", async () => {
  assert.equal(await createPullRequestReader({ exec: async (command) => ({ stdout: command === "git" ? "\n" : "[]" }) })("/a"), null);
  assert.equal(
    await createPullRequestReader({
      exec: async () => {
        throw new Error("ENOENT");
      },
    })("/a"),
    null,
  );
  const { exec } = batchStub({ branches: { "/a": "x" }, prs: [] });
  const garbled = async (command, args, options) => (command === "gh" ? { stdout: "not json" } : exec(command, args, options));
  assert.equal(await createPullRequestReader({ exec: garbled })("/a"), null);
});

test("readPullRequestState reports a CLOSED PR as known, and a failed lookup as unknown", async () => {
  const closed = async (command) => {
    if (command === "git") return { stdout: "milagre/login\n" };
    return { stdout: JSON.stringify([{ number: 4, url, state: "CLOSED", title }]) };
  };
  const state = await readPullRequestState("/project/worktree", closed);
  assert.equal(state.known, true);
  assert.equal(state.pr.state, "CLOSED");
  assert.equal((await readPullRequest("/project/worktree", closed)).state, "CLOSED", "readPullRequest shows it closed");
  const down = async () => {
    throw new Error("gh is down");
  };
  assert.deepEqual(await readPullRequestState("/project/worktree", down), { known: false, pr: null });
  const none = async (command) => (command === "git" ? { stdout: "milagre/login\n" } : { stdout: "[]" });
  assert.deepEqual(await readPullRequestState("/project/worktree", none), { known: true, pr: null });
});
