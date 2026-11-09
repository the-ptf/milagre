import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderUsage, UsageSnapshot } from "../../model";
import {
  accountPickerLabel,
  accountUsageGroups,
  CONTEXT_CRITICAL_PERCENT,
  CONTEXT_WARN_PERCENT,
  contextSummary,
  contextTone,
  formatResetsIn,
  formatResetsAt,
  overviewUpdatedAt,
  formatTokens,
  formatUpdatedAgo,
  mergeSnapshot,
  seedSnapshot,
  shownPercent,
  usageLabel,
  usageTone,
  visibleProviders,
} from "./format.ts";

const NOW = Date.parse("2026-10-01T19:30:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

test("failed usage after an account switch never inherits another account's windows", () => {
  const previous = { accountKey: "personal", providers: [claude()] };
  const next = { accountKey: "work", providers: [claude({ status: "error", windows: [] })] };
  assert.deepEqual(mergeSnapshot(previous, next, NOW), next);
});

test("the overview groups by provider and keeps each failed Account's own limits", () => {
  const personal = claude({ account: { id: "personal", label: "Personal" } });
  const work = claude({
    account: { id: "work", label: "Work" },
    windows: [{ id: "daily", label: "Daily", shortLabel: "day", usedPercent: 12, resetsAt: null }],
  });
  const codex = { ...personal, provider: "codex" as const, account: { id: "default", label: "CLI" } };
  const previous = { accountKey: "all", providers: [personal, work, codex] };
  const merged = mergeSnapshot(previous, { accountKey: "all", providers: [codex, { ...work, status: "error", windows: [] }, personal] }, NOW);
  const groups = accountUsageGroups(merged);
  assert.deepEqual(
    groups.map((group) => [group.provider, group.accounts.map((account) => account.account?.id)]),
    [
      ["codex", ["default"]],
      ["claude", ["work", "personal"]],
    ],
  );
  assert.equal(groups[1].accounts[0].windows[0].usedPercent, 12);
  assert.equal(groups[1].accounts[1].windows[0].usedPercent, 73);
});

function claude(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    provider: "claude",
    status: "ok",
    updatedAt: at(0),
    windows: [
      { id: "session", label: "Session", shortLabel: "5h", usedPercent: 73, resetsAt: at(77 * MINUTE) },
      { id: "weekly", label: "Weekly", shortLabel: "wk", usedPercent: 61, resetsAt: at(5 * DAY) },
      { id: "weekly:fable", label: "Fable", shortLabel: "wk", usedPercent: 66, resetsAt: at(5 * DAY) },
    ],
    ...overrides,
  };
}

test("formats reset countdowns and never shows a negative one", () => {
  assert.equal(formatResetsIn(null, NOW), null);
  assert.equal(formatResetsIn("not a date", NOW), null);
  assert.equal(formatResetsIn(at(-1_000), NOW), "Resetting…");
  assert.equal(formatResetsIn(at(0), NOW), "Resetting…");
  assert.equal(formatResetsIn(at(30_000), NOW), "Resets in 1m");
  assert.equal(formatResetsIn(at(45 * MINUTE), NOW), "Resets in 45m");
  assert.equal(formatResetsIn(at(77 * MINUTE), NOW), "Resets in 1h 17m");
  assert.equal(formatResetsIn(at(39 * HOUR + 59 * MINUTE), NOW), "Resets in 1d 15h");
  assert.equal(formatResetsIn(at(5 * DAY), NOW), "Resets in 5d 0h");
});

test("formats how long ago usage was read, tolerating clock skew", () => {
  assert.equal(formatUpdatedAgo(at(-10_000), NOW), "Updated just now");
  assert.equal(formatUpdatedAgo(at(MINUTE), NOW), "Updated just now");
  assert.equal(formatUpdatedAgo(at(-3 * MINUTE), NOW), "Updated 3m ago");
  assert.equal(formatUpdatedAgo(at(-2 * HOUR), NOW), "Updated 2h ago");
  assert.equal(formatUpdatedAgo(at(-3 * DAY), NOW), "Updated 3d ago");
});

test("picks a tone from the rounded percentage", () => {
  assert.equal(usageTone(79.4), "normal");
  assert.equal(usageTone(79.6), "warning");
  assert.equal(usageTone(94.4), "warning");
  assert.equal(usageTone(95), "critical");
  assert.equal(usageTone(100), "critical");
});

test("keeps the last good numbers when a refresh fails", () => {
  const previous: UsageSnapshot = { providers: [claude({ updatedAt: at(-6 * MINUTE) })] };
  const failed: UsageSnapshot = {
    providers: [claude({ status: "error", windows: [], message: "Claude is rate limiting usage checks. Try again in a minute." })],
  };

  const merged = mergeSnapshot(previous, failed, NOW);
  assert.deepEqual(merged.providers[0].windows, previous.providers[0].windows);
  assert.equal(merged.providers[0].updatedAt, at(-6 * MINUTE));
  assert.equal(merged.providers[0].status, "error");
  assert.equal(merged.providers[0].message, "Claude is rate limiting usage checks. Try again in a minute.");

  const failedAgain = mergeSnapshot(merged, failed, NOW);
  assert.deepEqual(failedAgain.providers[0].windows, previous.providers[0].windows);
  assert.equal(failedAgain.providers[0].updatedAt, at(-6 * MINUTE));

  const recovered = mergeSnapshot(failedAgain, { providers: [claude()] }, NOW);
  assert.equal(recovered.providers[0].status, "ok");
  assert.equal(recovered.providers[0].message, undefined);
});

test("does not invent data for a first-time error or keep data for an unavailable provider", () => {
  const failed: UsageSnapshot = { providers: [claude({ status: "error", windows: [], message: "Couldn't reach Claude." })] };
  assert.deepEqual(mergeSnapshot(null, failed, NOW), failed);
  const gone: UsageSnapshot = { providers: [claude({ status: "unavailable", windows: [], message: "Not signed in to Claude Code." })] };
  assert.deepEqual(mergeSnapshot({ providers: [claude()] }, gone, NOW), gone);
});

test("hides unavailable providers and labels segments for screen readers", () => {
  const codexMissing: ProviderUsage = { provider: "codex", status: "unavailable", windows: [], updatedAt: at(0), message: "Codex CLI not found." };
  assert.deepEqual(
    visibleProviders({ providers: [claude(), codexMissing] }).map((item) => item.provider),
    ["claude"],
  );
  assert.equal(usageLabel(claude()), "Claude usage: Session 73% used, Weekly 61% used");
  assert.equal(usageLabel(claude({ status: "error", windows: [] })), "Claude usage unavailable");
  assert.equal(usageLabel(claude({ status: "error", message: "Couldn't reach Claude." })), "Claude usage, last known: Session 73% used, Weekly 61% used");
  assert.equal(usageLabel(claude(), "remaining"), "Claude usage: Session 27% left, Weekly 39% left");
});

test("the sidebar shows a provider only when it has numbers", () => {
  const codexMissing: ProviderUsage = { provider: "codex", status: "unavailable", windows: [], updatedAt: at(0), message: "Codex CLI not found." };
  const claudeErrored = claude({ status: "error", windows: [], message: "Couldn't reach Claude." });
  const claudeLastKnown = claude({ status: "error", message: "Couldn't reach Claude." });
  const codexOk: ProviderUsage = { provider: "codex", status: "ok", windows: claude().windows, updatedAt: at(0) };
  assert.deepEqual(
    visibleProviders({ providers: [claudeErrored, codexOk] }).map((item) => item.provider),
    ["codex"],
  );
  assert.deepEqual(
    visibleProviders({ providers: [claudeLastKnown, codexOk] }).map((item) => item.provider),
    ["claude", "codex"],
  );
  assert.deepEqual(visibleProviders({ providers: [claudeErrored, codexMissing] }), []);
  assert.deepEqual(visibleProviders({ providers: [claude({ status: "ok", windows: [] }), codexMissing] }), []);
});

test("numbers seeded from the saved cache count as numbers for the sidebar", () => {
  const cached: UsageSnapshot = { providers: [{ provider: "claude", status: "ok", windows: claude().windows, updatedAt: at(0) }] };
  const seeded = seedSnapshot(null, cached)!;
  assert.deepEqual(
    visibleProviders(seeded).map((item) => item.provider),
    ["claude"],
  );
  // A provider with nothing saved and nothing read yet stays hidden.
  assert.deepEqual(
    visibleProviders({ providers: [{ provider: "codex", status: "error", windows: [], updatedAt: at(0), message: "Couldn't read usage." }] }),
    [],
  );
});

test("shows used or remaining percent", () => {
  assert.equal(shownPercent(73, "used"), 73);
  assert.equal(shownPercent(73, "remaining"), 27);
  assert.equal(shownPercent(104, "remaining"), 0);
});

test("drops kept windows that have already reset", () => {
  const previous: UsageSnapshot = { providers: [claude({ updatedAt: at(-6 * HOUR) })] };
  const failed: UsageSnapshot = {
    providers: [claude({ status: "error", windows: [], message: "Claude sign-in expired. Running any Claude agent refreshes it." })],
  };
  const merged = mergeSnapshot(previous, failed, NOW + 2 * HOUR);
  assert.deepEqual(
    merged.providers[0].windows.map((item) => item.id),
    ["weekly", "weekly:fable"],
  );
  assert.equal(merged.providers[0].updatedAt, at(-6 * HOUR));
});

test("seedSnapshot fills an empty snapshot but never overwrites a fresh read", () => {
  const cached: UsageSnapshot = { providers: [claude()] };
  const fresh: UsageSnapshot = { providers: [claude({ windows: [] })] };
  assert.equal(seedSnapshot(null, cached), cached);
  assert.equal(seedSnapshot(fresh, cached), fresh);
  assert.equal(seedSnapshot(null, { providers: [] }), null);
});

test("token counts name a million-token window 1M, not 1000k", () => {
  assert.equal(formatTokens(1_000_000), "1M");
  assert.equal(formatTokens(999_600), "1M");
  assert.equal(formatTokens(1_500_000), "1.5M");
  assert.equal(formatTokens(366_400), "366k");
  assert.equal(formatTokens(258_400), "258k");
  assert.equal(formatTokens(400), "400");
  assert.deepEqual(contextSummary({ used: 366_000, size: 1_000_000 }), {
    ratio: 0.366,
    percent: 37,
    tokens: "366k of 1M tokens",
    left: "634k left",
  });
});

test("the context ring warns at 75% and turns critical at 90%", () => {
  assert.equal(CONTEXT_WARN_PERCENT, 75);
  assert.equal(CONTEXT_CRITICAL_PERCENT, 90);
  assert.equal(contextTone(74), "normal");
  assert.equal(contextTone(75), "warning");
  assert.equal(contextTone(89), "warning");
  assert.equal(contextTone(90), "critical");
});

test("the account picker names whose account it switches", () => {
  assert.equal(accountPickerLabel("claude"), "Claude account for this Project");
  assert.equal(accountPickerLabel("codex", true), "Codex account for Chats without a Project");
});

test("Plan usage reset captions switch to a local weekday at 24h and reject invalid dates", () => {
  assert.equal(formatResetsAt(null, NOW), null);
  assert.equal(formatResetsAt("invalid", NOW), null);
  assert.equal(formatResetsAt(at(-1), NOW), "Resetting…");
  assert.equal(formatResetsAt(at(59 * MINUTE), NOW), "Resets in 59m");
  assert.equal(formatResetsAt(at(DAY - MINUTE), NOW), "Resets in 23h 59m");
  const expected = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at(DAY)));
  assert.equal(formatResetsAt(at(DAY), NOW), `Resets ${expected}`);
});

test("overview freshness uses the oldest last-good window, ignoring empty or invalid reads", () => {
  assert.equal(overviewUpdatedAt(null), null);
  assert.equal(overviewUpdatedAt({ providers: [] }), null);
  assert.equal(
    overviewUpdatedAt({ providers: [claude({ updatedAt: at(-HOUR) }), claude({ updatedAt: at(0) }), claude({ windows: [], updatedAt: at(-DAY) })] }),
    at(-HOUR),
  );
});
