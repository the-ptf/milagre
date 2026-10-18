const assert = require("node:assert/strict");
const test = require("node:test");
const { KeepAwake } = require("./keep-awake.cjs");

function fakeBlocker() {
  const active = new Set();
  let next = 1;
  return {
    started: [],
    stopped: [],
    start(type) {
      const id = next++;
      active.add(id);
      this.started.push(type);
      return id;
    },
    stop(id) {
      active.delete(id);
      this.stopped.push(id);
    },
    isStarted: (id) => active.has(id),
    get held() {
      return active.size;
    },
  };
}

test("one blocker holds for overlapping turns and stops after the last", () => {
  const blocker = fakeBlocker();
  const awake = new KeepAwake({ powerSaveBlocker: blocker });
  awake.turnStarted("a");
  awake.turnStarted("b");
  assert.deepEqual(blocker.started, ["prevent-app-suspension"]);
  assert.equal(blocker.held, 1);
  awake.turnEnded("a");
  assert.equal(blocker.held, 1);
  awake.turnEnded("b");
  assert.equal(blocker.held, 0);
});

test("a repeated start for one chat does not stack", () => {
  const blocker = fakeBlocker();
  const awake = new KeepAwake({ powerSaveBlocker: blocker });
  awake.turnStarted("a");
  awake.turnStarted("a");
  awake.turnEnded("a");
  assert.equal(blocker.held, 0);
  assert.equal(blocker.started.length, 1);
});

test("a second turn after the first ended takes a fresh blocker", () => {
  const blocker = fakeBlocker();
  const awake = new KeepAwake({ powerSaveBlocker: blocker });
  awake.turnStarted("a");
  awake.turnEnded("a");
  awake.turnStarted("a");
  assert.equal(blocker.started.length, 2);
  assert.equal(blocker.held, 1);
});

test("an ending that never had a start does nothing", () => {
  const blocker = fakeBlocker();
  const awake = new KeepAwake({ powerSaveBlocker: blocker });
  awake.turnEnded("a");
  assert.equal(blocker.stopped.length, 0);
});

test("with the setting off no blocker starts", () => {
  const blocker = fakeBlocker();
  const awake = new KeepAwake({ powerSaveBlocker: blocker, enabled: false });
  awake.turnStarted("a");
  assert.equal(blocker.started.length, 0);
  assert.equal(awake.isHolding, false);
});

test("turning the setting off mid-turn releases at once, and on again holds for the running turn", () => {
  const blocker = fakeBlocker();
  const awake = new KeepAwake({ powerSaveBlocker: blocker });
  awake.turnStarted("a");
  assert.equal(blocker.held, 1);
  awake.setEnabled(false);
  assert.equal(blocker.held, 0);
  awake.turnEnded("b");
  assert.equal(blocker.held, 0);
  awake.setEnabled(true);
  assert.equal(blocker.held, 1);
  awake.turnEnded("a");
  assert.equal(blocker.held, 0);
});

test("a closed or crashed chat releases its turn", () => {
  const blocker = fakeBlocker();
  const awake = new KeepAwake({ powerSaveBlocker: blocker });
  awake.turnStarted("a");
  awake.turnStarted("b");
  awake.chatClosed("a");
  assert.equal(blocker.held, 1);
  awake.chatClosed("b");
  assert.equal(blocker.held, 0);
});

test("quitting releases and later turns hold nothing", () => {
  const blocker = fakeBlocker();
  const awake = new KeepAwake({ powerSaveBlocker: blocker });
  awake.turnStarted("a");
  awake.quit();
  assert.equal(blocker.held, 0);
  awake.turnStarted("b");
  assert.equal(blocker.held, 0);
});

test("observe follows a chat's events", () => {
  const blocker = fakeBlocker();
  const awake = new KeepAwake({ powerSaveBlocker: blocker });
  awake.observe("a", { type: "turn-started", turnId: "1" });
  awake.observe("a", { type: "text-delta", messageId: "1", text: "hi" });
  assert.equal(blocker.held, 1);
  awake.observe("a", { type: "turn-failed", message: "x" });
  assert.equal(blocker.held, 0);
  awake.observe("b", { type: "turn-started", turnId: "2" });
  awake.observe("b", { type: "turn-cancelled" });
  assert.equal(blocker.held, 0);
});

test("a setup holds while it runs and hands the hold to its turn without a gap", () => {
  const blocker = fakeBlocker();
  const awake = new KeepAwake({ powerSaveBlocker: blocker });
  awake.setupStarted("a");
  assert.equal(blocker.held, 1);
  awake.setupEnded("a", { turnFollows: true });
  awake.observe("a", { type: "turn-started", turnId: "1" });
  assert.equal(blocker.held, 1);
  assert.equal(blocker.started.length, 1);
  assert.equal(blocker.stopped.length, 0);
  awake.observe("a", { type: "turn-completed" });
  assert.equal(blocker.held, 0);
});

test("a cancelled setup releases, and so does a turn that ends before it starts", () => {
  const blocker = fakeBlocker();
  const awake = new KeepAwake({ powerSaveBlocker: blocker });
  awake.setupStarted("a");
  awake.setupEnded("a");
  assert.equal(blocker.held, 0);
  awake.setupStarted("b");
  awake.setupEnded("b", { turnFollows: true });
  assert.equal(blocker.held, 1);
  awake.observe("b", { type: "turn-failed", message: "codex is missing" });
  assert.equal(blocker.held, 0);
  awake.setupStarted("c");
  awake.setupEnded("c", { turnFollows: true });
  awake.turnNotStarted("c");
  assert.equal(blocker.held, 0);
});

test("archiving a chat mid-setup releases it", () => {
  const blocker = fakeBlocker();
  const awake = new KeepAwake({ powerSaveBlocker: blocker });
  awake.setupStarted("a");
  awake.chatClosed("a");
  assert.equal(blocker.held, 0);
  // The setup's own end arrives later and changes nothing.
  awake.setupEnded("a", { turnFollows: true });
  assert.equal(blocker.held, 0);
});

test("with the setting off a setup holds nothing", () => {
  const blocker = fakeBlocker();
  const awake = new KeepAwake({ powerSaveBlocker: blocker, enabled: false });
  awake.setupStarted("a");
  assert.equal(blocker.started.length, 0);
  awake.setEnabled(true);
  assert.equal(blocker.held, 1);
  awake.quit();
  assert.equal(blocker.held, 0);
});

test("enabled Routines hold the blocker with no turns until switched off", () => {
  const blocker = fakeBlocker();
  const awake = new KeepAwake({ powerSaveBlocker: blocker });
  awake.setRoutinesActive(true);
  assert.equal(blocker.held, 1);
  awake.turnStarted("a");
  awake.turnEnded("a");
  assert.equal(blocker.held, 1);
  awake.setRoutinesActive(false);
  assert.equal(blocker.held, 0);
});
