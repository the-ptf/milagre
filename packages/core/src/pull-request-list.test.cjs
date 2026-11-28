const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createPullRequestList, githubRepo, searchQueries, toChecks } = require("./pull-request-list.cjs");

const node = (number, change = {}) => ({
  number,
  title: `Change ${number}`,
  url: `https://github.com/acme/web/pull/${number}`,
  state: "OPEN",
  isDraft: false,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-02T00:00:00Z",
  additions: 12,
  deletions: 3,
  mergeable: "MERGEABLE",
  reviewDecision: "REVIEW_REQUIRED",
  headRefName: `branch-${number}`,
  baseRefName: "main",
  author: { login: "lee", avatarUrl: "https://avatars.example/lee" },
  repository: { nameWithOwner: "acme/web" },
  labels: { nodes: [{ name: "bug", color: "d73a4a" }] },
  reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "dana" } }] },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            state: "PENDING",
            contexts: {
              checkRunCountsByState: [
                { state: "SUCCESS", count: 6 },
                { state: "IN_PROGRESS", count: 2 },
                { state: "SKIPPED", count: 1 },
              ],
              statusContextCountsByState: [{ state: "FAILURE", count: 0 }],
            },
          },
        },
      },
    ],
  },
  ...change,
});

function fakeGh(answers) {
  const calls = [];
  const exec = async (command, args) => {
    assert.equal(command, "gh");
    const query = args[args.indexOf("-f") + 1].replace(/^query=/, "");
    const q = args.find((arg) => arg.startsWith("q="))?.slice(2) ?? null;
    calls.push({ query, q, args });
    const answer = answers(query, q, args);
    if (answer instanceof Error) throw answer;
    return { stdout: JSON.stringify(answer) };
  };
  return { exec, calls };
}

const projects = [
  { path: "/code/web", name: "web", origin: "github.com/acme/web-old" },
  { path: "/code/web-2", name: "web 2", origin: "github.com/acme/web-old" },
  { path: "/code/gone", name: "gone", origin: "github.com/acme/gone" },
  { path: "/code/lab", name: "lab", origin: "gitlab.com/acme/lab" },
  { path: "/code/plain", name: "plain", origin: null },
];

test("resolves renamed repositories, drops unknown ones and searches once", async () => {
  const { exec, calls } = fakeGh((query) =>
    query.startsWith("query{")
      ? { data: { r0: { nameWithOwner: "acme/web" }, r1: null } }
      : { data: { viewer: { login: "dana" }, search: { nodes: [node(7), node(8, { author: { login: "dana", avatarUrl: null } })] } } },
  );
  const list = createPullRequestList({ exec, now: () => 1000 });
  const result = await list.list({ projects, chatsFor: (url) => (url.endsWith("/8") ? [{ projectPath: "/code/web", chatId: 3, title: "Login" }] : []) });
  assert.deepEqual(result.repos, ["acme/web"]);
  assert.equal(calls.length, 2);
  assert.match(calls[0].query, /r0:repository\(owner:"acme",name:"web-old"\)/);
  assert.match(calls[0].query, /r1:repository\(owner:"acme",name:"gone"\)/);
  assert.equal(calls[1].q, "repo:acme/web is:pr is:open sort:updated-desc");
  assert.equal(result.viewer, "dana");
  assert.deepEqual(result.errors, []);
  const [first, second] = result.items;
  assert.equal(first.reviewRequested, true);
  assert.equal(first.authored, false);
  assert.deepEqual(first.checks, { state: "running", passed: 6, failed: 0, running: 2, skipped: 1, total: 9 });
  assert.deepEqual(first.labels, [{ name: "bug", color: "d73a4a" }]);
  assert.deepEqual(
    first.projects.map((project) => project.path),
    ["/code/web", "/code/web-2"],
  );
  assert.equal(first.projects[0].cwd, "/code/web");
  assert.equal(second.authored, true);
  assert.deepEqual(second.chats, [{ projectPath: "/code/web", chatId: 3, title: "Login" }]);
});

test("answers from a minute's cache, and reads again when forced or stale", async () => {
  let at = 0;
  const { exec, calls } = fakeGh((query) =>
    query.startsWith("query{") ? { data: { r0: { nameWithOwner: "acme/web" } } } : { data: { viewer: { login: "dana" }, search: { nodes: [node(1)] } } },
  );
  const list = createPullRequestList({ exec, now: () => at });
  const only = [projects[0]];
  await list.list({ projects: only });
  await list.list({ projects: only });
  assert.equal(calls.filter((call) => call.q).length, 1);
  await list.list({ projects: only, force: true });
  assert.equal(calls.filter((call) => call.q).length, 2);
  at = 61_000;
  await list.list({ projects: only });
  assert.equal(calls.filter((call) => call.q).length, 3);
  assert.equal(calls.filter((call) => !call.q).length, 1, "repositories stay resolved for an hour");
  await list.list({ projects: only, state: "merged" });
  assert.equal(calls.at(-1).q, "repo:acme/web is:pr is:merged sort:updated-desc");
});

test("a failed search reports gh's words and keeps the other chunks", async () => {
  const many = Array.from({ length: 30 }, (_, index) => ({ path: `/code/p${index}`, name: `p${index}`, origin: `github.com/acme/project-number-${index}` }));
  const { exec, calls } = fakeGh((query, q) => {
    if (query.startsWith("query{"))
      return { data: Object.fromEntries(many.map((_, index) => [`r${index}`, { nameWithOwner: `acme/project-number-${index}` }])) };
    if (q.includes("project-number-0 ")) return Object.assign(new Error("gh failed"), { stderr: "GraphQL: API rate limit exceeded" });
    return { data: { viewer: { login: "dana" }, search: { nodes: [node(Number(/number-(\d+)/.exec(q)[1]) + 100)] } } };
  });
  const result = await createPullRequestList({ exec }).list({ projects: many });
  const searches = calls.filter((call) => call.q);
  assert.ok(searches.length > 1);
  assert.ok(searches.every((call) => call.q.length <= 256));
  assert.deepEqual(result.errors, ["API rate limit exceeded"]);
  assert.equal(result.items.length, searches.length - 1);
});

test("checks of a PR read failures first with their workflow and times", async () => {
  const { exec, calls } = fakeGh(() => ({
    data: {
      repository: {
        pullRequest: {
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          kind: "CheckRun",
                          name: "lint",
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                          detailsUrl: "https://ci/1",
                          startedAt: "2026-11-01T00:00:00Z",
                          completedAt: "2026-11-01T00:01:00Z",
                          checkSuite: { workflowRun: { workflow: { name: "CI" } } },
                        },
                        { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: null, checkSuite: null },
                        { kind: "StatusContext", context: "deploy", state: "PENDING", targetUrl: "https://deploy", createdAt: "2026-11-01T00:00:00Z" },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  }));
  const checks = await createPullRequestList({ exec }).checksOf({ repo: "acme/web", number: 7 });
  assert.deepEqual(
    checks.map((check) => [check.name, check.state, check.workflow]),
    [
      ["unit", "fail", null],
      ["deploy", "running", null],
      ["lint", "pass", "CI"],
    ],
  );
  assert.equal(checks[2].completedAt, "2026-11-01T00:01:00Z");
  assert.ok(calls[0].args.includes("number=7"));
  assert.throws(() => createPullRequestList({ exec }).checksOf({ repo: "acme/web; rm", number: 7 }));
});

test("only github.com origins become repositories", () => {
  assert.deepEqual(githubRepo("github.com/acme/web"), { owner: "acme", name: "web" });
  assert.equal(githubRepo("gitlab.com/acme/web"), null);
  assert.equal(githubRepo('github.com/acme/we"b'), null);
  assert.deepEqual(searchQueries([], "open"), []);
  assert.equal(searchQueries(["a/b"], "closed")[0], "repo:a/b is:pr is:closed is:unmerged sort:updated-desc");
  assert.equal(searchQueries(["a/b"], "all")[0], "repo:a/b is:pr sort:updated-desc");
  assert.deepEqual(toChecks(null), { state: "none", passed: 0, failed: 0, running: 0, skipped: 0, total: 0 });
});

test("an empty checks answer is not kept: a new head commit gets its checks on the next read", async () => {
  let contexts = [];
  const { exec, calls } = fakeGh(() => ({
    data: { repository: { pullRequest: { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: contexts } } } }] } } } },
  }));
  const list = createPullRequestList({ exec, now: () => 0 });
  assert.deepEqual(await list.checksOf({ repo: "acme/web", number: 7 }), []);
  contexts = [{ kind: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: null }];
  assert.equal((await list.checksOf({ repo: "acme/web", number: 7 })).length, 1);
  await list.checksOf({ repo: "acme/web", number: 7 });
  assert.equal(calls.length, 2);
});

test("all open PRs are read across cursors and above GitHub's search result limit", async () => {
  for (const count of [101, 1001]) {
    const { exec, calls } = fakeGh((query, q, args) => {
      if (query.startsWith("query{")) return { data: { r0: { nameWithOwner: "acme/web" } } };
      const last = args.includes("after=next");
      const page = { nodes: [node(last ? 2 : 1)], pageInfo: { hasNextPage: !last, endCursor: last ? null : "next" } };
      if (q) return { data: { viewer: { login: "dana" }, search: { issueCount: count, ...page } } };
      assert.ok(args.includes("states[]=OPEN"));
      return { data: { repository: { pullRequests: page } } };
    });
    const result = await createPullRequestList({ exec }).list({ projects: [projects[0]] });
    assert.deepEqual(
      result.items.map((item) => item.number),
      [1, 2],
    );
    assert.equal(calls.length, count > 1000 ? 4 : 3);
  }
});

const badGateway = () =>
  Object.assign(new Error("Command failed: gh api graphql"), { code: 1, stderr: "gh: HTTP 502\n", stdout: "<!DOCTYPE html><title>Unicorn! · GitHub</title>" });
const noWait = { sleep: async () => {} };

test("GitHub's 5xx asks again with half the page, then keeps the last rows quietly for five minutes", async () => {
  let at = 0;
  let down = () => false;
  const { exec, calls } = fakeGh((query, q, args) => {
    if (query.startsWith("query{")) return { data: { r0: { nameWithOwner: "acme/web" } } };
    if (down(args)) return badGateway();
    return { data: { viewer: { login: "dana" }, search: { nodes: [node(1)] } } };
  });
  const list = createPullRequestList({ exec, now: () => at, retry: noWait });
  const only = [projects[0]];
  const pages = () => calls.filter((call) => call.q).map((call) => call.args.find((arg) => arg.startsWith("first=")));

  down = (args) => args.includes("first=50");
  const retried = await list.list({ projects: only });
  assert.deepEqual(pages(), ["first=50", "first=25"]);
  assert.deepEqual(retried.errors, []);
  assert.deepEqual(
    retried.items.map((item) => item.number),
    [1],
  );

  down = () => true;
  at = 61_000;
  const quiet = await list.list({ projects: only });
  assert.deepEqual(pages().slice(2), ["first=50", "first=25", "first=12"]);
  assert.deepEqual(quiet.errors, []);
  assert.equal(quiet.viewer, "dana");
  assert.deepEqual(
    quiet.items.map((item) => item.number),
    [1],
  );

  at = 6 * 60_000;
  const noted = await list.list({ projects: only, force: true });
  assert.deepEqual(noted.errors, ["GitHub didn't answer in time (HTTP 502). Showing the last pull requests loaded."]);
  assert.equal(noted.items.length, 1);

  const fresh = await createPullRequestList({ exec, now: () => at, retry: noWait }).list({ projects: only });
  assert.deepEqual(fresh.errors, ["GitHub didn't answer in time (HTTP 502). Try again in a moment."]);
  assert.deepEqual(fresh.items, []);
});

test("a 5xx resolving repositories keeps last hour's names, and says GitHub timed out when there are none", async () => {
  let at = 0;
  let down = false;
  const { exec, calls } = fakeGh((query) => {
    if (query.startsWith("query{")) return down ? badGateway() : { data: { r0: { nameWithOwner: "acme/web" } } };
    return { data: { viewer: { login: "dana" }, search: { nodes: [node(1)] } } };
  });
  const list = createPullRequestList({ exec, now: () => at, retry: noWait });
  await list.list({ projects: [projects[0]] });
  down = true;
  at = 2 * 60 * 60_000;
  const stale = await list.list({ projects: [projects[0]] });
  assert.deepEqual(stale.repos, ["acme/web"]);
  assert.equal(calls.at(-1).q, "repo:acme/web is:pr is:open sort:updated-desc");
  await assert.rejects(createPullRequestList({ exec, retry: noWait }).list({ projects: [projects[0]] }), {
    message: "GitHub didn't answer in time (HTTP 502). Try again in a moment.",
  });
});
