const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { check, floors, loosened, LABEL } = require("./check-lighthouse-budget.cjs");

const budget = () => ({
  $comment: "notes are ignored",
  skipAudits: ["robots-txt"],
  mobile: { performance: 97, accessibility: 100 },
  desktop: { performance: 99, accessibility: 100 },
});

test("floors are every number in the budget, by path, without the $ notes", () => {
  assert.deepEqual(floors(budget()), { "mobile.performance": 97, "mobile.accessibility": 100, "desktop.performance": 99, "desktop.accessibility": 100 });
});

test("an unchanged or raised budget passes", () => {
  assert.deepEqual(loosened(budget(), budget()), []);
  const raised = budget();
  raised.mobile.performance = 99;
  raised.skipAudits = [];
  raised.$comment = "rewritten";
  assert.deepEqual(loosened(budget(), raised), []);
  assert.deepEqual(loosened(null, budget()), [], "a new budget has nothing to compare with");
});

test("a lowered or removed floor, a new skipped audit or a deleted budget fails", () => {
  const head = budget();
  head.mobile.performance = 95;
  delete head.desktop.accessibility;
  head.skipAudits.push("uses-long-cache-ttl");
  assert.deepEqual(loosened(budget(), head), [
    "mobile.performance went down from 97 to 95",
    "desktop.accessibility was removed (was 100)",
    'skipAudits gained "uses-long-cache-ttl"',
  ]);
  assert.deepEqual(loosened(budget(), null), ["apps/site/lighthouse-budget.json was removed"]);
});

test("the approval label lets a looser budget through", () => {
  const head = budget();
  head.desktop.performance = 98;
  const blocked = check({ base: budget(), head, labels: [] });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, new RegExp(LABEL));
  assert.match(blocked.message, /never go down/);
  assert.equal(check({ base: budget(), head, labels: [LABEL] }).ok, true);
});

test("the command line compares two files and exits 1 on a looser budget", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lighthouse-budget-"));
  const base = path.join(dir, "base.json");
  const head = path.join(dir, "head.json");
  fs.writeFileSync(base, JSON.stringify(budget()));
  const lowered = budget();
  lowered.mobile.accessibility = 90;
  fs.writeFileSync(head, JSON.stringify(lowered));
  const env = { ...process.env, GITHUB_ACTIONS: "", LABELS: "[]" };
  const run = (labels) =>
    spawnSync(process.execPath, [path.join(__dirname, "check-lighthouse-budget.cjs"), base, head], { env: { ...env, LABELS: labels }, encoding: "utf8" });
  assert.equal(run("[]").status, 1);
  assert.match(run("[]").stderr, /mobile\.accessibility went down from 100 to 90/);
  assert.equal(run(JSON.stringify([LABEL])).status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the real budget parses and has floors for both form factors", () => {
  const real = require("../apps/site/lighthouse-budget.json");
  const paths = Object.keys(floors(real));
  for (const formFactor of ["mobile", "desktop"]) assert.ok(paths.includes(`${formFactor}.performance`), formFactor);
});
