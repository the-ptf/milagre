const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createLinearTools, formatIssue, linearToolDefinitions } = require("./tools.cjs");

const full = {
  identifier: "ENG-12",
  title: "Fix the login redirect",
  url: "https://linear.app/acme/issue/ENG-12",
  description: "See ![shot](https://uploads.linear.app/a/b/c)",
  priorityLabel: "High",
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-02T10:00:00Z",
  state: { name: "Todo" },
  assignee: null,
  creator: { name: "Liz" },
  team: { name: "Engineering" },
  labels: { nodes: [{ name: "Bug" }] },
  project: null,
  cycle: null,
  parent: { identifier: "ENG-1", title: "Auth", state: { name: "Started" } },
  children: { nodes: [] },
  relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "ENG-13", title: "Ship", state: { name: "Todo" } } }] },
  inverseRelations: { nodes: [{ type: "blocks", issue: { identifier: "ENG-9", title: "Tokens", state: { name: "Done" } } }] },
  attachments: { nodes: [{ title: "PR #4", subtitle: null, url: "https://github.com/a/b/pull/4" }] },
  comments: {
    nodes: [
      { id: "2", body: "Second", createdAt: "2026-10-03T00:00:00Z", user: null, externalUser: null, botActor: { name: "GitHub" }, parent: { id: "1" } },
      { id: "1", body: "First", createdAt: "2026-10-02T00:00:00Z", user: { name: "Jordan" }, externalUser: null, botActor: null, parent: null },
    ],
  },
};

function fakes({ workspaces = ["acme"], enabled = true, download } = {}) {
  const calls = [];
  const linear = {
    enabled: () => enabled,
    workspaces: () => workspaces.map((id) => ({ id })),
    query: async (workspace, _document, variables) => (calls.push([workspace, variables.id]), { issue: full }),
    download: download ?? (async () => ({ type: "image/png", bytes: Buffer.from("png") })),
  };
  const issues = {
    readIssue: async (key, workspace) => (key === "ENG-12" ? { key, workspace: workspace ?? workspaces[0] } : null),
    list: async (query, { workspace }) => ({
      issues: query === "login" ? [{ key: "ENG-12", title: "Fix", url: full.url, state: { name: "Todo" } }] : [],
      workspace,
    }),
  };
  return { linear, issues, calls };
}

test("an issue reads as markdown with comments in order, relations both ways and a hint for uploads", () => {
  const text = formatIssue(full);
  assert.match(text, /^# ENG-12: Fix the login redirect/);
  assert.match(text, /State: Todo · Priority: High · Assignee: nobody · Team: Engineering · Labels: Bug/);
  assert.match(text, /Parent: ENG-1 Auth \(Started\)/);
  assert.match(text, /- blocks: ENG-13 Ship \(Todo\)\n- blocked by: ENG-9 Tokens \(Done\)/);
  assert.match(text, /- PR #4: https:\/\/github.com\/a\/b\/pull\/4/);
  assert.ok(text.indexOf("### Jordan, 2026-10-02") < text.indexOf("### GitHub, 2026-10-03 (reply in a thread)"));
  assert.match(text, /download them with linear_file/);
});

test("an issue URL picks its workspace; a workspace that isn't connected says how to add it", async () => {
  const f = fakes({ workspaces: ["acme", "beta"] });
  const tools = createLinearTools(f);
  await tools.issue("https://linear.app/beta/issue/ENG-12/fix-login");
  assert.deepEqual(f.calls, [["beta", "ENG-12"]]);
  await assert.rejects(
    tools.issue("https://linear.app/arketa/issue/ENG-12/x"),
    /isn't connected to the "arketa" Linear workspace \(connected: acme, beta\).*Add workspace/,
  );
  await assert.rejects(tools.issue("ENG-404"), /ENG-404 isn't in any connected Linear workspace/);
  await assert.rejects(tools.issue("hello"), /issue key such as ENG-12/);
});

test("the tools explain when Linear is off or not connected", async () => {
  await assert.rejects(createLinearTools(fakes({ enabled: false })).issue("ENG-12"), /Linear is off/);
  await assert.rejects(createLinearTools(fakes({ workspaces: [] })).search("x"), /isn't connected to Linear/);
});

test("search lists matches, and says which other workspaces exist when none match", async () => {
  const tools = createLinearTools(fakes({ workspaces: ["acme", "beta"] }));
  assert.equal(await tools.search("login"), `- ENG-12 Fix (Todo) ${full.url}`);
  assert.equal(await tools.search("nothing"), "No issues match in acme. Other connected workspaces: beta.");
});

test("a Linear upload is saved under the temp folder; other URLs are refused", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-linear-files-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const tried = [];
  const download = async (workspace) => {
    tried.push(workspace);
    if (workspace === "acme") throw Object.assign(new Error("no such file"), { code: "not-found" });
    return { type: "image/png; charset=binary", bytes: Buffer.from("png") };
  };
  const tools = createLinearTools({ ...fakes({ workspaces: ["acme", "beta"], download }), dir });
  const saved = await tools.file("https://uploads.linear.app/a/b/c");
  assert.deepEqual(tried, ["acme", "beta"]);
  const file = saved.match(/to (.+)$/)[1];
  assert.equal(path.dirname(file), dir);
  assert.equal(path.extname(file), ".png");
  assert.equal(await fs.readFile(file, "utf8"), "png");
  await assert.rejects(tools.file("https://example.com/x.png"), /uploads\.linear\.app/);
});

test("the definitions are named for MCP, and only the reads are read-only", () => {
  const definitions = linearToolDefinitions(createLinearTools(fakes()));
  assert.deepEqual(
    definitions.map((definition) => [definition.name, definition.readOnly]),
    [
      ["linear_issue", true],
      ["linear_search", true],
      ["linear_file", true],
      ["linear_create_issue", false],
      ["linear_update_issue", false],
      ["linear_comment", false],
    ],
  );
});

// A fake Linear for the writes: it answers each query by its operation name and records every call.
function writer({ workspaces = [{ id: "acme", canWrite: true }], teams = { acme: [{ id: "t-eng", key: "ENG", name: "Engineering" }] } } = {}) {
  const calls = [];
  const inFlight = { now: 0, peak: 0 };
  const answers = {
    Teams: (workspace) => ({ teams: { nodes: teams[workspace] ?? [] } }),
    States: () => ({
      team: {
        states: {
          nodes: [
            { id: "s-todo", name: "Todo" },
            { id: "s-progress", name: "In Progress" },
          ],
        },
      },
    }),
    Labels: () => ({
      issueLabels: {
        nodes: [
          { id: "l-bug-ws", name: "Bug", team: null },
          { id: "l-bug-eng", name: "Bug", team: { id: "t-eng" } },
          { id: "l-ui", name: "UI", team: null },
          { id: "l-other", name: "Infra", team: { id: "t-other" } },
        ],
      },
    }),
    Users: (_workspace, { filter }) => ({
      users: { nodes: filter.or[0].email.eqIgnoreCase === "liz@acme.com" ? [{ id: "u-liz", email: "liz@acme.com" }] : [] },
    }),
    Me: () => ({ viewer: { id: "u-me" } }),
    Projects: () => ({ projects: { nodes: [{ id: "p-auth", name: "Auth" }] } }),
    Ids: (_workspace, { id }) => ({ issue: { id: `id-${id}`, identifier: id, team: { id: "t-eng" } } }),
    Create: (_workspace, { input }) => ({
      issueCreate: { success: true, issue: { identifier: "ENG-99", title: input.title, url: "https://linear.app/acme/issue/ENG-99", state: { name: "Todo" } } },
    }),
    Update: () => ({
      issueUpdate: {
        success: true,
        issue: { identifier: "ENG-12", title: "Fix", url: full.url, state: { name: "In Progress" }, assignee: { name: "Liz" } },
      },
    }),
    Comment: () => ({ commentCreate: { success: true, comment: { url: `${full.url}#comment-1` } } }),
  };
  const linear = {
    enabled: () => true,
    workspaces: () => workspaces,
    canWrite: (id) => workspaces.find((item) => item.id === id)?.canWrite === true,
    query: async (workspace, document, variables = {}) => {
      const name = /^(?:query|mutation) (\w+)/.exec(document)[1];
      calls.push([workspace, name, variables]);
      inFlight.now++;
      inFlight.peak = Math.max(inFlight.peak, inFlight.now);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight.now--;
      return answers[name](workspace, variables);
    },
  };
  const forgotten = [];
  const issues = {
    readIssue: async (key, workspace) => (key === "ENG-12" || key === "ENG-1" ? { key, workspace: workspace ?? workspaces[0].id } : null),
    forget: (key, workspace) => forgotten.push([workspace, key]),
  };
  const sent = (name) => calls.find((call) => call[1] === name)?.[2];
  return { tools: createLinearTools({ linear, issues }), calls, sent, forgotten, inFlight };
}

test("create resolves the team, status, labels, assignee, parent and project by name", async () => {
  const f = writer();
  const text = await f.tools.createIssue({
    team: "eng",
    title: "  Login loops  ",
    description: "Steps",
    priority: "high",
    assignee: "liz@acme.com",
    state: "in progress",
    labels: ["bug", "UI"],
    parent: "ENG-1",
    project: "auth",
  });
  assert.equal(text, "Created ENG-99: Login loops (Todo)\nhttps://linear.app/acme/issue/ENG-99");
  assert.deepEqual(f.sent("Create").input, {
    teamId: "t-eng",
    title: "Login loops",
    description: "Steps",
    priority: 2,
    assigneeId: "u-liz",
    stateId: "s-progress",
    projectId: "p-auth",
    // The team's own Bug wins over the workspace's.
    labelIds: ["l-bug-eng", "l-ui"],
    parentId: "id-ENG-1",
  });
  // Status, labels, assignee, project and parent don't wait on each other.
  assert.equal(f.inFlight.peak, 5);
});

test("create says what is missing: a title, a team, a label or a user", async () => {
  const f = writer();
  await assert.rejects(f.tools.createIssue({ team: "ENG", title: " " }), /needs a title/);
  await assert.rejects(f.tools.createIssue({ team: "OPS", title: "x" }), /No team "OPS" in any connected Linear workspace\. Teams: acme: ENG \(Engineering\)/);
  await assert.rejects(f.tools.createIssue({ team: "ENG", title: "x", labels: ["Infra", "Nope"] }), /No label named "Infra", "Nope"/);
  await assert.rejects(f.tools.createIssue({ team: "ENG", title: "x", assignee: "who" }), /No Linear user "who"/);
  await assert.rejects(f.tools.createIssue({ team: "ENG", title: "x", state: "Shipped" }), /no status "Shipped"\. Its statuses: Todo, In Progress/);
  assert.equal(f.sent("Create"), undefined);
});

test("create finds the one workspace with the team, and asks for a workspace when several have it", async () => {
  const workspaces = [
    { id: "acme", canWrite: true },
    { id: "beta", canWrite: true },
  ];
  const one = writer({ workspaces, teams: { acme: [], beta: [{ id: "t-eng", key: "ENG", name: "Engineering" }] } });
  await one.tools.createIssue({ team: "ENG", title: "x" });
  assert.equal(one.calls.find((call) => call[1] === "Create")[0], "beta");
  const both = writer({ workspaces, teams: { acme: [{ id: "a", key: "ENG", name: "E" }], beta: [{ id: "b", key: "ENG", name: "E" }] } });
  await assert.rejects(both.tools.createIssue({ team: "ENG", title: "x" }), /Several connected workspaces have a team "ENG" \(acme, beta\)/);
  await both.tools.createIssue({ team: "ENG", title: "x", workspace: "Beta" });
  assert.equal(both.calls.find((call) => call[1] === "Create")[0], "beta");
});

test("a sign-in that can only read refuses every write before calling Linear", async () => {
  const f = writer({ workspaces: [{ id: "acme", canWrite: false }] });
  for (const run of [
    () => f.tools.createIssue({ team: "ENG", title: "x" }),
    () => f.tools.updateIssue({ issue: "ENG-12", title: "y" }),
    () => f.tools.comment({ issue: "ENG-12", body: "hi" }),
  ])
    await assert.rejects(run(), /can only read issues.*Add workspace/);
  assert.ok(f.calls.every((call) => !["Create", "Update", "Comment"].includes(call[1])));
});

test("update sends only the fields given, adds and removes labels, and clears with none", async () => {
  const f = writer();
  const text = await f.tools.updateIssue({
    issue: "https://linear.app/acme/issue/ENG-12/fix",
    state: "In Progress",
    assignee: "me",
    addLabels: ["UI"],
    removeLabels: ["Bug"],
  });
  assert.equal(text, `Updated ENG-12: Fix (In Progress, assigned to Liz)\n${full.url}`);
  assert.deepEqual(f.sent("Update"), {
    id: "id-ENG-12",
    input: { assigneeId: "u-me", stateId: "s-progress", addedLabelIds: ["l-ui"], removedLabelIds: ["l-bug-eng"] },
  });
  assert.deepEqual(f.forgotten, [["acme", "ENG-12"]], "the chips read the new status");
  const cleared = writer();
  await cleared.tools.updateIssue({ issue: "ENG-12", assignee: "None", project: "none", priority: "none" });
  assert.deepEqual(cleared.sent("Update").input, { assigneeId: null, projectId: null, priority: 0 });
  await assert.rejects(writer().tools.updateIssue({ issue: "ENG-12" }), /at least one thing to change/);
  await assert.rejects(writer().tools.updateIssue({ issue: "ENG-404", title: "x" }), /ENG-404 isn't in any connected Linear workspace/);
});

test("a comment goes on the issue's id and returns its link", async () => {
  const f = writer();
  assert.equal(await f.tools.comment({ issue: "ENG-12", body: "Looks good" }), `Commented on ENG-12: ${full.url}#comment-1`);
  assert.deepEqual(f.sent("Comment"), { input: { issueId: "id-ENG-12", body: "Looks good" } });
  await assert.rejects(f.tools.comment({ issue: "ENG-12", body: "  " }), /needs some text/);
});
