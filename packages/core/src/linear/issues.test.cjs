const assert = require("node:assert/strict");
const test = require("node:test");
const { createLinearIssues } = require("./issues.cjs");
const { LinearError } = require("./errors.cjs");

const node = (key, extra = {}) => ({
  identifier: key,
  title: `Title ${key}`,
  url: `https://linear.app/acme/issue/${key}`,
  branchName: `${key.toLowerCase()}-title`,
  description: null,
  state: { name: "Todo", type: "unstarted", color: "#aaa" },
  ...extra,
});

const acme = { id: "acme", viewer: { name: "V", email: "v@x" }, organization: { name: "Acme", urlKey: "acme" } };
const beta = { id: "beta", viewer: { name: "V", email: "v@x" }, organization: { name: "Beta", urlKey: "beta" } };

// A fake of the Mac's Linear connections: `answer` gets each document (and its workspace) and returns its data or throws.
function fakeLinear({ enabled = true, connected = true, workspaces = [acme], answer = () => ({}) } = {}) {
  const calls = [];
  return {
    calls,
    enabled: () => enabled,
    workspaces: () => (connected ? workspaces : []),
    query: async (workspace, document, variables = {}) => {
      calls.push({ workspace, document, variables });
      return answer(document, variables, workspace);
    },
  };
}

// The answer to a batched read: `has(key)` says whether the workspace owns the key.
const batch = (document, has) =>
  Object.fromEntries([...document.matchAll(/(i\d+): issue\(id: "([^"]+)"/g)].map(([, alias, key]) => [alias, has(key) ? node(key) : null]));

test("issues say why they can't load when the switch is off or Linear isn't connected", async () => {
  const off = fakeLinear({ enabled: false });
  assert.deepEqual(await createLinearIssues({ linear: off }).list(), {
    error: "Linear is off in Settings › Linear.",
    notConnected: true,
  });
  const disconnected = fakeLinear({ connected: false });
  assert.deepEqual(await createLinearIssues({ linear: disconnected }).list("ENG-1"), { error: "Linear isn't connected.", notConnected: true });
  assert.equal(off.calls.length + disconnected.calls.length, 0, "No query while Linear is off or disconnected");
});

test("with no query the list is the issues assigned to me, started or unstarted, newest first", async () => {
  const linear = fakeLinear({ answer: () => ({ viewer: { assignedIssues: { nodes: [node("ENG-1"), node("ENG-2", { description: "Details" })] } } }) });
  const result = await createLinearIssues({ linear }).list();
  assert.deepEqual(result.workspace, "acme");
  assert.deepEqual(result.workspaces, [{ id: "acme", name: "Acme" }]);
  assert.deepEqual(result.issues[0], {
    key: "ENG-1",
    workspace: "acme",
    title: "Title ENG-1",
    url: "https://linear.app/acme/issue/ENG-1",
    branchName: "eng-1-title",
    state: { name: "Todo", type: "unstarted", color: "#aaa" },
  });
  assert.equal(result.issues[1].description, "Details");
  assert.match(linear.calls[0].document, /assignedIssues\(first: ?50, orderBy: ?updatedAt/);
  assert.match(linear.calls[0].document, /type: \{ in: \["started", "unstarted"\] \}/);
});

test("the assigned list is kept for a minute, and fresh reads it again", async () => {
  let clock = 0;
  const linear = fakeLinear({ answer: () => ({ viewer: { assignedIssues: { nodes: [node("ENG-1")] } } }) });
  const issues = createLinearIssues({ linear, now: () => clock });
  await issues.list();
  clock = 59_000;
  assert.deepEqual(
    (await issues.list()).issues.map((issue) => issue.key),
    ["ENG-1"],
  );
  assert.equal(linear.calls.length, 1, "A reopen within the minute asks Linear nothing");
  await issues.list(undefined, { fresh: true });
  assert.equal(linear.calls.length, 2, "Refresh asks Linear again");
  clock = 120_000;
  await issues.list();
  assert.equal(linear.calls.length, 3, "An old list is read again");
});

test("a search asks the workspace for 25 matches, and a key lookup comes first without duplicates", async () => {
  const linear = fakeLinear({
    answer: (document, variables) => {
      if (document.includes("searchIssues")) return { searchIssues: { nodes: [node("ENG-1"), node("ENG-9")] } };
      if (variables.id === "ENG-1") return { issue: node("ENG-1") };
      throw new Error("unexpected");
    },
  });
  const result = await createLinearIssues({ linear }).list("eng-1");
  assert.deepEqual(
    result.issues.map((issue) => issue.key),
    ["ENG-1", "ENG-9"],
  );
  assert.match(linear.calls.find((call) => call.document.includes("searchIssues")).document, /searchIssues\(term: ?\$q, first: ?25\)/);
});

test("a key that doesn't exist is not an error for a search, but a failed search is", async () => {
  const missing = fakeLinear({
    answer: (document) => {
      if (document.includes("searchIssues")) return { searchIssues: { nodes: [node("ENG-4")] } };
      throw new LinearError("Entity not found", "failed");
    },
  });
  assert.deepEqual(
    (await createLinearIssues({ linear: missing }).list("ENG-77")).issues.map((issue) => issue.key),
    ["ENG-4"],
  );
  const broken = fakeLinear({
    answer: () => {
      throw new LinearError("Linear is limiting requests.", "rate-limited");
    },
  });
  assert.deepEqual(await createLinearIssues({ linear: broken }).list("fix"), { error: "Linear is limiting requests." });
  const revoked = fakeLinear({
    answer: () => {
      throw new LinearError("Linear isn't connected.", "revoked");
    },
  });
  assert.deepEqual(await createLinearIssues({ linear: revoked }).list(), { error: "Linear isn't connected.", notConnected: true });
});

test("worktrees fetch several stored keys in one query and treat a missing one as no chip", async () => {
  const linear = fakeLinear({
    answer: (document, variables) => {
      // One missing key fails the batch as a whole, so each key is then asked alone.
      if (document.includes("i0:")) throw new LinearError("Entity not found", "failed");
      if (variables.id === "ENG-2") return { issue: node("ENG-2") };
      throw new LinearError("Entity not found", "failed");
    },
  });
  const found = await createLinearIssues({ linear }).worktreeIssues([
    { name: "a", path: "/wt/a", linearIssue: "ENG-1" },
    { name: "b", path: "/wt/b", linearIssue: "ENG-2" },
  ]);
  assert.deepEqual(Object.keys(found), ["/wt/b"]);
  assert.equal(found["/wt/b"].workspace, "acme");
  assert.match(linear.calls[0].document, /i0: issue\(id: "ENG-1"\)/);
  assert.match(linear.calls[0].document, /i1: issue\(id: "ENG-2"\)/);
});

test("readIssue never sends a key that isn't key-shaped to Linear", async () => {
  const linear = fakeLinear({ answer: (document) => batch(document, () => true) });
  const issues = createLinearIssues({ linear });
  assert.equal(await issues.readIssue('ENG-1") { x } #'), null);
  assert.equal(linear.calls.length, 0);
  assert.equal((await issues.readIssue("eng-3")).key, "ENG-3");
  assert.equal(linear.calls.length, 1);
  assert.match(linear.calls[0].document, /issue\(id: "ENG-3"\)/);
});

test("worktrees name their issue by the stored key or by the team key in their branch", async () => {
  const linear = fakeLinear({
    answer: (document) => {
      if (document.includes("teams(")) return { teams: { nodes: [{ key: "ENG" }, { key: "WEB" }] } };
      return { i0: node("ENG-12"), i1: node("WEB-3") };
    },
  });
  const issues = createLinearIssues({ linear, now: () => 0 });
  const found = await issues.worktreeIssues([
    { name: "eng-12-fix-login", path: "/wt/a" },
    { name: "milagre/fix-x-ab12", path: "/wt/b", linearIssue: "WEB-3" },
    { name: "milagre/plain-cd34", path: "/wt/c" },
  ]);
  assert.deepEqual(Object.keys(found).sort(), ["/wt/a", "/wt/b"]);
  assert.equal(found["/wt/a"].key, "ENG-12");
  assert.equal(found["/wt/b"].key, "WEB-3");
  assert.equal(found["/wt/a"].workspace, "acme");
});

test("worktree issues are cached for a minute, team keys for ten, and empty when they can't be read", async () => {
  let clock = 0;
  const linear = fakeLinear({
    answer: (document) => (document.includes("teams(") ? { teams: { nodes: [{ key: "ENG" }] } } : { i0: node("ENG-12") }),
  });
  const issues = createLinearIssues({ linear, now: () => clock });
  const worktrees = [{ name: "eng-12-fix", path: "/wt/a" }];
  await issues.worktreeIssues(worktrees);
  await issues.worktreeIssues(worktrees);
  assert.equal(linear.calls.length, 2, "one teams query and one issue query");
  clock = 61_000;
  await issues.worktreeIssues(worktrees);
  assert.equal(linear.calls.filter((call) => call.document.includes("teams(")).length, 1, "team keys still fresh at 61 s");
  assert.equal(linear.calls.length, 3);

  const broken = fakeLinear({
    answer: () => {
      throw new LinearError("Couldn't reach Linear", "offline");
    },
  });
  assert.deepEqual(await createLinearIssues({ linear: broken }).worktreeIssues(worktrees), {});
  assert.deepEqual(await createLinearIssues({ linear: fakeLinear({ enabled: false }) }).worktreeIssues(worktrees), {});
  assert.deepEqual(await createLinearIssues({ linear: fakeLinear({ connected: false }) }).worktreeIssues(worktrees), {});
});

test("only Linear's not-found reads as a missing issue; any other failure is thrown", async () => {
  const notFound = fakeLinear({
    answer: (document) => {
      if (document.includes("i0:")) throw new LinearError("Entity not found", "failed");
      throw Object.assign(new LinearError("Something odd", "failed"), { extensions: { type: "entity not found" } });
    },
  });
  assert.equal(await createLinearIssues({ linear: notFound }).readIssue("ENG-5"), null);

  const broken = fakeLinear({
    answer: () => {
      throw Object.assign(new LinearError("Field 'x' doesn't exist", "failed"), { extensions: { code: "GRAPHQL_VALIDATION_FAILED" } });
    },
  });
  await assert.rejects(createLinearIssues({ linear: broken }).readIssue("ENG-5"), { code: "failed", message: "Field 'x' doesn't exist" });
});

test("a failed team-key lookup still resolves the worktrees that store their issue", async () => {
  const linear = fakeLinear({
    answer: (document) => {
      if (document.includes("teams(")) throw new LinearError("Couldn't reach Linear", "offline");
      return { i0: node("ENG-12") };
    },
  });
  const found = await createLinearIssues({ linear, now: () => 0 }).worktreeIssues([
    { name: "milagre/fix-x-ab12", path: "/wt/a", linearIssue: "ENG-12" },
    { name: "eng-13-plain", path: "/wt/b" },
  ]);
  assert.deepEqual(Object.keys(found), ["/wt/a"]);
  assert.equal(found["/wt/a"].key, "ENG-12");
});

test("a named workspace is queried and cached apart from the first", async () => {
  const linear = fakeLinear({
    workspaces: [acme, beta],
    answer: (document, variables, workspace) => ({ viewer: { assignedIssues: { nodes: [node(workspace === "beta" ? "WEB-1" : "ENG-1")] } } }),
  });
  const issues = createLinearIssues({ linear, now: () => 0 });
  const first = await issues.list();
  assert.equal(first.workspace, "acme");
  assert.deepEqual(first.workspaces, [
    { id: "acme", name: "Acme" },
    { id: "beta", name: "Beta" },
  ]);
  const second = await issues.list(undefined, { workspace: "beta" });
  assert.equal(second.workspace, "beta");
  assert.deepEqual(
    second.issues.map((issue) => [issue.key, issue.workspace]),
    [["WEB-1", "beta"]],
  );
  await issues.list();
  await issues.list(undefined, { workspace: "beta" });
  assert.deepEqual(
    linear.calls.map((call) => call.workspace),
    ["acme", "beta"],
    "each workspace is read once and then kept",
  );
  assert.equal((await issues.list(undefined, { workspace: "nope" })).workspace, "acme", "an unknown workspace falls back to the first");
});

test("readIssue finds a key in the workspace whose team keys own its prefix", async () => {
  const linear = fakeLinear({
    workspaces: [acme, beta],
    answer: (document, variables, workspace) => {
      if (document.includes("teams(")) return { teams: { nodes: [{ key: workspace === "beta" ? "WEB" : "ENG" }] } };
      return batch(document, () => workspace === "beta");
    },
  });
  const issue = await createLinearIssues({ linear }).readIssue("web-3");
  assert.equal(issue.key, "WEB-3");
  assert.equal(issue.workspace, "beta");
  const reads = linear.calls.filter((call) => !call.document.includes("teams("));
  assert.deepEqual(
    reads.map((call) => call.workspace),
    ["beta"],
    "the other workspace isn't asked",
  );
  const named = await createLinearIssues({ linear }).readIssue("WEB-3", "beta");
  assert.equal(named.workspace, "beta");
});

test("readIssue tries every workspace in order when none owns the prefix", async () => {
  const linear = fakeLinear({
    workspaces: [acme, beta],
    answer: (document, variables, workspace) => {
      if (document.includes("teams(")) return { teams: { nodes: [{ key: "ZZZ" }] } };
      return batch(document, () => workspace === "beta");
    },
  });
  assert.equal((await createLinearIssues({ linear }).readIssue("ENG-9")).workspace, "beta");
  assert.equal(await createLinearIssues({ linear: fakeLinear({ workspaces: [acme, beta] }) }).readIssue("ENG-1"), null);
});

test("worktrees read their stored workspace, and match a branch against each workspace's teams", async () => {
  const linear = fakeLinear({
    workspaces: [acme, beta],
    answer: (document, variables, workspace) => {
      if (document.includes("teams(")) return { teams: { nodes: [{ key: workspace === "beta" ? "WEB" : "ENG" }] } };
      return batch(document, (key) => (workspace === "beta" ? key !== "ENG-12" : key === "ENG-12"));
    },
  });
  const found = await createLinearIssues({ linear, now: () => 0 }).worktreeIssues([
    { name: "milagre/x-ab12", path: "/wt/a", linearIssue: "ENG-5", linearWorkspace: "beta" },
    { name: "web-3-fix", path: "/wt/b" },
    { name: "eng-12-fix", path: "/wt/c" },
  ]);
  assert.deepEqual(Object.keys(found).sort(), ["/wt/a", "/wt/b", "/wt/c"]);
  assert.equal(found["/wt/a"].workspace, "beta");
  assert.equal(found["/wt/b"].workspace, "beta");
  assert.equal(found["/wt/c"].workspace, "acme");
  const reads = linear.calls.filter((call) => call.document.includes("i0:"));
  assert.deepEqual(reads.map((call) => call.workspace).sort(), ["acme", "beta"]);
});

// Answers the started-states query for an issue in `type`, and records the move.
function startable(
  type,
  states = [
    { id: "s2", position: 2 },
    { id: "s1", position: 1 },
  ],
  { success = true } = {},
) {
  return fakeLinear({
    answer: (document) => {
      if (document.includes("mutation Move")) return { issueUpdate: { success } };
      return { issue: { id: "uuid-1", state: { type }, team: { states: { nodes: states } } } };
    },
  });
}

test("an issue not yet started moves to its team's first started status", async () => {
  for (const type of ["triage", "backlog", "unstarted"]) {
    const linear = startable(type);
    assert.equal(await createLinearIssues({ linear }).markStarted("ENG-1", "acme"), "moved");
    const move = linear.calls.find((call) => call.document.includes("mutation Move"));
    assert.deepEqual(move.variables, { id: "uuid-1", stateId: "s1" });
    assert.equal(move.workspace, "acme");
  }
});

test("an issue already started, done or canceled keeps its status", async () => {
  for (const type of ["started", "completed", "canceled"]) {
    const linear = startable(type);
    assert.equal(await createLinearIssues({ linear }).markStarted("ENG-1", "acme"), "kept");
    assert.equal(linear.calls.length, 1, "No move");
  }
  const noStarted = startable("unstarted", []);
  assert.equal(await createLinearIssues({ linear: noStarted }).markStarted("ENG-1", "acme"), "kept");
});

test("a move Linear refuses or can't reach says failed instead of throwing", async () => {
  assert.equal(await createLinearIssues({ linear: startable("unstarted", undefined, { success: false }) }).markStarted("ENG-1", "acme"), "failed");
  const offline = fakeLinear({
    answer: () => {
      throw new LinearError("Couldn't reach Linear: down", "offline");
    },
  });
  assert.equal(await createLinearIssues({ linear: offline }).markStarted("ENG-1", "acme"), "failed");
});

test("a moved issue is read again instead of from the cache", async () => {
  let type = "unstarted";
  const linear = fakeLinear({
    answer: (document) => {
      if (document.includes("mutation Move")) {
        type = "started";
        return { issueUpdate: { success: true } };
      }
      if (document.includes("query Started")) return { issue: { id: "uuid-1", state: { type }, team: { states: { nodes: [{ id: "s1", position: 1 }] } } } };
      return { i0: node("ENG-1", { state: { name: type === "started" ? "In Progress" : "Todo", type, color: "#aaa" } }) };
    },
  });
  const issues = createLinearIssues({ linear });
  const worktree = [{ path: "/w", name: "x", linearIssue: "ENG-1", linearWorkspace: "acme" }];
  assert.equal((await issues.worktreeIssues(worktree))["/w"].state.name, "Todo");
  await issues.markStarted("ENG-1", "acme");
  assert.equal((await issues.worktreeIssues(worktree))["/w"].state.name, "In Progress");
});
