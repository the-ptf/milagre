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
  const context = { scopeIdentity: "scope-v1", parentProvider: "claude", cwd: dataDir };
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
