const test = require("node:test");
const assert = require("node:assert/strict");
const { background, currentLane, kindOf, createLanes, scheduled } = require("./process-lanes.cjs");

const tick = () => new Promise((resolve) => setImmediate(resolve));
// A task that runs until `finish()`; `started` says whether it got a slot.
function held() {
  let finish;
  const task = { started: false, done: new Promise((resolve) => (finish = resolve)) };
  task.finish = () => finish();
  task.run = () => {
    task.started = true;
    return task.done;
  };
  return task;
}

test("git and gh are limited by their program name; anything else is not", () => {
  assert.equal(kindOf("git"), "git");
  assert.equal(kindOf("/opt/homebrew/bin/gh"), "gh");
  assert.equal(kindOf("C:\\Program Files\\Git\\cmd\\git.exe"), "git");
  assert.equal(kindOf("/usr/bin/xcrun"), null);
  assert.equal(kindOf(undefined), null);
});

test("work is interactive unless it runs inside background(), including what it awaits", async () => {
  assert.equal(currentLane(), "interactive");
  await background(async () => {
    await tick();
    assert.equal(currentLane(), "background");
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(currentLane(), "background");
  });
  assert.equal(currentLane(), "interactive");
});

test("background work leaves one slot free, and interactive work takes it at once", async () => {
  const lanes = createLanes({ gh: 3 });
  const slow = [held(), held(), held()];
  const runs = slow.map((task) => lanes.run("gh", task.run, "background"));
  await tick();
  assert.deepEqual(
    slow.map((task) => task.started),
    [true, true, false],
    "two of three slots go to background work",
  );
  const detail = held();
  const asked = lanes.run("gh", detail.run, "interactive");
  await tick();
  assert.equal(detail.started, true, "the held-back slot serves the interactive call");
  detail.finish();
  await asked;
  assert.equal(slow[2].started, false, "a freed slot that is the reserved one stays free");
  slow[0].finish();
  await tick();
  assert.equal(slow[2].started, true);
  for (const task of slow) task.finish();
  await Promise.all(runs);
  assert.deepEqual(lanes.stats("gh"), { running: 0, interactive: 0, background: 0 });
});

test("a waiting interactive call goes before every waiting background one", async () => {
  const lanes = createLanes({ git: 2 });
  const first = held();
  const second = held();
  const order = [];
  void lanes.run("git", first.run, "interactive");
  void lanes.run("git", second.run, "interactive");
  const queued = [lanes.run("git", async () => order.push("background"), "background"), lanes.run("git", async () => order.push("interactive"), "interactive")];
  await tick();
  assert.deepEqual(order, []);
  first.finish();
  second.finish();
  await Promise.all(queued);
  assert.deepEqual(order, ["interactive", "background"]);
});

test("a failed task frees its slot", async () => {
  const lanes = createLanes({ git: 1 });
  await assert.rejects(
    lanes.run("git", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await lanes.run("git", async () => "next"), "next");
});

test("scheduled() limits git and gh by the caller's lane and passes other programs straight through", async () => {
  const lanes = createLanes({ gh: 2 });
  const running = new Set();
  let peak = 0;
  const exec = async (command) => {
    running.add(command);
    peak = Math.max(peak, running.size);
    await tick();
    running.delete(command);
    return { stdout: command };
  };
  let n = 0;
  const wrapped = scheduled((command, args) => exec(`${command}#${n++}`, args), lanes);
  await background(() => Promise.all(Array.from({ length: 6 }, () => wrapped("gh", []))));
  assert.equal(peak, 1, "background gh never takes the last slot");
  peak = 0;
  await Promise.all(Array.from({ length: 6 }, () => wrapped("/usr/bin/true", [])));
  assert.equal(peak, 6, "an unlimited program isn't queued");
});
