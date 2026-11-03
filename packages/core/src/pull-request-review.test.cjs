const assert = require("node:assert/strict");
const test = require("node:test");
const { createPullRequestReview, GH_LOGIN, GH_MISSING } = require("./pull-request-review.cjs");

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

function prNode(overrides = {}) {
  return {
    id: "PR_1",
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    title: "fix: thing",
    body: "Body",
    state: "OPEN",
    isDraft: false,
    createdAt: "2026-10-25T10:00:00Z",
    updatedAt: "2026-10-25T11:00:00Z",
    author: { login: "victor" },
    baseRefName: "main",
    headRefName: "milagre/x",
    headRefOid: HEAD,
    baseRefOid: BASE,
    additions: 10,
    deletions: 2,
    changedFiles: 2,
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    viewerCanMergeAsAdmin: false,
    viewerDidAuthor: true,
    autoMergeRequest: null,
    labels: { nodes: [{ name: "mobile", color: "1d76db" }] },
    commits: { nodes: [{ commit: { oid: HEAD, messageHeadline: "fix: thing" } }] },
    checks: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  {
                    kind: "CheckRun",
                    name: "unit",
                    status: "COMPLETED",
                    conclusion: "SUCCESS",
                    checkSuite: { workflowRun: { workflow: { name: "CI" } } },
                  },
                  { kind: "CheckRun", name: "smoke", status: "COMPLETED", conclusion: "SKIPPED" },
                  { kind: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/lint" },
                  { kind: "StatusContext", context: "deploy", state: "PENDING" },
                ],
              },
            },
          },
        },
      ],
    },
    files: {
      nodes: [
        { path: "src/a.ts", additions: 8, deletions: 2, changeType: "MODIFIED" },
        { path: "src/b.ts", additions: 2, deletions: 0, changeType: "ADDED" },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    reviewRequests: { nodes: [{ requestedReviewer: { login: "jefo3" } }, { requestedReviewer: { combinedSlug: "acme/web" } }] },
    latestReviews: {
      nodes: [
        { author: { login: "marcos" }, state: "APPROVED", commit: { oid: HEAD } },
        { author: { login: "old" }, state: "CHANGES_REQUESTED", commit: { oid: BASE } },
      ],
    },
    reviewThreads: {
      nodes: [
        {
          id: "T_1",
          path: "src/a.ts",
          line: 31,
          originalLine: 30,
          diffSide: "RIGHT",
          isResolved: false,
          isOutdated: false,
          comments: {
            nodes: [{ id: "C_1", body: "Wait for the picker?", createdAt: "x", author: { login: "jefo3" }, pullRequestReview: { state: "COMMENTED" } }],
          },
        },
      ],
    },
    comments: { nodes: [] },
    pending: { nodes: [{ id: "R_9", comments: { totalCount: 2 } }] },
    ...overrides,
  };
}

/** A fake gh: answers queries by name, records every call. */
function fakeGh(answer) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push(args);
    const query = args.find((arg) => arg.startsWith("query="))?.slice(6) ?? "";
    const result = await answer(args, query);
    if (result instanceof Error) throw result;
    return { stdout: typeof result === "string" ? result : JSON.stringify(result ?? {}) };
  };
  return { exec, calls };
}

test("detail turns GitHub's PR into the panel's shape", async () => {
  const { exec } = fakeGh(() => ({ data: { repository: { pullRequest: prNode() } } }));
  const result = await createPullRequestReview({ exec }).detail({ cwd: "/w", number: 7 });
  assert.equal(result.ok, true);
  const pr = result.pr;
  assert.equal(pr.title, "fix: thing");
  // Failing first, then running, passing, skipped.
  assert.deepEqual(
    pr.checks.map((check) => [check.name, check.outcome]),
    [
      ["lint", "fail"],
      ["deploy", "running"],
      ["unit", "pass"],
      ["smoke", "skipped"],
    ],
  );
  assert.equal(pr.checks[2].workflow, "CI");
  assert.deepEqual(pr.reviewers, [
    { login: "marcos", state: "APPROVED" },
    { login: "old", state: "CHANGES_REQUESTED", stale: true },
    { login: "jefo3", state: "REQUESTED" },
    { login: "acme/web", state: "REQUESTED", team: true },
  ]);
  assert.deepEqual(
    pr.files.map((file) => [file.path, file.status]),
    [
      ["src/a.ts", "modified"],
      ["src/b.ts", "added"],
    ],
  );
  assert.deepEqual(pr.threads[0], {
    id: "T_1",
    path: "src/a.ts",
    line: 31,
    side: "RIGHT",
    resolved: false,
    outdated: false,
    comments: [{ id: "C_1", author: "jefo3", body: "Wait for the picker?", createdAt: "x" }],
  });
  assert.deepEqual(pr.pendingReview, { id: "R_9", count: 2 });
});

test("detail counts the folder's commits an open PR doesn't have yet", async () => {
  const { exec } = fakeGh(() => ({ data: { repository: { pullRequest: prNode() } } }));
  const runs = [];
  const git = { read: { run: async (cwd, args) => (runs.push(args), { ok: true, stdout: "2\n" }) } };
  const result = await createPullRequestReview({ exec, git }).detail({ cwd: "/w", number: 7 });
  assert.equal(result.pr.localCommits, 2);
  assert.deepEqual(runs, [["rev-list", "--count", `${HEAD}..HEAD`]]);
  const merged = fakeGh(() => ({ data: { repository: { pullRequest: prNode({ state: "MERGED" }) } } }));
  const none = await createPullRequestReview({ exec: merged.exec, git }).detail({ cwd: "/w", number: 7 });
  assert.equal(none.pr.localCommits, undefined, "A merged PR has nothing left to push to");
});

test("detail pages through more than 100 files", async () => {
  const { exec, calls } = fakeGh((_args, query) =>
    query.includes("after:$after")
      ? {
          data: {
            repository: {
              pullRequest: { files: { nodes: [{ path: "c.ts", additions: 1, deletions: 0, changeType: "ADDED" }], pageInfo: { hasNextPage: false } } },
            },
          },
        }
      : {
          data: {
            repository: {
              pullRequest: prNode({ files: { nodes: [{ path: "a.ts", additions: 1, deletions: 0 }], pageInfo: { hasNextPage: true, endCursor: "CUR" } } }),
            },
          },
        },
  );
  const result = await createPullRequestReview({ exec }).detail({ cwd: "/w", number: 7 });
  assert.deepEqual(
    result.pr.files.map((file) => file.path),
    ["a.ts", "c.ts"],
  );
  assert.ok(calls[1].includes("after=CUR"));
});

test("gh failures come back as the user's next step", async () => {
  const signedOut = Object.assign(new Error("exit 4"), { code: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login" });
  assert.deepEqual(await createPullRequestReview({ exec: fakeGh(() => signedOut).exec }).detail({ cwd: "/w", number: 7 }), { ok: false, message: GH_LOGIN });
  const missing = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
  assert.deepEqual(await createPullRequestReview({ exec: fakeGh(() => missing).exec }).detail({ cwd: "/w", number: 7 }), { ok: false, message: GH_MISSING });
  const graphql = { errors: [{ message: "Could not resolve to a PullRequest with the number of 9." }] };
  assert.deepEqual(await createPullRequestReview({ exec: fakeGh(() => graphql).exec }).detail({ cwd: "/w", number: 9 }), {
    ok: false,
    message: "Could not resolve to a PullRequest with the number of 9.",
  });
  assert.equal((await createPullRequestReview({ exec: fakeGh(() => ({})).exec }).detail({ cwd: "/w", number: -1 })).ok, false);
});

test("a line comment joins the pending review, creating it when there is none", async () => {
  const { exec, calls } = fakeGh((_args, query) => {
    if (query.includes("pending: reviews")) return { data: { repository: { pullRequest: { id: "PR_1", headRefOid: HEAD, pending: { nodes: [] } } } } };
    if (query.includes("addPullRequestReview(")) return { data: { addPullRequestReview: { pullRequestReview: { id: "R_new" } } } };
    return { data: { addPullRequestReviewThread: { thread: { id: "T_2" } } } };
  });
  const result = await createPullRequestReview({ exec }).comment({ cwd: "/w", number: 7, path: "src/a.ts", line: 12, body: "  Why here?  " });
  assert.deepEqual(result, { ok: true });
  const thread = calls.at(-1);
  assert.ok(thread.includes("review=R_new"));
  assert.ok(thread.includes("path=src/a.ts"));
  assert.ok(thread.includes("body=Why here?"));
  assert.ok(thread.includes("line=12"));
  assert.ok(calls[1].includes(`commit=${HEAD}`));
});

test("comments are checked before anything reaches GitHub", async () => {
  const { exec, calls } = fakeGh(() => ({ data: { repository: { pullRequest: { id: "PR_1", headRefOid: HEAD, pending: { nodes: [{ id: "R_1" }] } } } } }));
  const review = createPullRequestReview({ exec });
  assert.deepEqual(await review.comment({ cwd: "/w", number: 7, path: "../etc/passwd", line: 1, body: "x" }), {
    ok: false,
    message: "That file isn't in this PR.",
  });
  assert.deepEqual(await review.comment({ cwd: "/w", number: 7, path: "a.ts", line: 1, body: "   " }), { ok: false, message: "Write something first." });
  assert.deepEqual(await review.reply({ cwd: "/w", number: 7, threadId: "bad id!", body: "x" }), { ok: false, message: "That review item no longer exists." });
  // Only the pending-review lookups ran; no mutation did.
  assert.ok(calls.every((args) => !args.some((arg) => arg.includes("mutation"))));
});

test("submit sends the pending review, or a bare review when nothing is pending", async () => {
  let pending = [{ id: "R_1" }];
  const { exec, calls } = fakeGh((_args, query) =>
    query.includes("pending: reviews")
      ? { data: { repository: { pullRequest: { id: "PR_1", headRefOid: HEAD, pending: { nodes: pending } } } } }
      : { data: {} },
  );
  const review = createPullRequestReview({ exec });
  assert.deepEqual(await review.submit({ cwd: "/w", number: 7, event: "APPROVE", body: "" }), { ok: true });
  assert.ok(calls.at(-1).some((arg) => arg.includes("submitPullRequestReview")));
  assert.ok(calls.at(-1).includes("review=R_1"));
  pending = [];
  assert.deepEqual(await review.submit({ cwd: "/w", number: 7, event: "COMMENT", body: "" }), {
    ok: false,
    message: "Write a comment or add one to a line first.",
  });
  assert.deepEqual(await review.submit({ cwd: "/w", number: 7, event: "APPROVE", body: "" }), { ok: true });
  assert.ok(calls.at(-1).some((arg) => arg.includes("addPullRequestReview(")));
  assert.deepEqual(await review.submit({ cwd: "/w", number: 7, event: "MERGE", body: "" }), {
    ok: false,
    message: "Choose Comment, Approve or Request changes.",
  });
});

test("merge and ready run gh pr with only known flags", async () => {
  const { exec, calls } = fakeGh(() => "");
  const review = createPullRequestReview({ exec });
  await review.merge({ cwd: "/w", number: 7, method: "squash" });
  await review.merge({ cwd: "/w", number: 7, method: "rebase", auto: true, admin: true });
  await review.merge({ cwd: "/w", number: 7, disableAuto: true });
  await review.ready({ cwd: "/w", number: 7, draft: true });
  assert.deepEqual(calls, [
    ["pr", "merge", "7", "--squash"],
    ["pr", "merge", "7", "--rebase", "--auto"],
    ["pr", "merge", "7", "--disable-auto"],
    ["pr", "ready", "7", "--undo"],
  ]);
  assert.deepEqual(await review.merge({ cwd: "/w", number: 7, method: "--admin" }), { ok: false, message: "Choose squash, merge or rebase." });
});

test("labels and reviewers read the repo and edit the PR through gh pr edit", async () => {
  const { exec, calls } = fakeGh((args) =>
    args[0] === "label" ? [{ name: "bug", color: "d73a4a", description: "Broken" }, { name: "" }] : args[0] === "api" ? "octo\nhubot\n" : "",
  );
  const review = createPullRequestReview({ exec });
  assert.deepEqual(await review.labels({ cwd: "/w" }), { ok: true, labels: [{ name: "bug", color: "d73a4a", description: "Broken" }] });
  assert.deepEqual(await review.reviewerCandidates({ cwd: "/w" }), { ok: true, logins: ["octo", "hubot"] });
  await review.setLabels({ cwd: "/w", number: 7, add: ["good first issue", 'size: "S", fast'], remove: ["bug"] });
  await review.requestReviewers({ cwd: "/w", number: 7, add: ["octo", "acme/web"], remove: ["hubot"] });
  assert.deepEqual(await review.setLabels({ cwd: "/w", number: 7, add: [], remove: [] }), { ok: true }, "Nothing to change runs nothing");
  assert.deepEqual(calls.slice(2), [
    ["pr", "edit", "7", '--add-label="good first issue"', '--add-label="size: ""S"", fast"', '--remove-label="bug"'],
    ["pr", "edit", "7", "--add-reviewer=octo", "--add-reviewer=acme/web", "--remove-reviewer=hubot"],
  ]);
  assert.deepEqual(await review.requestReviewers({ cwd: "/w", number: 7, add: ["--admin x"] }), { ok: false, message: "That isn't a GitHub user." });
  assert.deepEqual(await review.setLabels({ cwd: "/w", number: 7, add: "bug" }), { ok: false, message: "That isn't a label." });
});

test("a PR attachment is read with gh's token, which goes to github.com only", async () => {
  const url = "https://github.com/user-attachments/assets/1a75943a-4133-4d9d-8fa3-99d4a0b689da";
  const signed = "https://github-production-user-asset.s3.amazonaws.com/1/shot.png?X-Amz-Signature=x";
  const { exec, calls } = fakeGh(() => "gho_token\n");
  const requests = [];
  const fetch = async (to, init = {}) => {
    requests.push([to, init.headers?.Authorization ?? null]);
    if (to === url) return new Response(null, { status: 302, headers: { location: signed } });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  };
  const review = createPullRequestReview({ exec, fetch });
  assert.deepEqual(await review.image({ cwd: "/w", url }), { ok: true, dataUrl: "data:image/png;base64,AQID" });
  assert.deepEqual(calls, [["auth", "token", "--hostname", "github.com"]]);
  assert.deepEqual(requests, [
    [url, "token gho_token"],
    [signed, null],
  ]);
  for (const other of ["https://evil.example/user-attachments/assets/1a75943a-4133-4d9d-8fa3-99d4a0b689da", "http://127.0.0.1:8080/x.png", `${url}/../x`]) {
    assert.deepEqual(await review.image({ cwd: "/w", url: other }), { ok: false, message: "That isn't a GitHub image." });
  }
  assert.equal(requests.length, 2, "No other address is fetched");
  const html = createPullRequestReview({
    exec,
    fetch: async (to) =>
      to === url ? new Response(null, { status: 302, headers: { location: signed } }) : new Response("<html>", { headers: { "content-type": "text/html" } }),
  });
  assert.deepEqual(await html.image({ cwd: "/w", url }), { ok: false, message: "GitHub didn't send this image." });
});

test("repository screenshots use GitHub's raw contents API and never forward credentials to storage", async () => {
  const url = "https://github.com/acme/app/blob/abc123/.pr-assets/11965/asset1.png?raw=true";
  const api = "https://api.github.com/repos/acme/app/contents/.pr-assets/11965/asset1.png?ref=abc123";
  for (const redirect of [false, true]) {
    const requests = [];
    const review = createPullRequestReview({
      exec: fakeGh(() => "gho_token\n").exec,
      fetch: async (to, init = {}) => {
        requests.push([to, init]);
        if (redirect && to === api) return new Response(null, { status: 302, headers: { location: "https://storage.example/signed.png" } });
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/vnd.github.raw+json; charset=utf-8" } });
      },
    });
    assert.deepEqual(await review.image({ cwd: "/w", url }), { ok: true, dataUrl: "data:image/png;base64,AQID" });
    assert.deepEqual(requests[0], [api, { redirect: "manual", headers: { Authorization: "token gho_token", Accept: "application/vnd.github.raw+json" } }]);
    if (redirect) assert.deepEqual(requests[1], ["https://storage.example/signed.png", { redirect: "manual" }]);
    else assert.equal(requests.length, 1);
  }
});

test("renamed repositories keep authentication and raw media type only within the GitHub API", async () => {
  const url = "https://raw.githubusercontent.com/acme/old/main/shot.png";
  const canonical = "https://api.github.com/repositories/12/contents/shot.png?ref=main";
  const requests = [];
  const review = createPullRequestReview({
    exec: fakeGh(() => "token").exec,
    fetch: async (to, init = {}) => {
      requests.push([to, init]);
      if (requests.length === 1) return new Response(null, { status: 301, headers: { location: canonical } });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/vnd.github.raw+json" } });
    },
  });
  assert.deepEqual(await review.image({ cwd: "/w", url }), { ok: true, dataUrl: "data:image/png;base64,AQID" });
  assert.deepEqual(requests[1], [canonical, { redirect: "manual", headers: { Authorization: "token token", Accept: "application/vnd.github.raw+json" } }]);
  let fetched = 0;
  const loop = createPullRequestReview({
    exec: fakeGh(() => "token").exec,
    fetch: async () => (++fetched, new Response(null, { status: 301, headers: { location: canonical } })),
  });
  assert.deepEqual(await loop.image({ cwd: "/w", url }), { ok: false, message: "GitHub didn't send this image." });
  assert.equal(fetched, 4, "redirect loops are bounded");
});

test("a GitHub upload may return image bytes directly; HTML and oversized images still fail", async () => {
  const url = "https://github.com/user-attachments/assets/1a75943a-4133-4d9d-8fa3-99d4a0b689da";
  for (const [type, size, expected] of [
    ["image/png", "3", { ok: true, dataUrl: "data:image/png;base64,AQID" }],
    ["text/html", "3", { ok: false, message: "GitHub didn't send this image." }],
    ["image/png", String(16 * 1024 * 1024), { ok: false, message: "This image is too large to show here." }],
  ]) {
    const review = createPullRequestReview({
      exec: fakeGh(() => "token").exec,
      fetch: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": type, "content-length": size } }),
    });
    assert.deepEqual(await review.image({ cwd: "/w", url }), expected);
  }
});

test("the PR diff needs real commit ids", async () => {
  const review = createPullRequestReview({ exec: fakeGh(() => ({})).exec });
  assert.deepEqual(await review.diffFiles({ cwd: "/w", base: "main", head: HEAD }), {
    ok: false,
    message: "This PR's commits aren't known yet. Refresh and try again.",
  });
});
