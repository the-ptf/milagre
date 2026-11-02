const assert = require("node:assert/strict");
const test = require("node:test");
const { createDoneSweep } = require("./done-sweep.cjs");

const HOUR = 60 * 60 * 1000;
const NOW = 100 * HOUR;

function sweepOf({ retentionHours = 24, scopes, archive = async () => true, closing = () => false }) {
  const archived = [];
  const sweep = createDoneSweep({
    settings: { read: () => ({ retentionHours }) },
    scopes: () => Object.keys(scopes),
    heldState: (scope) => scopes[scope],
    archive: async (scope, id, hours) => {
      archived.push([scope, id, hours]);
      return archive(scope, id);
    },
    isClosing: closing,
    now: () => NOW,
  });
  return { sweep, archived };
}

const state = (...sessions) => ({ sessions: Object.fromEntries(sessions.map((session) => [session.id, session])) });

test("the sweep archives only Done Chats past their retention, in every scope", async () => {
  const { sweep, archived } = sweepOf({
    scopes: {
      "/a": state({ id: 1, done_at: NOW - 25 * HOUR }, { id: 2, done_at: NOW - HOUR }, { id: 3 }, { id: 4, done_at: NOW - 30 * HOUR, archived: true }),
      "/b": state({ id: 7, done_at: NOW - 24 * HOUR }),
      "/closed": undefined,
    },
  });
  assert.deepEqual(await sweep.sweep(), ["/a#1", "/b#7"]);
  assert.deepEqual(archived, [
    ["/a", 1, 24],
    ["/b", 7, 24],
  ]);
});

test("Never archives nothing, and a Chat the archive found reopened is not counted", async () => {
  const scopes = { "/a": state({ id: 1, done_at: 1 }) };
  assert.deepEqual(await sweepOf({ retentionHours: 0, scopes }).sweep.sweep(), []);
  assert.deepEqual(await sweepOf({ scopes, archive: async () => false }).sweep.sweep(), []);
});

test("a failed archive leaves the rest of the sweep going, and closing stops it", async () => {
  const scopes = { "/a": state({ id: 1, done_at: 1 }, { id: 2, done_at: 1 }) };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const failing = sweepOf({ scopes, archive: async (_scope, id) => (id === 1 ? Promise.reject(new Error("busy")) : true) });
    assert.deepEqual(await failing.sweep.sweep(), ["/a#2"]);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(await sweepOf({ scopes, closing: () => true }).sweep.sweep(), []);
});

test("a sweep under way is not started again under itself", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { sweep, archived } = sweepOf({ scopes: { "/a": state({ id: 1, done_at: 1 }) }, archive: () => gate.then(() => true) });
  const first = sweep.sweep();
  const second = sweep.sweep();
  assert.equal(first, second);
  release();
  await first;
  assert.equal(archived.length, 1);
});
