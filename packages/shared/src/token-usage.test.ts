import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarLevels,
  calendarSummary,
  calendarWeeks,
  chatMeta,
  coveredDays,
  formatTokenCount,
  formatUsd,
  periodLabel,
  type TokenUsageChat,
  type TokenUsageDay,
  type TokenUsageTotals,
} from "./token-usage.ts";

const DAY = 86_400_000;
const days = (from: string, costs: number[]): TokenUsageDay[] =>
  costs.map((costUsd, index) => {
    const start = Date.parse(`${from}T00:00:00Z`) + index * DAY;
    return { key: new Date(start).toISOString().slice(0, 10), start, costUsd, tokens: costUsd * 1000 };
  });

test("the calendar starts its weeks on Monday and names a month where a column starts it", () => {
  // 2026-10-30 is a Friday; ten days back is Wednesday 2026-10-21.
  const weeks = calendarWeeks(
    days(
      "2026-10-21",
      Array.from({ length: 10 }, () => 1),
    ),
  );
  assert.equal(weeks.length, 2);
  assert.deepEqual(
    weeks[0]!.days.map((day) => day?.key ?? null),
    [null, null, "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"],
  );
  assert.deepEqual(
    weeks[1]!.days.map((day) => day?.key ?? null),
    ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", null, null],
  );
  assert.equal(weeks[0]!.month, "Oct");
  assert.equal(weeks[1]!.month, undefined);
});

test("shades come from the fifths of the busy days, so one huge day doesn't wash the rest out", () => {
  const calendar = days("2026-10-01", [0, 10, 20, 30, 40, 50, 5000]);
  const levels = calendarLevels(calendar, "cost");
  assert.deepEqual([...levels.values()], [0, 1, 1, 2, 3, 4, 5]);
  assert.deepEqual(calendarSummary(calendar, "cost"), { total: 5150, active: 6, busiest: { label: "Oct 7", value: 5000 } });
});

test("the days a report covers, and its period in words", () => {
  const calendar = days("2026-10-28", [1, 1, 1]);
  const since = Date.parse("2026-10-29T12:00:00Z");
  assert.deepEqual([...coveredDays({ calendar, since, until: since + DAY })], ["2026-10-29", "2026-10-30"]);
  assert.equal(periodLabel({ range: "7d" }), "Past 7 days");
  assert.equal(periodLabel({ range: "7d", days: { from: "2026-10-16", to: "2026-10-16" } }), "Fri, Oct 16");
  assert.equal(periodLabel({ range: "7d", days: { from: "2026-10-12", to: "2026-10-18" } }), "Oct 12 – Oct 18");
});

test("a row's second line says what kind of session it is and when it last ran", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const chat = (patch: Partial<TokenUsageChat>): TokenUsageChat => ({
    kind: "chat",
    title: "",
    providers: [],
    totals: {} as TokenUsageTotals,
    lastAt: now - DAY * 4.5,
    ...patch,
  });
  assert.equal(chatMeta(chat({}), now), "4 d ago");
  assert.equal(chatMeta(chat({ kind: "archived", lastAt: now - 1000 }), now), "Archived · Today");
  assert.equal(chatMeta(chat({ kind: "outside" }), now), "Outside Milagre · 4 d ago");
  assert.equal(chatMeta(chat({ kind: "folder", detail: "~/Code/tools" }), now), "~/Code/tools");
});

test("numbers read at a glance", () => {
  assert.deepEqual([980, 12_400, 3_120_000, 27_900_000_000].map(formatTokenCount), ["980", "12.4k", "3.1M", "27.9B"]);
  assert.deepEqual([0, 0.004, 0.42, 56.7, 312.4, 12_478.2].map(formatUsd), ["$0", "<$0.01", "$0.42", "$56.70", "$312", "$12,478"]);
});
