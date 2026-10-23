const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");

async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(check(), "Expected runtime event did not arrive");
}

// A shared Link Chat's agent about to change both Projects: each gets the Chat's Worktree first (link_worktree_create).
async function createWorktrees(context) {
  const tool = context.linked.tools.find((item) => item.name === "link_worktree_create");
  for (const project of ["api", "web"]) {
    const reply = await require("./linked-tools.cjs").runTool(tool, { project });
    assert.equal(reply.isError, false, reply.text);
  }
}

async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-account-routing-")));
  const dataDir = path.join(dir, "profile");
  const accountFile = path.join(dataDir, "accounts", "accounts.json");
  const ids = { personal: randomUUID(), work: randomUUID(), shared: randomUUID() };
  const projects = [];
  for (const name of ["api", "web"]) {
    const folder = path.join(dir, name);
    await fs.mkdir(folder);
    execFileSync("git", ["init", "-qb", "main", folder]);
    execFileSync("git", [
      "-C",
      folder,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "-qm",
      "Initial",
    ]);
    projects.push(folder);
  }
  const saved = {
    accounts: Object.entries(ids).map(([label, id]) => ({ id, provider: "claude", label })),
    selected: { claude: ids.personal, codex: "default" },
    scopes: { [projects[0]]: { claude: ids.work }, [projects[1]]: { claude: ids.personal } },
  };
  await fs.mkdir(path.dirname(accountFile), { recursive: true, mode: 0o700 });
  const save = () => fs.writeFile(accountFile, JSON.stringify(saved));
  await save();
  const cli = path.join(dir, "fake-claude");
  await fs.writeFile(cli, '#!/bin/sh\nprintf \'%s\\n\' \'{"loggedIn":true,"email":"fixture@example.test","subscriptionType":"pro"}\'\n', { mode: 0o700 });
  const events = [],
    created = [],
    runtimes = [];
  t.after(async () => {
    try {
      for (const runtime of runtimes) await runtime.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  const make = (extra = {}) => {
    const runtime = createRuntime({
      ...extra,
      dataDir,
      cwd: projects[0],
      registryRoots: [],
      worktreeRoot: path.join(dir, "worktrees"),
      environmentReady: Promise.resolve(),
      titleModels: {},
      agentCliStatus: async () => ({ claude: { state: "ready" }, codex: { state: "missing" } }),
      agentModels: async () => ({ claude: [{ id: "test", efforts: [] }], codex: [] }),
      agentCli: extra.agentCli ?? (async (provider) => (provider === "claude" ? { command: cli } : { problem: "Codex is not installed in this fixture" })),
      emit: (channel, payload) => events.push({ channel, payload }),
      createSession(provider, context) {
        const session = {
          provider,
          context,
          turns: [],
          turnActive: false,
          closed: false,
          nativeId: randomUUID(),
          startTurn(turn) {
            this.turns.push(turn);
            this.turnActive = true;
            context.emit({ type: "session-started", nativeId: this.nativeId });
            context.emit({ type: "turn-started", turnId: randomUUID() });
            return { turnId: "fixture-turn" };
          },
          interrupt() {
            this.turnActive = false;
            context.emit({ type: "turn-cancelled" });
            return Promise.resolve();
          },
          finish() {
            this.turnActive = false;
            context.emit({ type: "turn-completed" });
          },
          limit(resetsAt) {
            this.turnActive = false;
            context.emit({ type: "turn-failed", message: "You've hit your session limit", notice: true, limit: { provider: "claude", resetsAt } });
          },
          close() {
            this.closed = true;
            if (this.turnActive) {
              this.turnActive = false;
              context.emit({ type: "turn-cancelled" });
            }
          },
        };
        created.push(session);
        return session;
      },
    });
    runtimes.push(runtime);
    return runtime;
  };
  const profile = (id) => path.join(dataDir, "accounts", id);
  const send = (runtime, projectPath, sessionId, body = "Use this account") =>
    runtime.invoke("chat:send", [{ projectPath, sessionId, body, provider: "claude", model: "test", permissionMode: "auto" }]);
  return { make, projects, saved, save, ids, profile, created, events, send, dataDir, cli };
}

test("concurrent Projects route by their own scope and reuse accounts after switching the viewed Project", async (t) => {
  const { make, projects, ids, profile, created, send } = await fixture(t);
  const runtime = make();
  const a = await runtime.openProject(projects[0]);
  const b = await runtime.openProject(projects[1]);
  const aId = Object.values(a.state.sessions)[0].id,
    bId = Object.values(b.state.sessions)[0].id;
  await Promise.all([send(runtime, a.path, aId), send(runtime, b.path, bId)]);
  await until(() => created.length === 2);
  const forA = created.find((session) => session.context.cwd === a.path);
  const forB = created.find((session) => session.context.cwd === b.path);
  assert.equal(forA.context.env.CLAUDE_CONFIG_DIR, profile(ids.work));
  assert.equal(forB.context.env.CLAUDE_CONFIG_DIR, profile(ids.personal));
  assert.equal(forA.turnActive && forB.turnActive, true);
  forA.finish();
  forB.finish();
  await runtime.flush();
  await runtime.openProject(a.path);
  await send(runtime, b.path, bId, "Continue B");
  await send(runtime, a.path, aId, "Continue A");
  await until(() => forA.turns.length === 2 && forB.turns.length === 2);
  assert.equal(created.length, 2, "Changing the viewed Project must not replace provider sessions");
});

test("a named Link has its own account, independent of members and viewed Project", async (t) => {
  const { make, projects, saved, save, ids, profile, created } = await fixture(t);
  const first = make();
  for (const project of projects) await first.openProject(project);
  const registry = await first.invoke("project:registry");
  const link = await first.invoke("link:create", [{ name: "API and Web", projectIds: registry.map((project) => project.id) }]);
  await first.close();
  saved.scopes[`milagre-link:${link.id}`] = { claude: ids.shared };
  await save();
  const runtime = make();
  await runtime.invoke("link:open", [link.id]);
  await runtime.openProject(projects[0]);
  const request = { linkId: link.id, operationId: randomUUID(), sessionId: null, body: "Edit both", provider: "claude", model: "test", permissionMode: "auto" };
  const sent = await runtime.invoke("link:send", [request]);
  await until(() => created.length === 1);
  assert.equal(created[0].context.env.CLAUDE_CONFIG_DIR, profile(ids.shared));
  assert.equal(created[0].context.workspaceRoots.length, 0);
  // Its agent makes a Worktree in each Project before changing it; the session continues with both.
  await createWorktrees(created[0].context);
  created[0].finish();
  await runtime.flush();
  await runtime.openProject(projects[1]);
  await runtime.invoke("link:send", [{ ...request, sessionId: sent.sessionId, operationId: randomUUID(), body: "Continue both" }]);
  await until(() => created[0].turns.length === 2);
  assert.equal(created.length, 1);
});

test("a removed explicitly assigned account fails the Chat without starting the computer default", async (t) => {
  const { make, projects, saved, save, created, events, send } = await fixture(t);
  saved.scopes[projects[0]].claude = randomUUID();
  await save();
  const runtime = make();
  const opened = await runtime.openProject(projects[0]);
  const id = Object.values(opened.state.sessions)[0].id;
  await send(runtime, opened.path, id);
  await until(() => events.some(({ channel, payload }) => channel === "agent:event" && payload.event.type === "turn-failed") || created.length > 0);
  assert.equal(created.length, 0, "A stale explicit assignment must never fall back");
  const failure = events.find(({ channel, payload }) => channel === "agent:event" && payload.event.type === "turn-failed");
  assert.equal(failure.payload.chatId, `${opened.path}#${id}`);
  assert.match(failure.payload.event.message, /account/i);
});

test("account scope RPCs enumerate Projects and Links, validate scope, and persist independent assignments", async (t) => {
  const { make, projects, ids } = await fixture(t);
  const runtime = make();
  for (const project of projects) await runtime.openProject(project);
  const registry = await runtime.invoke("project:registry");
  const link = await runtime.invoke("link:create", [{ name: "Together", projectIds: registry.map((project) => project.id) }]);
  const linkKey = `milagre-link:${link.id}`;
  const scopes = await runtime.invoke("accounts:scopes");
  for (const project of registry) {
    const entry = scopes.find((scope) => scope.key === project.path);
    assert.equal(entry.kind, "project");
    assert.deepEqual(
      entry.projects.map((member) => member.id),
      [project.id],
    );
  }
  const entry = scopes.find((scope) => scope.key === linkKey);
  assert.equal(entry.name, "Together");
  assert.equal(entry.kind, "link");
  assert.deepEqual(entry.projects.map((project) => project.id).sort(), registry.map((project) => project.id).sort());
  const claude = (snapshot) => snapshot.providers.find((provider) => provider.provider === "claude");
  assert.equal(claude(await runtime.invoke("accounts:scope", [projects[0], true])).effectiveId, ids.work);
  // Antigravity is not installed in this fixture, so it has no Project account choice.
  const antigravity = (await runtime.invoke("accounts:scope", [projects[0]])).providers.find((provider) => provider.provider === "antigravity");
  assert.equal(antigravity, undefined);
  await runtime.invoke("accounts:assign", [linkKey, "claude", ids.shared]);
  assert.equal(claude(await runtime.invoke("accounts:scope", [linkKey])).accountId, ids.shared);
  assert.equal(claude(await runtime.invoke("accounts:scope", [projects[0]])).accountId, ids.work);
  await runtime.invoke("accounts:assign", [projects[0], "claude", null]);
  const cleared = claude(await runtime.invoke("accounts:scope", [projects[0]]));
  assert.equal(cleared.accountId, null);
  assert.equal(cleared.effectiveId, ids.personal);
  assert.equal(cleared.defaultId, ids.personal);
  for (const invalid of [path.join(path.dirname(projects[0]), "unregistered"), `milagre-link:${randomUUID()}`]) {
    await assert.rejects(runtime.invoke("accounts:scope", [invalid]));
    await assert.rejects(runtime.invoke("accounts:assign", [invalid, "claude", null]));
  }
  await assert.rejects(runtime.invoke("accounts:assign", [projects[0], "unknown", null]));
  await assert.rejects(runtime.invoke("accounts:assign", [projects[0], "claude", randomUUID()]));
  await runtime.close();
  const restored = make();
  assert.equal(claude(await restored.invoke("accounts:scope", [linkKey])).accountId, ids.shared);
  assert.equal(claude(await restored.invoke("accounts:scope", [projects[0]])).accountId, null);
});

test("cached usage resolves the requested account pair without leaking the viewed Project usage", async (t) => {
  const { make, projects, ids, dataDir } = await fixture(t);
  for (const [id, usedPercent] of [
    [ids.work, 17],
    [ids.personal, 81],
  ]) {
    await fs.writeFile(
      path.join(dataDir, `usage-${id}-default.json`),
      JSON.stringify({
        claude: {
          last: { updatedAt: new Date().toISOString(), windows: [{ id: "session", label: "Session", shortLabel: "5h", usedPercent, resetsAt: null }] },
          blocked: null,
        },
      }),
    );
  }
  const runtime = make();
  for (const project of projects) await runtime.openProject(project);
  const usage = async (scope) =>
    (await runtime.invoke("usage:cached", scope ? [scope] : [])).providers.find((provider) => provider.provider === "claude").windows[0].usedPercent;
  const workUsage = await runtime.invoke("usage:cached", [projects[0]]);
  assert.deepEqual(workUsage.providers[0].account, { id: ids.work, label: "work", email: "fixture@example.test" });
  const personalUsage = await runtime.invoke("usage:cached", [projects[1]]);
  assert.equal(personalUsage.providers[0].account.id, ids.personal);
  assert.equal(personalUsage.providers[0].account.label, "personal");
  assert.equal(await usage(projects[0]), 17);
  assert.equal(await usage(projects[1]), 81);
  assert.equal(await usage(), 81);
  await runtime.openProject(projects[0]);
  assert.equal(await usage(projects[1]), 81);
  await assert.rejects(runtime.invoke("usage:cached", [path.join(dataDir, "unregistered")]));
});

test("advisors inherit a named Link's Account and both owned Worktrees", async (t) => {
  const { make, projects, saved, save, ids, profile, created } = await fixture(t);
  const first = make();
  for (const project of projects) await first.openProject(project);
  const registry = await first.invoke("project:registry");
  const link = await first.invoke("link:create", [{ name: "Shared advice", projectIds: registry.map((project) => project.id) }]);
  await first.close();
  saved.scopes[`milagre-link:${link.id}`] = { claude: ids.shared };
  await save();
  const runtime = make();
  await runtime.invoke("link:open", [link.id]);
  await runtime.invoke("link:send", [
    { linkId: link.id, operationId: randomUUID(), sessionId: null, body: "Review both", provider: "claude", model: "test", permissionMode: "full" },
  ]);
  await until(() => created.length === 1);
  await createWorktrees(created[0].context);
  const tool = created[0].context.linked.tools.find((tool) => tool.name === "create_advisor");
  const reply = await require("./linked-tools.cjs").runTool(tool, { title: "Link advisor", prompt: "Assess both", provider: "claude" });
  assert.equal(reply.isError, false);
  await until(() => created.length === 2 && created[1].turns.length === 1);
  assert.equal(created[1].context.analysisOnly, true);
  assert.equal(created[1].context.env.CLAUDE_CONFIG_DIR, profile(ids.shared));
  const session = Object.values((await runtime.invoke("link:snapshot", [link.id])).state.sessions)[0];
  assert.deepEqual(created[1].context.workspaceRoots, session.worktrees.map((member) => member.worktreePath).sort());
  assert.equal(created[1].context.workspaceRoots.length, 2);
});

test("Antigravity usage is read for, and cached apart per, the Account a Project selects", async (t) => {
  const { make, projects, saved, save, dataDir, profile } = await fixture(t);
  const agy = randomUUID();
  saved.accounts.push({ id: agy, provider: "antigravity", label: "Work Google" });
  saved.scopes[projects[0]].antigravity = agy;
  await save();
  const windows = (usedPercent) => [{ id: "gemini:weekly", label: "Gemini weekly", shortLabel: "wk", usedPercent, resetsAt: null }];
  const reads = [];
  const result = (provider, usedPercent) => ({ provider, status: "ok", windows: windows(usedPercent), updatedAt: new Date().toISOString() });
  const runtime = make({
    usageReaders: {
      claude: async () => ({ provider: "claude", status: "unavailable", windows: [], updatedAt: new Date().toISOString() }),
      codex: async () => ({ provider: "codex", status: "unavailable", windows: [], updatedAt: new Date().toISOString() }),
      antigravity: async ({ env }) => {
        reads.push(env.GEMINI_HOME);
        return result("antigravity", env.GEMINI_HOME === profile(agy) ? 40 : 7);
      },
    },
  });
  for (const project of projects) await runtime.openProject(project);
  const antigravity = (snapshot) => snapshot.providers.find((provider) => provider.provider === "antigravity");

  const own = antigravity(await runtime.invoke("usage:read", [projects[0]]));
  assert.equal(own.windows[0].usedPercent, 40);
  assert.deepEqual(own.account, { id: agy, label: "Work Google" });
  const inherited = antigravity(await runtime.invoke("usage:read", [projects[1]]));
  assert.equal(inherited.windows[0].usedPercent, 7);
  assert.equal(inherited.account.id, "default");
  assert.deepEqual(reads, [profile(agy), path.join(dataDir, "accounts", "antigravity-default")]);

  // Each selection has its own saved numbers, and the default selection keeps the original cache file.
  assert.equal(antigravity(await runtime.invoke("usage:cached", [projects[0]])).windows[0].usedPercent, 40);
  assert.equal(antigravity(await runtime.invoke("usage:cached", [projects[1]])).windows[0].usedPercent, 7);
  await runtime.close();
  const names = await fs.readdir(dataDir);
  assert.ok(names.includes(`usage-${saved.scopes[projects[0]].claude}-default-${agy}.json`));
  assert.ok(names.includes("usage-" + saved.selected.claude + "-default.json"));
});

test("a usage limit marks the account, the limit card switches the Project and continues the Chat, and auto-switch picks the next one", async (t) => {
  const { make, projects, ids, profile, created, send } = await fixture(t);
  const runtime = make();
  const project = await runtime.openProject(projects[0]);
  const chatId = Object.values(project.state.sessions)[0].id;
  const claude = (snapshot) => snapshot.providers.find((provider) => provider.provider === "claude");
  const lastMessage = async () => (await runtime.invoke("chat:messages", [project.path, chatId])).messages.at(-1);
  await runtime.invoke("accounts:scope", [project.path, true]);
  await send(runtime, project.path, chatId, "Wire up the export");
  await until(() => created.length === 1);
  created[0].context.emit({ type: "background-tasks", tasks: [{ id: "shell", kind: "local_bash", title: "Watch exports", startedAt: 1 }] });
  created[0].context.emit({
    type: "subagent-update",
    agent: { id: "review", title: "Review", status: "running", background: true, startedAt: 1, updatedAt: 1, transcript: [] },
  });
  const resetsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  created[0].limit(resetsAt);
  await runtime.flush();
  await until(() => !created[0].turnActive);
  const failed = await lastMessage();
  assert.deepEqual(failed.context, { kind: "limit", provider: "claude", resetsAt, accountId: ids.work });
  const marked = claude(await runtime.invoke("accounts:scope", [project.path]));
  assert.equal(marked.accounts.find((account) => account.id === ids.work).limitedUntil, resetsAt);

  // The card: the Project moves to the personal account and the Chat continues on its native session.
  const result = await runtime.invoke("chat:limit-switch", [project.path, chatId, "claude", ids.personal]);
  assert.equal(result.continued, true);
  await until(() => created.length === 2);
  assert.equal(created[1].context.env.CLAUDE_CONFIG_DIR, profile(ids.personal));
  assert.equal(created[1].context.resumeId, created[0].nativeId);
  assert.equal(created[0].closed, true);
  const resumed = (await runtime.invoke("project:snapshot", [project.path])).state.sessions[chatId];
  assert.equal(resumed.backgroundTasks, undefined);
  assert.equal(resumed.subagents.find((agent) => agent.id === "review").status, "cancelled");
  assert.match(created[1].turns[0].prompt, /background.*stopped/i);
  assert.match(created[1].turns[0].prompt, /usage limit/);
  assert.equal(claude(await runtime.invoke("accounts:scope", [project.path])).effectiveId, ids.personal);

  // Auto-switch: the personal account hits its limit too, so the Chat moves to the first ready account that isn't limited.
  assert.deepEqual(await runtime.invoke("limits:auto-switch:save", [true]), { autoSwitch: true });
  const next = claude(await runtime.invoke("accounts:scope", [project.path])).accounts.find(
    (account) => account.state === "ready" && ![ids.work, ids.personal].includes(account.id),
  );
  created[1].context.emit({ type: "background-tasks", tasks: [{ id: "mcp", kind: "mcp_task", title: "Export", startedAt: 2 }] });
  created[1].limit();
  await until(() => created.length === 3);
  assert.equal(created[2].context.env?.CLAUDE_CONFIG_DIR, next.id === "default" ? undefined : profile(next.id));
  assert.equal(created[1].closed, true);
  assert.equal(claude(await runtime.invoke("accounts:scope", [project.path])).effectiveId, next.id);
  assert.deepEqual(await runtime.invoke("limits:auto-switch:read", []), { autoSwitch: true });
});

test("a usage-limited Chat with background work can hand off to another provider", async (t) => {
  const { make, projects, created, send, cli } = await fixture(t);
  const runtime = make({ agentCli: async () => ({ command: cli }) });
  const project = await runtime.openProject(projects[0]);
  const sessionId = Object.values(project.state.sessions)[0].id;
  await send(runtime, project.path, sessionId, "Finish the export");
  await until(() => created.length === 1);
  created[0].context.emit({ type: "background-tasks", tasks: [{ id: "shell", kind: "local_bash", title: "Watch exports", startedAt: 1 }] });
  created[0].limit();
  await runtime.flush();

  await runtime.invoke("chat:send", [{ projectPath: project.path, sessionId, body: "Continue", provider: "codex", model: "test" }]);
  await until(() => created.length === 2);
  assert.equal(created[0].closed, true);
  assert.equal(created[1].provider, "codex");
  assert.match(created[1].turns[0].prompt, /background tasks were stopped/);
  const state = (await runtime.invoke("project:snapshot", [project.path])).state;
  assert.equal(state.sessions[sessionId].backgroundTasks, undefined);
  assert.equal(state.messages.find((message) => message.context?.kind === "handoff").context.status, "done");
});

test("a completed usage read signals its scope so other views can fetch the saved numbers", async (t) => {
  const { make, projects, events } = await fixture(t);
  const runtime = make({
    usageReaders: {
      claude: async () => ({
        provider: "claude",
        status: "ok",
        updatedAt: new Date().toISOString(),
        windows: [{ id: "weekly", label: "Weekly", shortLabel: "wk", usedPercent: 37, resetsAt: null }],
      }),
      codex: async () => ({ provider: "codex", status: "unavailable", windows: [] }),
      antigravity: async () => ({ provider: "antigravity", status: "unavailable", windows: [] }),
    },
  });
  await runtime.openProject(projects[0]);
  const result = await runtime.invoke("usage:read", [projects[0]]);
  assert.deepEqual(
    events.filter((event) => event.channel === "usage:changed").map((event) => event.payload),
    [{ scopeKey: projects[0] }],
  );
  const cached = await runtime.invoke("usage:cached", [projects[0]]);
  assert.equal(cached.accountKey, result.accountKey);
  assert.deepEqual(cached.providers[0].windows, result.providers[0].windows);
  assert.equal(cached.providers[0].windows[0].usedPercent, 37);
  assert.equal(events.filter((event) => event.channel === "usage:changed").length, 1, "cache reads must not signal another read");
});
