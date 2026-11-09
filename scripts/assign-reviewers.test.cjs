const test = require("node:test");
const assert = require("node:assert/strict");
const { pickReviewers } = require("./assign-reviewers.cjs");

test("Victor's PR gets the two teammates asked least recently", () => {
  const lastRequested = {
    marcosgenesis: "2026-10-15T10:00:00Z",
    jefo3: "2026-10-15T10:00:00Z",
    micaelomota: "2026-10-14T10:00:00Z",
    ericrodriguesfer: "2026-10-14T12:00:00Z",
    victorsaisse: "2026-10-14T12:00:00Z",
  };
  assert.deepEqual(pickReviewers({ author: "victorlucss", present: [], lastRequested }), ["micaelomota", "ericrodriguesfer"]);
});

test("someone else's PR gets Victor plus one teammate, never the author", () => {
  const lastRequested = { marcosgenesis: "2026-10-15T10:00:00Z" };
  assert.deepEqual(pickReviewers({ author: "jefo3", present: [], lastRequested }), ["victorlucss", "micaelomota"]);
});

test("never-asked teammates go first, in rotation order", () => {
  assert.deepEqual(pickReviewers({ author: "victorlucss", present: [], lastRequested: {} }), ["marcosgenesis", "jefo3"]);
});

test("reviewers already on the PR count toward the two", () => {
  assert.deepEqual(pickReviewers({ author: "victorlucss", present: ["jefo3", "micaelomota"], lastRequested: {} }), []);
  assert.deepEqual(pickReviewers({ author: "jefo3", present: ["micaelomota"], lastRequested: {} }), ["victorlucss"]);
  assert.deepEqual(pickReviewers({ author: "jefo3", present: ["victorlucss"], lastRequested: {} }), ["marcosgenesis"]);
});

test("Victor is added even when two teammates were requested by hand", () => {
  assert.deepEqual(pickReviewers({ author: "jefo3", present: ["micaelomota", "marcosgenesis"], lastRequested: {} }), ["victorlucss"]);
});
