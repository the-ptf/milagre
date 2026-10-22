import assert from "node:assert/strict";
import test from "node:test";
import { startRefreshLoop } from "./refresh-loop.mjs";

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function fixture(refresh) {
  let active = true,
    listener,
    detached = false;
  const timers = new Map();
  let id = 0;
  const stop = startRefreshLoop({
    refresh,
    isActive: () => active,
    onActive(fn) {
      listener = fn;
      return () => {
        detached = true;
      };
    },
    schedule(fn, ms) {
      assert.equal(ms, 3000);
      timers.set(++id, fn);
      return id;
    },
    cancel(timer) {
      timers.delete(timer);
    },
  });
  return {
    timers,
    stop,
    visibility(value) {
      active = value;
      listener();
    },
    tick() {
      const [key, fn] = timers.entries().next().value;
      timers.delete(key);
      return fn();
    },
    get detached() {
      return detached;
    },
  };
}

test("external changes are read again without agent events or manual refresh", async () => {
  let files = ["changed.txt"],
    shown;
  const f = fixture(async () => {
    shown = [...files];
  });
  await settle();
  assert.deepEqual(shown, ["changed.txt"]);
  files = []; // A commit in another tool.
  await f.tick();
  assert.deepEqual(shown, []);
  files = ["new.txt"];
  await f.tick();
  assert.deepEqual(shown, ["new.txt"]);
  f.stop();
  assert.equal(f.timers.size, 0);
  assert.equal(f.detached, true);
});

test("polling pauses while hidden and reads immediately on return", async () => {
  let reads = 0;
  const f = fixture(async () => {
    reads++;
  });
  await settle();
  f.visibility(false);
  assert.equal(f.timers.size, 0);
  assert.equal(reads, 1);
  f.visibility(true);
  await settle();
  assert.equal(reads, 2);
  assert.equal(f.timers.size, 1);
  f.stop();
});

test("slow reads never overlap and disposal during a read cannot restart polling", async () => {
  let finish,
    reads = 0;
  const f = fixture(() => {
    reads++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  f.visibility(false);
  f.visibility(true);
  assert.equal(reads, 1);
  assert.equal(f.timers.size, 0);
  finish();
  await settle();
  assert.equal(f.timers.size, 1);
  const pending = f.tick();
  assert.equal(reads, 2);
  f.stop();
  finish();
  await pending;
  assert.equal(f.timers.size, 0);
});

test("a failed read does not stop future updates", async () => {
  let reads = 0;
  const f = fixture(async () => {
    if (++reads === 1) throw new Error("disconnected");
  });
  await settle();
  await f.tick();
  assert.equal(reads, 2);
  assert.equal(f.timers.size, 1);
  f.stop();
});
