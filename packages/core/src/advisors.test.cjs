const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createAdvisors } = require("./advisors.cjs");
const { createAdvisorStore } = require("./advisor-store.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");
async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "advisors-"));
  const store = createAdvisorStore({ dataDir });
  const launched = [];
  const published = [];
  const completions = [];
  const context = {
    scopeIdentity: "scope-v1",
    parentProvider: "claude",
    cwd: dataDir,
    get permissionMode() {
      return this.settings?.permissionMode;
    },
  };
  const catalog = {
    claude: { available: true, accountId: "ca", models: [{ id: "cm", efforts: ["high"], recommended: true }] },
    codex: { available: true, accountId: "co", models: [{ id: "xm", efforts: ["low", "high"], defaultEffort: "low", recommended: true }] },
  };
  const manager = createAdvisors({
    store,
    contextFor: async () => context,
    providersFor: async () => catalog,
    publish: async (id, row) => published.push({ id, row }),
    completed: async (id, result) => completions.push({ id, result }),
    launch: async (options) => {
      const fake = {
        options,
        turns: [],
        closed: 0,
        startTurn: async (turn) => {
          fake.turns.push(turn);
          options.emit({ type: "turn-started" });
        },
        close: async () => {
          fake.closed++;
        },
        interrupt: async () => {},
      };
      launched.push(fake);
      return fake;
    },
    ...overrides,
  });
  t.after(async () => {
    await manager.close();
    await store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { manager, store, launched, published, completions, context, catalog };
}
const input = { title: "Review", prompt: "Assess the code" };
async function running(f, count = 1) {
  await waitUntil(() => f.launched.length === count && f.launched[count - 1].turns.length > 0);
}
async function finish(f, index = 0, text = "Recommendation") {
  f.launched[index].options.emit({ type: "text-delta", text });
  f.launched[index].options.emit({ type: "turn-completed" });
  await waitUntil(() => f.completions.length > index);
}
test("opposite provider, reported model and defaults are pinned without persisting credentials", async (t) => {
  const f = await fixture(t);
  f.catalog.codex.env = { SECRET: "private" };
  const row = await f.manager.create("chat", input);
  await running(f);
  assert.equal(row.provider, "codex");
  assert.equal(row.model, "xm");
  assert.equal(f.launched[0].turns[0].effort, "low");
  assert.equal(JSON.stringify(await f.store.read("chat")).includes("private"), false);
  await finish(f);
  assert.equal((await f.manager.read("chat", row.id)).output, "Recommendation");
  assert.equal(f.published.at(-1).row.source, "milagre-advisor");
});
test("invalid provider/model/effort and caller overrides never launch", async (t) => {
  const f = await fixture(t);
  for (const extra of [{ model: "missing" }, { effort: "ultra" }, { provider: "other" }, { cwd: "/tmp" }])
    await assert.rejects(f.manager.create("chat", { ...input, ...extra }));
  f.catalog.codex.available = false;
  await assert.rejects(f.manager.create("chat", input), /unavailable/i);
  assert.equal(f.launched.length, 0);
});
test("execution is opt-in and requires Full permissions for every turn", async (t) => {
  const f = await fixture(t);
  for (const mode of [undefined, "ask", "auto", "bot"]) {
    f.context.settings = { permissionMode: mode };
    await assert.rejects(f.manager.create("chat", { ...input, mode: "execution" }), /Full permissions/);
  }
  assert.equal(f.launched.length, 0);
  f.context.settings.permissionMode = "full";
  const row = await f.manager.create("chat", { ...input, mode: "execution" });
  await running(f);
  assert.equal(row.mode, "execution");
  assert.equal(f.launched[0].turns[0].permissionMode, "full");
  await finish(f);
  assert.equal(f.completions[0].result.mode, "execution");
  f.context.settings.permissionMode = "auto";
  await assert.rejects(f.manager.followup("chat", row.id, "Run more"), /Full permissions/);
  await f.manager.stop("chat", row.id);
  await assert.rejects(f.manager.retry("chat", row.id), /Full permissions/);
});

test("revoking execution access stops execution sessions while analysis continues", async (t) => {
  const f = await fixture(t);
  f.context.settings = { permissionMode: "full" };
  const execution = await f.manager.create("chat", { ...input, mode: "execution" });
  await running(f);
  const analysis = await f.manager.create("chat", input);
  await running(f, 2);
  await f.manager.stopExecution("chat");
  await waitUntil(() => f.published.some(({ row }) => row.id === execution.id && row.status === "cancelled"));
  assert.equal((await f.manager.read("chat", execution.id)).status, "cancelled");
  assert.equal((await f.manager.read("chat", analysis.id)).status, "running");
  assert.equal(f.launched[0].closed, 1);
  assert.equal(f.launched[1].closed, 0);
  await assert.rejects(f.manager.create("chat", { ...input, mode: "execution" }), /Full permissions/);
  f.manager.resumeExecution("chat");
  const resumed = await f.manager.create("chat", { ...input, mode: "execution" });
  assert.equal(resumed.mode, "execution");
});
for (const method of ["stopExecution", "stopChat"]) {
  test(`${method} stops native execution even while analysis admission holds the queue`, async (t) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const f = await fixture(t, {
      providersFor: async () => {
        if (++calls === 2) await gate;
        return { codex: { available: true, models: [{ id: "xm" }] }, claude: { available: true, models: [{ id: "cm" }] } };
      },
    });
    f.context.settings = { permissionMode: "full" };
    await f.manager.create("chat", { ...input, mode: "execution" });
    await running(f);
    const analysis = f.manager.create("chat", input).catch((error) => error);
    await waitUntil(() => calls === 2);
    const stopping = f.manager[method]("chat");
    await waitUntil(() => f.launched[0].closed === 1);
    release();
    await analysis;
    await stopping;
  });
}
test("Stop and terminal cleanup share one native close", async (t) => {
  const f = await fixture(t);
  f.context.settings = { permissionMode: "full" };
  const row = await f.manager.create("chat", { ...input, mode: "execution" });
  await running(f);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.launched[0].close = async () => {
    f.launched[0].closed++;
    await gate;
  };
  f.launched[0].options.emit({ type: "turn-completed" });
  await waitUntil(() => f.launched[0].closed === 1);
  const stopping = f.manager.stop("chat", row.id);
  await waitUntil(() => f.published.some(({ row: saved }) => saved.id === row.id && saved.status === "cancelled"));
  release();
  await stopping;
  assert.equal(f.launched[0].closed, 1);
  assert.equal(f.completions.length, 0);
});
test("execution releases its process before publishing completion and resumes followups afresh", async (t) => {
  const f = await fixture(t);
  f.context.settings = { permissionMode: "full" };
  const row = await f.manager.create("chat", { ...input, mode: "execution" });
  await running(f);
  await finish(f);
  assert.equal(f.launched[0].closed, 1);
  await f.manager.followup("chat", row.id, "Check again");
  await running(f, 2);
  assert.equal(f.launched[1].turns[0].prompt, "Check again");
});
test("failed image capture preserves the terminal execution report", async (t) => {
  const f = await fixture(t, {
    captureOutput: async () => {
      throw new Error("Storage unavailable");
    },
  });
  f.context.settings = { permissionMode: "full" };
  const row = await f.manager.create("chat", { ...input, mode: "execution" });
  await running(f);
  await finish(f, 0, "Checks passed; screenshot unavailable");
  assert.equal((await f.manager.read("chat", row.id)).status, "completed");
  assert.equal(f.completions[0].result.output, "Checks passed; screenshot unavailable");
});
test("reconciliation releases the advisor queue before a delivered result starts its parent", async (t) => {
  let manager;
  const f = await fixture(t, { completed: async () => manager.stopExecution("chat") });
  manager = f.manager;
  await f.store.update("chat", () => [
    { id: "advisor:recovered", chatId: "chat", status: "completed", queuedPrompts: [], transcript: [], completions: [{ id: "result", delivery: "pending" }] },
  ]);
  await Promise.race([f.manager.reconcile("chat"), new Promise((_, reject) => setTimeout(() => reject(new Error("Reconciliation deadlocked")), 1000))]);
});
test("only one execution advisor runs at once and unexpected human requests are settled", async (t) => {
  const f = await fixture(t);
  f.context.settings = { permissionMode: "full" };
  await f.manager.create("chat", { ...input, mode: "execution" });
  await running(f);
  await assert.rejects(f.manager.create("chat", { ...input, mode: "execution" }), /already active/);
  const answers = [];
  f.launched[0].respondToPermission = (...args) => answers.push(args);
  f.launched[0].answerQuestion = (...args) => answers.push(args);
  f.launched[0].options.emit({ type: "permission-request", requestId: "permission" });
  f.launched[0].options.emit({ type: "question-request", requestId: "question" });
  await waitUntil(() => answers.length === 2);
  assert.deepEqual(answers, [
    ["permission", "deny"],
    ["question", null],
  ]);
});
test("concurrent admission allows two active advisors, ownership blocks other Chats", async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([1, 2, 3].map(() => f.manager.create("chat", input)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  const id = results[0].value.id;
  for (const method of ["read", "stop", "retry"]) await assert.rejects(f.manager[method]("other", id), /belong/i);
  await assert.rejects(f.manager.followup("other", id, "more"), /belong/i);
});
test("follow-ups wait for completion, preserve the session and cap the queue", async (t) => {
  const f = await fixture(t);
  const row = await f.manager.create("chat", input);
  await running(f);
  for (let i = 0; i < 4; i++) await f.manager.followup("chat", row.id, `follow ${i}`);
  await assert.rejects(f.manager.followup("chat", row.id, "overflow"), /four|4/i);
  assert.equal(f.launched[0].turns.length, 1);
  await finish(f);
  await waitUntil(() => f.launched[0].turns.length === 2);
  assert.equal(f.launched.length, 1);
  assert.equal(f.launched[0].turns[1].prompt, "follow 0");
  await f.manager.stop("chat", row.id);
  assert.deepEqual((await f.manager.read("chat", row.id)).queuedPrompts, []);
});
test("changed scope rejects further work", async (t) => {
  const f = await fixture(t);
  const row = await f.manager.create("chat", input);
  await running(f);
  await finish(f);
  f.context.scopeIdentity = "scope-v2";
  await assert.rejects(f.manager.followup("chat", row.id, "more"), /scope|worktree/i);
});
test("a scope change cancels queued advisor follow-ups and releases their slot", async (t) => {
  const f = await fixture(t);
  const row = await f.manager.create("chat", input);
  await running(f);
  await f.manager.followup("chat", row.id, "Review again");
  f.context.scopeIdentity = "scope-v2";
  await finish(f);
  await waitUntil(() => f.launched[0].closed === 1);
  const stopped = await f.manager.read("chat", row.id);
  assert.deepEqual(stopped.queuedPrompts, []);
  assert.equal(stopped.status, "failed");
  assert.match(stopped.transcript.at(-1).text, /scope changed/i);
  await f.manager.create("chat", input);
  await f.manager.create("chat", input);
});
test("Stop during startup closes the late process and ignores its events", async (t) => {
  let release;
  const waiting = new Promise((r) => (release = r));
  let options;
  let closed = 0;
  let turns = 0;
  const f = await fixture(t, {
    launch: async (o) => {
      options = o;
      await waiting;
      return {
        startTurn: async () => {
          turns++;
        },
        close: async () => {
          closed++;
        },
        interrupt: async () => {},
      };
    },
  });
  const row = await f.manager.create("chat", input);
  await waitUntil(() => options);
  await f.manager.stop("chat", row.id);
  release();
  await waitUntil(() => closed > 0);
  options.emit({ type: "turn-completed" });
  assert.equal(turns, 0);
  assert.equal(f.completions.length, 0);
  assert.equal((await f.manager.read("chat", row.id)).status, "cancelled");
});
test("recovery retains output, interrupts unfinished work and never replays uncertain delivery", async (t) => {
  const f = await fixture(t);
  const row = await f.manager.create("chat", input);
  await running(f);
  await finish(f);
  await f.store.update("chat", (records) =>
    records.map((r) => ({ ...r, delivery: "sending", completions: r.completions.map((c) => ({ ...c, delivery: "sending" })) })),
  );
  const second = await f.manager.create("chat", input);
  await running(f, 2);
  await f.manager.close();
  const recovered = createAdvisors({
    store: f.store,
    contextFor: async () => f.context,
    providersFor: async () => f.catalog,
    launch: async () => {
      throw Error("must not launch");
    },
    publish: async () => {},
    completed: async () => {
      throw Error("must not replay");
    },
  });
  await recovered.reconcile("chat");
  assert.equal((await recovered.read("chat", row.id)).delivery, "uncertain");
  assert.equal((await recovered.read("chat", row.id)).output, "Recommendation");
  assert.equal((await recovered.read("chat", second.id)).retryable, true);
  await recovered.close();
});
test("failed durable admission never starts a process", async (t) => {
  const f = await fixture(t, {
    store: {
      read: async () => [],
      update: async () => {
        throw Error("disk full");
      },
      flush: async () => {},
    },
  });
  await assert.rejects(f.manager.create("chat", input), /disk full/);
  assert.equal(f.launched.length, 0);
});
test("a queued follow-up keeps its slot reserved while completion delivery waits", async (t) => {
  let release;
  const held = new Promise((r) => (release = r));
  const f = await fixture(t, { completed: async () => held });
  const a = await f.manager.create("chat", input);
  await running(f);
  await f.manager.followup("chat", a.id, "next");
  await f.manager.create("chat", input);
  await running(f, 2);
  f.launched[0].options.emit({ type: "turn-completed" });
  await waitUntil(() => f.published.some((p) => p.row.id === a.id && p.row.status === "completed"));
  await assert.rejects(f.manager.create("chat", input), /Two advisors/);
  release();
});
test("Retry keeps the advisor ID, uses the pinned Account and starts a new turn", async (t) => {
  const f = await fixture(t);
  const row = await f.manager.create("chat", input);
  await running(f);
  await f.manager.stop("chat", row.id);
  f.catalog.codex.accountId = "changed";
  await assert.rejects(f.manager.retry("chat", row.id), /Account/);
  f.catalog.codex.accountId = "co";
  const retried = await f.manager.retry("chat", row.id);
  await running(f, 2);
  assert.equal(retried.id, row.id);
  assert.equal((await f.manager.read("chat", row.id)).turnNumber, 2);
});
test("the advisor's prompt is the question alone, and Retry after a follow-up asks the original question again", async (t) => {
  const f = await fixture(t);
  const row = await f.manager.create("chat", input);
  await running(f);
  // The analysis-only rules live in the advisor's system prompt (events.cjs advisorInstructions).
  assert.equal(f.launched[0].turns[0].prompt, "Assess the code");
  await finish(f);
  await f.manager.followup("chat", row.id, "Check the tests too");
  await waitUntil(() => f.launched[0].turns.length === 2);
  await f.manager.stop("chat", row.id);
  await f.manager.retry("chat", row.id);
  await running(f, 2);
  assert.equal(
    f.launched[1].turns[0].prompt,
    "Assess the code\n\nPrevious saved output:\nRecommendation\n\nFollow-up that was interrupted:\nCheck the tests too",
  );
  await f.manager.stop("chat", row.id);
  await f.manager.retry("chat", row.id);
  await running(f, 3);
  assert.equal(f.launched[2].turns[0].prompt, f.launched[1].turns[0].prompt, "a second Retry doesn't nest the first");
});
test("Stop fences an admission still resolving the provider", async (t) => {
  let release;
  const held = new Promise((r) => (release = r));
  let called = false;
  const f = await fixture(t, {
    providersFor: async () => {
      called = true;
      await held;
      return { codex: { available: true, models: [{ id: "x", efforts: [] }] } };
    },
  });
  const creating = f.manager.create("chat", input);
  await waitUntil(() => called);
  const stopping = f.manager.stopChat("chat");
  release();
  await assert.rejects(creating, /stopped/);
  await stopping;
  assert.equal(f.launched.length, 0);
});

for (const operation of ["create", "followup", "retry", "queued followup"]) {
  test(`Stop before ${operation} publication finishes prevents the provider turn`, async (t) => {
    let held = false,
      seen,
      release;
    const published = new Promise((resolve) => (seen = resolve));
    const gate = new Promise((resolve) => (release = resolve));
    const f = await fixture(t, {
      publish: async (_chat, row) => {
        if (held && row.status === "initializing") {
          seen(row);
          await gate;
        }
      },
    });
    t.after(release);
    let row;
    if (operation !== "create") {
      row = await f.manager.create("chat", input);
      await running(f);
      if (operation === "followup") await finish(f);
      else if (operation === "retry") await f.manager.stop("chat", row.id);
      else await f.manager.followup("chat", row.id, "queued");
    }
    held = true;
    let pending;
    if (operation === "create") pending = f.manager.create("chat", input);
    else if (operation === "followup") pending = f.manager.followup("chat", row.id, "next");
    else if (operation === "retry") pending = f.manager.retry("chat", row.id);
    else f.launched[0].options.emit({ type: "turn-completed" });
    const visible = await published;
    await f.manager.stop("chat", visible.id);
    release();
    await pending;
    await new Promise(setImmediate);
    assert.equal(
      f.launched.reduce((total, session) => total + session.turns.length, 0),
      operation === "create" ? 0 : 1,
    );
    assert.equal((await f.manager.read("chat", visible.id)).status, "cancelled");
  });
}

for (const operation of ["followup", "retry"])
  for (const scope of ["Chat", "advisor"]) {
    test(`${scope} Stop fences ${operation} still resolving its provider`, async (t) => {
      let hold = false,
        called,
        release;
      const waiting = new Promise((resolve) => (called = resolve));
      const gate = new Promise((resolve) => (release = resolve));
      let catalog;
      const f = await fixture(t, {
        providersFor: async () => {
          if (hold) {
            called();
            await gate;
          }
          return catalog;
        },
      });
      catalog = f.catalog;
      t.after(release);
      const row = await f.manager.create("chat", input);
      await running(f);
      if (operation === "retry") await f.manager.stop("chat", row.id);
      else await finish(f);
      hold = true;
      const pending = operation === "retry" ? f.manager.retry("chat", row.id) : f.manager.followup("chat", row.id, "next");
      await waiting;
      const stopping = scope === "Chat" ? f.manager.stopChat("chat") : f.manager.stop("chat", row.id);
      if (scope === "advisor") await stopping;
      release();
      await assert.rejects(pending, /stopped/);
      await stopping;
      assert.equal(
        f.launched.reduce((total, session) => total + session.turns.length, 0),
        1,
      );
    });
  }
