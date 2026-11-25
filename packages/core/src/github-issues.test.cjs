const assert = require("node:assert/strict");
const test = require("node:test");
const { createGithubIssues } = require("./github-issues.cjs");

const failure = (stderr, code = 1) => Object.assign(new Error("gh failed"), { stderr, code });
const node = (number, extra = {}) => ({
  number,
  title: `Issue ${number}`,
  url: `https://github.com/acme/web/issues/${number}`,
  state: "OPEN",
  stateReason: "",
  author: { login: "dana" },
  labels: [{ name: "bug" }],
  ...extra,
});

function fakeGh(answer) {
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env });
    const result = await answer(args);
    return { stdout: JSON.stringify(result), stderr: "" };
  };
  return { exec, calls };
}

const repoView = { nameWithOwner: "acme/web", url: "https://github.com/acme/web", hasIssuesEnabled: true };

test("the picker lists the Project's open issues, newest activity first, through the host's gh without prompts", async () => {
  const gh = fakeGh((args) => (args[0] === "repo" ? repoView : [node(3), node(2)]));
  const issues = createGithubIssues({ exec: gh.exec, env: () => ({ PATH: "/bin" }) });
  const result = await issues.list("/p", "");
  assert.deepEqual(result, {
    repo: "acme/web",
    issues: [3, 2].map((number) => ({
      repo: "acme/web",
      number,
      title: `Issue ${number}`,
      url: `https://github.com/acme/web/issues/${number}`,
      state: "open",
      author: "dana",
      labels: ["bug"],
    })),
  });
  assert.deepEqual(gh.calls[1].args, [
    "issue",
    "list",
    "--repo=acme/web",
    "--state=open",
    "--limit=30",
    "--json=number,title,url,state,stateReason,author,labels",
    "--search=sort:updated-desc",
  ]);
  assert.equal(gh.calls[1].cwd, "/p");
  assert.equal(gh.calls[1].env.GH_PROMPT_DISABLED, "1");
  await issues.list("/p", "");
  assert.equal(gh.calls.length, 2, "a second open within a minute reads the cache");
  await issues.list("/p", "", { fresh: true });
  assert.equal(gh.calls.length, 4, "Refresh asks gh again");
});

test("a search that looks like a flag stays the search value", async () => {
  const gh = fakeGh((args) => (args[0] === "repo" ? repoView : []));
  await createGithubIssues({ exec: gh.exec }).list("/p", "--repo=evil/x login");
  assert.equal(gh.calls[1].args.at(-1), "--search=--repo=evil/x login");
  assert.ok(gh.calls[1].args.includes("--repo=acme/web"));
});

test("a pasted link reads that issue, even from another repository or a Project with no GitHub remote", async () => {
  const gh = fakeGh((args) => {
    if (args[0] === "repo") throw failure("no git remotes found");
    return node(9, { url: "https://github.com/acme/api/issues/9", state: "CLOSED", stateReason: "NOT_PLANNED" });
  });
  const result = await createGithubIssues({ exec: gh.exec }).list("/p", "https://github.com/acme/api-old/issues/9");
  assert.equal(result.repo, "acme/api", "the repository the issue's own URL names, after a rename too");
  assert.deepEqual(
    result.issues.map((issue) => [issue.repo, issue.number, issue.state, issue.closedAs]),
    [["acme/api", 9, "closed", "not_planned"]],
  );
  assert.deepEqual(gh.calls[0].args.slice(0, 3), ["issue", "view", "9"]);
  assert.equal(gh.calls.length, 1);
});

test("a typed number puts that issue first, then the search matches without it twice", async () => {
  const gh = fakeGh((args) => {
    if (args[0] === "repo") return repoView;
    if (args[1] === "view") return node(12);
    return [node(40), node(12)];
  });
  const result = await createGithubIssues({ exec: gh.exec }).list("/p", "#12");
  assert.deepEqual(
    result.issues.map((issue) => issue.number),
    [12, 40],
  );
});

test("each way gh can't answer becomes a message that says what to do", async () => {
  const cases = [
    [Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }), "gh-missing", /Install the GitHub CLI \(`brew install gh`\)/],
    [failure("To get started with GitHub CLI, please run:  gh auth login", 4), "gh-auth", /Run `gh auth login` in a terminal/],
    [failure("none of the git remotes configured for this repository point to a known GitHub host"), "no-github", /no GitHub remote/],
    [failure("failed to run git: fatal: not a git repository"), "no-github", /no GitHub remote/],
    [Object.assign(new Error("timeout"), { killed: true }), "failed", /too long/],
    [failure("HTTP 502: Bad Gateway\nmore"), "failed", /^HTTP 502: Bad Gateway$/],
  ];
  for (const [error, code, message] of cases) {
    const gh = fakeGh(() => {
      throw error;
    });
    const result = await createGithubIssues({ exec: gh.exec, platform: "darwin" }).list("/p", "");
    assert.equal(result.code, code, String(error.stderr ?? error.message));
    assert.match(result.error, message);
  }
  const off = fakeGh(() => ({ ...repoView, hasIssuesEnabled: false }));
  assert.deepEqual(await createGithubIssues({ exec: off.exec }).list("/p", ""), { error: "Issues are turned off for acme/web.", code: "issues-off" });
});

test("reading one issue brings its body and newest comments, and refuses pull requests and missing issues", async () => {
  const comments = Array.from({ length: 60 }, (_, index) => ({ author: { login: `u${index}` }, body: `c${index}`, createdAt: "2026-11-20T10:00:00Z" }));
  const gh = fakeGh((args) => {
    if (args[2] === "1169") return node(1169, { url: "https://github.com/acme/web/pull/1169" });
    if (args[2] === "404") throw failure("GraphQL: Could not resolve to an issue or pull request with the number of 404. (repository.issue)");
    if (args[3] === "--repo=acme/gone") throw failure("GraphQL: Could not resolve to a Repository with the name 'acme/gone'. (repository)");
    return node(12, { url: "https://github.com/acme/web-renamed/issues/12", body: "Steps", comments });
  });
  const issues = createGithubIssues({ exec: gh.exec });
  const issue = await issues.readIssue("/p", { repo: "acme/web", number: 12 });
  assert.equal(issue.repo, "acme/web-renamed", "the issue's own URL names its repository");
  assert.equal(issue.body, "Steps");
  assert.equal(issue.commentCount, 60);
  assert.equal(issue.comments.length, 50);
  assert.deepEqual(issue.comments.at(-1), { author: "u59", body: "c59", at: "2026-11-20T10:00:00Z" });
  await assert.rejects(issues.readIssue("/p", { repo: "acme/web", number: 1169 }), {
    code: "pull-request",
    message: "acme/web#1169 is a pull request, not an issue.",
  });
  await assert.rejects(issues.readIssue("/p", { repo: "acme/web", number: 404 }), {
    code: "not-found",
    message: "acme/web#404 doesn't exist, or gh can't see it.",
  });
  await assert.rejects(issues.readIssue("/p", { repo: "acme/gone", number: 1 }), { code: "no-access", message: /gh can't see acme\/gone#1/ });
});
