const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createScreenFeed } = require("./computer-use-screen.cjs");

// A manual clock: timers fire only when the test runs them.
function clock() {
  let time = 1000;
  const timers = new Map();
  let id = 0;
  return {
    now: () => time,
    setTimer: (fn, ms) => (timers.set(++id, { fn, at: time + ms }), id),
    clearTimer: (handle) => timers.delete(handle),
    async tick(ms) {
      time += ms;
      for (const [handle, timer] of timers)
        if (timer.at <= time) {
          timers.delete(handle);
          await timer.fn();
        }
    },
  };
}

function setup(replies) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "screen-feed-"));
  const calls = [];
  const time = clock();
  const feed = createScreenFeed({
    dir,
    exec: async (args) => (calls.push(args), replies.length > 1 ? replies.shift() : replies[0]),
    interval: 500,
    idle: 2000,
    ...time,
  });
  return { dir, calls, time, feed };
}

test("frames follow the window the agent used, deduplicated, and stop when it goes quiet", async () => {
  const { feed, calls, time, dir } = setup([
    { ok: true, data: { data: "AAA", format: "png", width: 10, height: 8 } },
    { ok: true, data: { data: "AAA", format: "png" } },
    { ok: true, data: { data: "BBB", format: "png" } },
  ]);
  feed.touch({ chatId: "/p#1", app: "TextEdit", windowId: "w-1", title: "Untitled" });
  assert.equal(feed.live("/p#1"), true);
  await time.tick(500);
  assert.deepEqual(calls[0], ["screenshot", "--window-id", "w-1", "--session", "milagre-capture"]);
  const first = await feed.next({ chatId: "/p#1" });
  assert.equal(first.seq, 1);
  assert.equal(first.image, "AAA");
  assert.equal(first.title, "Untitled");
  await time.tick(500);
  assert.equal((await feed.next({ chatId: "/p#1" })).seq, 1, "an unchanged picture is not a new frame");
  const waiting = feed.next({ chatId: "/p#1", after: 1 });
  await time.tick(500);
  assert.equal((await waiting).image, "BBB");
  await time.tick(2000);
  assert.equal(feed.live("/p#1"), false);
  assert.equal(fs.readdirSync(dir).length, 1, "the last frame is kept");
  const restarted = createScreenFeed({ dir, exec: async () => ({ ok: false }) });
  const kept = await restarted.next({ chatId: "/p#1" });
  assert.equal(kept.image, "BBB");
  assert.equal(kept.live, false);
});

test("a viewer of an idle Chat gets its answer at once", async () => {
  const { feed } = setup([]);
  assert.deepEqual(await feed.next({ chatId: "/p#9", after: 0 }), { seq: 0, live: false });
});

test("missing Screen Recording becomes one error frame", async () => {
  const denied = { ok: false, error: { code: "PERM_DENIED" } };
  const { feed, time } = setup([denied, denied]);
  feed.touch({ chatId: "/p#1", app: "Notes" });
  await time.tick(500);
  await time.tick(500);
  const frame = await feed.next({ chatId: "/p#1" });
  assert.equal(frame.error, "screen-recording");
  assert.equal(frame.seq, 1);
});

test("a closed window falls back to the app's front window", async () => {
  const { feed, time, calls } = setup([{ ok: false, error: { code: "WINDOW_NOT_FOUND" } }]);
  feed.touch({ chatId: "/p#1", app: "Notes", windowId: "w-2" });
  await time.tick(500);
  await time.tick(500);
  assert.deepEqual(calls[1].slice(0, 3), ["screenshot", "--app", "Notes"]);
});
