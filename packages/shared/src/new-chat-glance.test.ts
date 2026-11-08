import assert from "node:assert/strict";
import test from "node:test";
import { glanceToday, hourShares, openPullRequestRows, pullRequestStatus, shortAge, todayKey } from "./new-chat-glance.ts";
import type { PullRequest } from "./model.ts";
import type { TokenUsageReport, TokenUsageTotals } from "./token-usage.ts";

const pr = (number: number, extra: Partial<PullRequest> = {}): PullRequest => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  state: "OPEN",
  readyToMerge: false,
  hasConflicts: false,
  ...extra,
});

test("open PR rows: open only, once each, with their age", () => {
  const now = Date.parse("2026-11-08T12:00:00Z");
  const rows = openPullRequestRows(
    [
      { ...pr(930), updatedAt: "2026-11-07T11:00:00Z" },
      pr(741, { state: "MERGED" }),
      { ...pr(896, { checks: "running" }), updatedAt: "2026-11-08T11:20:00Z" },
      pr(930),
    ],
    now,
  );
  assert.deepEqual(
    rows.map((row) => [row.number, row.age, row.status]),
    [
      [930, "1d", "checks passing"],
      [896, "40m", "CI running"],
    ],
  );
  assert.equal(openPullRequestRows(null).length, 0);
});

test("short age", () => {
  const now = Date.parse("2026-11-08T12:00:00Z");
  assert.equal(shortAge("2026-11-08T11:59:40Z", now), "now");
  assert.equal(shortAge("2026-11-08T09:00:00Z", now), "3h");
  assert.equal(shortAge("2026-10-01T12:00:00Z", now), "5w");
  assert.equal(shortAge(undefined, now), "");
});

test("PR status names the worst thing first", () => {
  assert.deepEqual(pullRequestStatus(pr(1, { isDraft: true, checks: "failed" })), { status: "draft", tone: "muted" });
  assert.deepEqual(pullRequestStatus(pr(1, { hasConflicts: true, checks: "running" })), { status: "conflicts", tone: "red" });
  assert.deepEqual(pullRequestStatus(pr(1, { checks: "failed" })), { status: "CI failed", tone: "red" });
  assert.deepEqual(pullRequestStatus(pr(1, { checks: "running" })), { status: "CI running", tone: "orange" });
  assert.deepEqual(pullRequestStatus(pr(1, { readyToMerge: true })), { status: "ready to merge", tone: "purple" });
  assert.deepEqual(pullRequestStatus(pr(1)), { status: "checks passing", tone: "green" });
});

test("today key is the local calendar day", () => {
  assert.equal(todayKey(new Date(2026, 10, 8, 23, 59)), "2026-11-08");
  assert.equal(todayKey(new Date(2026, 0, 3, 0, 1)), "2026-01-03");
});

const totals = (costUsd: number, tokens: number): TokenUsageTotals => ({
  input: tokens,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  requests: 1,
  costUsd,
  cost: { input: costUsd, cacheRead: 0, cacheWrite: 0, output: 0 },
  cacheSavingsUsd: 0,
  unpricedTokens: 0,
});

test("today: totals, Milagre Chats and cost per hour", () => {
  const day = new Date(2026, 10, 8);
  const at = (hour: number) => new Date(2026, 10, 8, hour).getTime();
  const report = {
    totals: totals(3, 3000),
    series: [
      { start: at(9), key: "", providers: { claude: { tokens: 1000, costUsd: 1 }, codex: { tokens: 500, costUsd: 0.5 } } },
      { start: at(14), key: "", providers: { claude: { tokens: 1500, costUsd: 1.5 } } },
    ],
    projects: [
      { milagre: true, count: 3 },
      { milagre: true, count: 2 },
      { milagre: false, count: 7 },
    ],
  } as unknown as TokenUsageReport;
  const today = glanceToday(report, new Date(day.getTime() + 15 * 3600_000))!;
  assert.equal(today.costUsd, 3);
  assert.equal(today.tokens, 3000);
  assert.equal(today.chats, 5);
  assert.equal(today.hours[9], 1.5);
  assert.equal(today.hours[14], 1.5);
  assert.equal(today.currentHour, 15);
  assert.equal(glanceToday(null), null);
});

test("hour shares scale to the busiest hour", () => {
  assert.deepEqual(hourShares([0, 2, 4]), [0, 0.5, 1]);
  assert.deepEqual(hourShares([0, 0]), [0, 0]);
});
