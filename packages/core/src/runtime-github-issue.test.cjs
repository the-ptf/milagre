const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");
const { GithubIssueError } = require("./github-issues.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");

const issue = {
  repo: "acme/web",
  number: 12,
  title: "Fix the login redirect",
  url: "https://github.com/acme/web/issues/12",
  state: "open",
  author: "dana",
  body: "Users bounce to /home.",
  comments: [{ author: "lee", body: "Only on Safari.", at: "2026-11-20T10:00:00Z" }],
  commentCount: 1,
};

async function fixture(t, { reachable = true } = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-github-issue-")));
  const project = path.join(dir, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-qb", "main", project]);
  execFileSync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "Initial"]);
  const turns = [];
  const reads = [];
  const githubIssues = {
    list: async (projectPath, query) => ({ repo: "acme/web", issues: [issue], projectPath, query }),
    readIssue: async (projectPath, ref, options) => {
      reads.push({ projectPath, ref, options });
      if (!reachable) throw new GithubIssueError("gh-auth", "gh isn't signed in to GitHub on this computer. Run `gh auth login` in a terminal.");
      return issue;
    },
  };
  const runtime = createRuntime({
    dataDir: path.join(dir, "data"),
    chatsHome: path.join(dir, "chats"),
    worktreeRoot: path.join(dir, "worktrees"),
    registryRoots: [],
    cwd: project,
    environmentReady: Promise.resolve(),
    titleModels: {},
    agentCli: async () => ({ command: "fixture" }),
    githubIssues,
    createSession(_provider, options) {
      return {
        turnActive: false,
        startTurn: async (request) => {
          turns.push(request);
          options.emit({ type: "turn-started", turnId: "turn" });
          return { turnId: "turn" };
        },
        interrupt: async () => options.emit({ type: "turn-cancelled" }),
        close: async () => {},
      };
    },
  });
  t.after(async () => {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const opened = await runtime.openProject(project);
  const sessionId = Object.values(opened.state.sessions)[0].id;
  const send = (extra) =>
    runtime.invoke("chat:send", [
      {
        projectPath: project,
        sessionId,
        body: "Work on GitHub issue acme/web#12: stale title",
        prompt: "Work on GitHub issue acme/web#12: stale title",
        images: [],
        files: [],
        provider: "codex",
        model: "test",
        permissionMode: "full",
        ...extra,
      },
    ]);
  const messages = async () => (await runtime.invoke("project:snapshot", [project])).state.messages.filter((m) => m.role === "user");
  return { send, turns, reads, messages, runtime, project, dir };
}

test("a Chat started from a GitHub issue stores the host's fresh copy as a card and gives the agent the thread as data", async (t) => {
  const f = await fixture(t);
  await f.send({ githubIssue: { repo: "acme/web", number: 12, note: "check Safari too" } });
  await waitUntil(() => f.turns.length === 1);
  const [message] = await f.messages();
  assert.equal(message.body, `Work on GitHub issue acme/web#12: Fix the login redirect\n\n${issue.url}\n\ncheck Safari too`);
  assert.deepEqual(message.context, {
    kind: "github-issue",
    repo: "acme/web",
    number: 12,
    title: issue.title,
    url: issue.url,
    state: "open",
    note: "check Safari too",
  });
  assert.deepEqual(f.reads[0].ref, { repo: "acme/web", number: 12, note: "check Safari too" });
  assert.equal(f.reads[0].projectPath, f.project, "gh runs in the Project, on its own computer");
  assert.ok(f.turns[0].prompt.startsWith('The user asks: check Safari too\n\n<github_issue repo="acme/web" number="12">'), f.turns[0].prompt);
  assert.match(f.turns[0].prompt, /@lee on 2026-11-20:\nOnly on Safari\./);
  assert.match(f.turns[0].prompt, /gh issue view 12 --repo acme\/web --comments/);
});

test("when gh can't read the issue, the Chat still starts with the text that was sent", async (t) => {
  const f = await fixture(t, { reachable: false });
  await f.send({ githubIssue: { repo: "acme/web", number: 12 } });
  await waitUntil(() => f.turns.length === 1);
  const [message] = await f.messages();
  assert.equal(message.context, null);
  assert.equal(message.body, "Work on GitHub issue acme/web#12: stale title");
});

test("a malformed issue request is refused before anything runs, and a renderer can't write the card itself", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.send({ githubIssue: { repo: "--repo=evil/x", number: 12 } }), /GitHub issue isn't valid/);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(await f.messages(), []);
  await f.send({ context: { kind: "github-issue", repo: "acme/web", number: 1, title: "x", url: "u", state: "open" } });
  await waitUntil(() => f.turns.length === 1);
  assert.equal((await f.messages())[0].context, null);
});

test("a Worktree started from a GitHub issue is named after it, and a closed Project can't be listed", async (t) => {
  const f = await fixture(t);
  const created = await f.runtime.invoke("worktree:create", [{ projectPath: f.project, prompt: "x", githubIssue: { repo: "acme/web", number: 12 } }]);
  const worktree = created.project.state.worktrees[created.worktreeId];
  assert.equal(worktree.name, "12-fix-the-login-redirect");
  assert.deepEqual(f.reads.at(-1).options, { thread: false });
  const listed = await f.runtime.invoke("github:issues", [{ projectPath: f.project, query: "login" }]);
  assert.deepEqual(listed.issues, [issue]);
  assert.equal(listed.query, "login");
  await assert.rejects(f.runtime.invoke("github:issues", [{ projectPath: path.join(f.dir, "elsewhere") }]), /Open the Project/);
});

test("a Worktree isn't created when gh can't read the issue, and the reason reaches the user", async (t) => {
  const f = await fixture(t, { reachable: false });
  await assert.rejects(
    f.runtime.invoke("worktree:create", [{ projectPath: f.project, prompt: "x", githubIssue: { repo: "acme/web", number: 12 } }]),
    /Run `gh auth login` in a terminal/,
  );
  const state = (await f.runtime.invoke("project:snapshot", [f.project])).state;
  assert.equal(Object.keys(state.worktrees).length, 1, "only the main checkout");
});
