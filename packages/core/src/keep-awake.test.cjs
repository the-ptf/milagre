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

test("one blocker holds from the start, with no turn running", () => {
  const blocker = fakeBlocker();
  const awake = new KeepAwake({ powerSaveBlocker: blocker });
  assert.deepEqual(blocker.started, ["prevent-app-suspension"]);
  assert.equal(awake.isHolding, true);
  awake.setEnabled(true);
  assert.equal(blocker.started.length, 1);
});

test("with the setting off no blocker starts", () => {
  const blocker = fakeBlocker();
  const awake = new KeepAwake({ powerSaveBlocker: blocker, enabled: false });
  assert.equal(blocker.started.length, 0);
  assert.equal(awake.isHolding, false);
});

test("turning the setting off releases at once, and on again takes a fresh blocker", () => {
  const blocker = fakeBlocker();
  const awake = new KeepAwake({ powerSaveBlocker: blocker });
  awake.setEnabled(false);
  assert.equal(blocker.held, 0);
  awake.setEnabled(false);
  assert.equal(blocker.stopped.length, 1);
  awake.setEnabled(true);
  assert.equal(blocker.held, 1);
  assert.equal(blocker.started.length, 2);
});

test("quitting releases for good", () => {
  const blocker = fakeBlocker();
  const awake = new KeepAwake({ powerSaveBlocker: blocker });
  awake.quit();
  assert.equal(blocker.held, 0);
  awake.setEnabled(true);
  assert.equal(blocker.held, 0);
});

test("a blocker that already died is not stopped again", () => {
  const blocker = fakeBlocker();
  const awake = new KeepAwake({ powerSaveBlocker: blocker });
  blocker.stop(1);
  awake.setEnabled(false);
  assert.deepEqual(blocker.stopped, [1]);
});
