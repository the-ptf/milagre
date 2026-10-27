const assert = require("node:assert/strict");
const test = require("node:test");
const { createBabysitWatch } = require("./babysit-watch.cjs");

const URL = "https://github.com/the-ptf/milagre-ade/pull/42";
const CHAT = "/project#2";
const SETTINGS = { enabled: true, stopAfterDays: { on: true, days: 7 } };

function harness({ settings = SETTINGS, live = null } = {}) {
  const created = [];
  const routines = {
    findPullRequest: (repo, number) => (live && live.repo === repo && live.number === number ? { id: "r" } : undefined),
    createBabysit: async (input) => {
      created.push(input);
      return { id: "new" };
    },
  };
  const watch = createBabysitWatch({ settings: { read: () => settings }, routines });
  const run = async (detail, { id = "s1", kind = "shell", status = "done", chatId = CHAT } = {}) => {
    watch.observe(chatId, { type: "step-started", step: { id, kind, title: "Run", detail: "$ gh pr create\n" } });
    return watch.observe(chatId, { type: "step-completed", id, status, detail });
  };
  return { created, watch, run };
}

const OUTPUT = `$ gh pr create --fill\nCreating pull request\n${URL}\n`;

test("gh pr create creates one babysit heartbeat", async () => {
  const { created, run } = harness();
  await run(OUTPUT);
  assert.deepEqual(created, [{ chatId: CHAT, url: URL, repo: "github.com/the-ptf/milagre-ade", number: 42, settings: SETTINGS }]);
});

test("second gh pr create for the same PR creates nothing", async () => {
  const { created, run } = harness({ live: { repo: "github.com/the-ptf/milagre-ade", number: 42 } });
  await run(OUTPUT);
  assert.deepEqual(created, []);
});

test("disabled setting creates nothing", async () => {
  const { created, run } = harness({ settings: { ...SETTINGS, enabled: false } });
  await run(OUTPUT);
  assert.deepEqual(created, []);
});

test("failed step creates nothing", async () => {
  const { created, run } = harness();
  await run(OUTPUT, { status: "failed" });
  assert.deepEqual(created, []);
});

test("non-shell step with gh text is ignored", async () => {
  const { created, run } = harness();
  await run(OUTPUT, { kind: "tool" });
  assert.deepEqual(created, []);
});

test("a step seen only at its end, or a command that is not gh pr create, creates nothing", async () => {
  const { created, watch, run } = harness();
  await watch.observe(CHAT, { type: "step-completed", id: "unseen", status: "done", detail: OUTPUT });
  await run(`$ gh pr view\n${URL}\n`);
  await run("$ gh pr create\nfailed to open\n");
  assert.deepEqual(created, []);
});

test("an error from the Routines never escapes observe", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const routines = {
    findPullRequest: () => undefined,
    createBabysit: async () => {
      throw new Error("already being babysat");
    },
  };
  const watch = createBabysitWatch({ settings: { read: () => SETTINGS }, routines });
  watch.observe(CHAT, { type: "step-started", step: { id: "s", kind: "shell", detail: "$ gh pr create\n" } });
  await watch.observe(CHAT, { type: "step-completed", id: "s", status: "done", detail: OUTPUT });
  assert.equal(warn.mock.callCount(), 1);
});

test("a turn's end forgets steps that never completed", async () => {
  const { created, watch } = harness();
  watch.observe(CHAT, { type: "step-started", step: { id: "s", kind: "shell", detail: "$ gh pr create\n" } });
  watch.observe(CHAT, { type: "turn-completed" });
  await watch.observe(CHAT, { type: "step-completed", id: "s", status: "done", detail: OUTPUT });
  assert.deepEqual(created, []);
});
