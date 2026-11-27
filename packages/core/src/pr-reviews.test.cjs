const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPrReviews } = require("./pr-reviews.cjs");
const { babysitReviewFindings } = require("./routines/review-findings.cjs");

const url = "https://github.com/acme/web/pull/12";
const report = (findings) => ({ url, summary: "Looked at it", findings });
const high = { path: "src/a.ts", line: 4, severity: "high", title: "Crash", body: "Throws", suggestion: "Guard it" };
const low = { path: "src/b.ts", severity: "low", title: "Nit" };

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-pr-reviews-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [];
  const file = path.join(dir, "pr-reviews.json");
  const make = () => createPrReviews({ file, emit: (name, value) => events.push([name, value]), now: () => 1000, ...options });
  return { make, events, file };
}

test("reports are refused while the review agent is off, and kept once it's on", async (t) => {
  const { make, events } = setup(t);
  const reviews = make();
  await assert.rejects(reviews.report(report([high])), /review agent is off/);
  reviews.saveSettings({ enabled: true });
  const answer = await reviews.report(report([low, high]), "/p#4");
  assert.deepEqual(answer, { url, findings: 2, open: 2, high: 1, medium: 0, low: 1, babysat: false });
  const saved = make().read(url);
  assert.equal(saved.chatId, "/p#4");
  assert.deepEqual(
    saved.findings.map((finding) => [finding.severity, finding.status]),
    [
      ["high", "open"],
      ["low", "open"],
    ],
  );
  assert.deepEqual(make().settings(), { enabled: true });
  assert.deepEqual(make().counts(), { [url]: { open: 2, high: 1, medium: 0, low: 1, reviewedAt: 1000 } });
  assert.deepEqual(
    events.map(([name]) => name),
    ["pr-reviews:settings", "pr-reviews:changed"],
  );
});

test("a new report keeps what the user did with the same finding", async (t) => {
  const reviews = setup(t).make();
  reviews.saveSettings({ enabled: true });
  await reviews.report(report([high, low]));
  const [first, second] = reviews.read(url).findings;
  reviews.setStatus({ url, ids: [second.id], status: "dismissed" });
  await reviews.report(report([high, low, { ...low, title: "Another" }]));
  const statuses = Object.fromEntries(reviews.read(url).findings.map((finding) => [finding.title, finding.status]));
  assert.deepEqual(statuses, { Crash: "open", Nit: "dismissed", Another: "open" });
  assert.equal(reviews.read(url).findings[0].id, first.id);
  assert.throws(() => reviews.setStatus({ url, ids: [first.id], status: "done" }), /status is/);
  assert.throws(() => reviews.setStatus({ url: `${url}9`, ids: [], status: "open" }), /no review/);
});

test("open high findings go to the PR's Babysit Heartbeat and are marked sent", async (t) => {
  const handed = [];
  const reviews = setup(t, {
    babysit: async (to, findings) => {
      handed.push([to, findings.map((finding) => finding.title)]);
      return true;
    },
  }).make();
  reviews.saveSettings({ enabled: true });
  const answer = await reviews.report(report([high, low]));
  assert.equal(answer.babysat, true);
  assert.deepEqual(handed, [[url, ["Crash"]]]);
  assert.deepEqual(
    reviews.read(url).findings.map((finding) => finding.status),
    ["sent", "open"],
  );
});

test("findings reach only a live Babysit Heartbeat on that PR, on its branch", () => {
  const routines = [
    { id: "done", enabled: true, completedAt: 5, trigger: { kind: "pull-request", url } },
    { id: "other", enabled: true, trigger: { kind: "pull-request", url: `${url}3` } },
    { id: "live", enabled: true, trigger: { kind: "pull-request", url } },
  ];
  const queued = [];
  const store = { list: () => routines, prSnapshot: (id) => (id === "live" ? { snapshot: { headRef: "fix/login" } } : null) };
  const scheduler = {
    enqueueEvents: (items) => {
      queued.push(...items);
      return items.map(() => ({ queued: true }));
    },
  };
  const findings = [{ id: "f1", path: "src/a.ts", line: 4, severity: "high", title: "Crash", body: "", suggestion: null, status: "open" }];
  assert.equal(babysitReviewFindings({ store, scheduler, now: () => 7 }, url, findings), true);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].routineId, "live");
  assert.deepEqual(queued[0].event, {
    kind: "pull-request",
    key: `review:${url}:7`,
    summary: "Review finding (high) at src/a.ts:4: Crash",
    changes: [{ id: "review:f1", text: "Review finding (high) at src/a.ts:4: Crash" }],
    branch: "fix/login",
  });
  assert.equal(babysitReviewFindings({ store: { list: () => [] }, scheduler, now: () => 7 }, url, findings), false);
});
