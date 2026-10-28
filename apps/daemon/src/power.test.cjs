const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createPowerBlocker } = require("./power.cjs");
const { KeepAwake } = require("@milagre/core/keep-awake");

test("Milagre holds one macOS assertion while it runs and releases it on quit or when switched off", () => {
  const children = [];
  const blocker = createPowerBlocker({
    platform: "darwin",
    spawn(command, args) {
      assert.equal(command, "/usr/bin/caffeinate");
      assert.deepEqual(args, ["-i", "-w", String(process.pid)]);
      const child = new EventEmitter();
      child.unref = () => {};
      child.kill = (signal) => {
        child.signal = signal;
      };
      children.push(child);
      return child;
    },
  });
  const awake = new KeepAwake({ powerSaveBlocker: blocker });
  assert.equal(children.length, 1);
  awake.setEnabled(false);
  assert.equal(children[0].signal, "SIGTERM");
  awake.setEnabled(true);
  assert.equal(children.length, 2);
  awake.quit();
  assert.equal(children[1].signal, "SIGTERM");
});
