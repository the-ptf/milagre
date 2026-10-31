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

test("a viewer mounted during a delayed first tool stays subscribed until its capture starts", async () => {
  const { feed, time } = setup([{ ok: true, data: { data: "FIRST" } }]);
  let answered = false;
  const first = feed.next({ chatId: "/p#9", after: 0 }).then((frame) => ((answered = true), frame));
  await time.tick(5000);
  assert.equal(answered, false, "the only tool has not completed yet");
  feed.touch({ chatId: "/p#9", app: "TextEdit" });
  await time.tick(500);
  assert.equal((await first).image, "FIRST");
  const final = feed.next({ chatId: "/p#9", after: 1 });
  await time.tick(2000);
  assert.equal((await final).live, false);
});

test("an idle subscription times out without a busy request loop", async () => {
  const { feed, time } = setup([]);
  const idle = feed.next({ chatId: "/p#9" });
  await time.tick(15000);
  assert.deepEqual(await idle, { seq: 0, live: false });
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

test("forget removes loaded and unloaded persisted frames across a restart, preserving other Chats", async (t) => {
  const { feed, time, dir } = setup([{ ok: true, data: { data: "RETAINED" } }]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const chatId of ["/p#1", "/p#2", "/p#3"]) feed.touch({ chatId, app: "TextEdit" });
  await time.tick(2500);
  feed.forget("/p#1");
  const restarted = createScreenFeed({ dir, exec: async () => ({ ok: false }) });
  restarted.forget("/p#2");
  assert.equal(fs.readdirSync(dir).length, 1);
  for (const chatId of ["/p#1", "/p#2"]) assert.deepEqual(await restarted.next({ chatId, after: -1 }), { seq: 0, live: false });
  assert.equal((await restarted.next({ chatId: "/p#3" })).image, "RETAINED");
});

test("deletion during capture clears waiting viewers and cannot recreate the file or capture timer", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "screen-delete-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const time = clock();
  let finish;
  let captures = 0;
  const feed = createScreenFeed({ dir, ...time, exec: () => (captures++, new Promise((resolve) => (finish = resolve))) });
  feed.touch({ chatId: "/p#1", app: "TextEdit" });
  const waiting = feed.next({ chatId: "/p#1" });
  const capturing = time.tick(500);
  feed.forget("/p#1");
  assert.deepEqual(await waiting, { seq: 0, live: false });
  finish({ ok: true, data: { data: "DELETED" } });
  await capturing;
  await time.tick(30000);
  assert.equal(captures, 1);
  assert.equal(feed.live("/p#1"), false);
  assert.deepEqual(fs.readdirSync(dir), []);
  const restarted = createScreenFeed({ dir, exec: async () => ({ ok: false }) });
  assert.deepEqual(await restarted.next({ chatId: "/p#1", after: -1 }), { seq: 0, live: false });
});
