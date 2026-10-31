// The token usage page (desktop Usage page, phone Settings › Token usage): what the host's token-usage:read returns,
// read from the Claude Code and Codex transcripts on that computer (packages/core/src/token-usage.cjs).
import type { ModelProvider } from "./model.ts";

export type TokenUsageRange = "24h" | "7d" | "30d" | "90d";
export const TOKEN_USAGE_RANGES: { value: TokenUsageRange; label: string; short: string }[] = [
  { value: "24h", label: "Past 24 hours", short: "24h" },
  { value: "7d", label: "Past 7 days", short: "7d" },
  { value: "30d", label: "Past 30 days", short: "30d" },
  { value: "90d", label: "Past 90 days", short: "90d" },
];

export type TokenUsageMetric = "cost" | "tokens";

export interface TokenUsageRequest {
  range: TokenUsageRange;
  /** IANA time zone the days are cut in; the host's own when absent or unknown. */
  timeZone?: string;
  /** Days picked on the calendar ("2026-10-16"), both included; they replace `range`. One day reads by the hour. */
  days?: TokenUsageDays;
}

export interface TokenUsageDays {
  from: string;
  to: string;
}

/** Tokens and cost per provider. */
export type TokenUsageSplit = Partial<Record<ModelProvider, { tokens: number; costUsd: number }>>;

/** Token categories as prices split them. Input is uncached input; reasoning is part of output. */
export interface TokenCounts {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

export interface TokenUsageTotals extends TokenCounts {
  /** Model requests (one per API call the agent made). */
  requests: number;
  /** Estimated API-equivalent cost of the priced tokens, in USD. */
  costUsd: number;
  cost: { input: number; cacheRead: number; cacheWrite: number; output: number };
  /** What cache reads saved against paying full input price for them. */
  cacheSavingsUsd: number;
  /** Tokens of models without a known price; not in costUsd. */
  unpricedTokens: number;
}

export interface TokenUsageBucket {
  /** Start of the hour or local day (ms since epoch). */
  start: number;
  /** "2026-10-30" for a day, the hour's ISO time for an hour. */
  key: string;
  providers: TokenUsageSplit;
}

/** One day of the calendar. */
export interface TokenUsageDay {
  /** "2026-10-30", in the report's time zone. */
  key: string;
  start: number;
  tokens: number;
  costUsd: number;
}

export interface TokenUsageModel {
  provider: ModelProvider;
  model: string;
  priced: boolean;
  totals: TokenUsageTotals;
}

export interface TokenUsageChat {
  /** The Milagre Chat's id in its Project, for a `chat`. */
  sessionId?: number;
  /**
   * `chat`, a Chat in the Project now; `archived`, a session Milagre started that no Chat holds now (archived or
   * deleted), titled from its transcript or Worktree; `outside`, a session started outside Milagre in the Project's
   * folders; `folder`, under Outside Milagre, a folder no Project holds.
   */
  kind: "chat" | "archived" | "outside" | "folder";
  title: string;
  /** A folder's path (with ~), for a `folder`. */
  detail?: string;
  providers: ModelProvider[];
  totals: TokenUsageTotals;
  /** Last request in the range (ms). */
  lastAt: number;
}

export interface TokenUsageProject {
  /** The Project's folder; empty for Outside Milagre, whose rows are the folders no Project holds. */
  path: string;
  name: string;
  /** A Project registered in Milagre; false for Outside Milagre. */
  milagre: boolean;
  totals: TokenUsageTotals;
  providers: TokenUsageSplit;
  /** Chats and sessions (folders for Outside Milagre) in the period, the listed ones and the rest. */
  count: number;
  /** Highest cost first, at most TOKEN_USAGE_TOP_CHATS. */
  chats: TokenUsageChat[];
  /** The Chats and sessions past the top ones, together. */
  more?: { count: number; totals: TokenUsageTotals };
}

export interface TokenUsageReport {
  range: TokenUsageRange;
  /** The days picked on the calendar, when the report covers them instead of `range`. */
  days?: TokenUsageDays;
  timeZone: string;
  resolution: "hour" | "day";
  since: number;
  until: number;
  generatedAt: number;
  /** A scan of the transcripts is running; a token-usage:changed event follows when it ends. */
  refreshing: boolean;
  /** No scan has finished yet on this computer: the numbers are what was read so far. */
  firstScan: boolean;
  pricing: { status: "ok" | "stale" | "loading" | "unavailable"; fetchedAt?: string };
  totals: TokenUsageTotals;
  series: TokenUsageBucket[];
  /** The last 90 days, today last, whatever the period: the calendar. */
  calendar: TokenUsageDay[];
  providers: { provider: ModelProvider; totals: TokenUsageTotals }[];
  models: TokenUsageModel[];
  projects: TokenUsageProject[];
  /** Projects past the top ones, together. */
  moreProjects?: { count: number; totals: TokenUsageTotals };
}

export function tokenTotal(counts: TokenCounts) {
  return counts.input + counts.cacheRead + counts.cacheWrite + counts.output;
}

/** Cache reads as a share of all input the model read (uncached, cache reads and cache writes). */
export function cacheHitRate(counts: TokenCounts) {
  const read = counts.input + counts.cacheRead + counts.cacheWrite;
  return read > 0 ? counts.cacheRead / read : 0;
}

/** $1,234 · $56.70 · $0.42 · <$0.01 */
export function formatUsd(value: number) {
  if (value <= 0) return "$0";
  if (value < 0.01) return "<$0.01";
  if (value >= 1000) return `$${Math.round(value).toLocaleString("en-US")}`;
  if (value >= 100) return `$${value.toFixed(0)}`;
  return `$${value.toFixed(2)}`;
}

/** Token counts large enough for a page of totals: 980, 12.4k, 3.1M, 27.9B. */
export function formatTokenCount(tokens: number) {
  const abs = Math.abs(tokens);
  if (abs < 1000) return String(Math.round(tokens));
  const units: [number, string][] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [size, unit] of units) {
    if (abs >= size) {
      const value = tokens / size;
      return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10}${unit}`;
    }
  }
  return String(tokens);
}

export function formatShare(part: number, whole: number) {
  if (whole <= 0 || part <= 0) return "0%";
  const share = (part / whole) * 100;
  return share < 1 ? "<1%" : `${Math.round(share)}%`;
}

export const TOKEN_CATEGORIES: { key: keyof TokenUsageTotals["cost"]; label: string }[] = [
  { key: "input", label: "Input" },
  { key: "cacheRead", label: "Cache read" },
  { key: "cacheWrite", label: "Cache write" },
  { key: "output", label: "Output" },
];

export function formatMetric(metric: TokenUsageMetric, value: number) {
  return metric === "cost" ? formatUsd(value) : formatTokenCount(value);
}

/**
 * Mark colors per provider: Claude orange and Codex blue, stepped to pass the categorical checks (lightness band,
 * colorblind separation, 3:1 on the surface) in light and dark themes alike. Text never wears them.
 */
export const TOKEN_USAGE_PROVIDER_COLORS: Partial<Record<ModelProvider, string>> = { claude: "#D4704F", codex: "#6A86FF" };

/** The order series stack and legends list: fixed, so a filter never repaints or reorders them. */
export const TOKEN_USAGE_PROVIDERS: ModelProvider[] = ["claude", "codex"];

/** Token categories drawn as one ink ramp, lightest for cache reads: how much ink each one mixes in, in %. */
export const TOKEN_CATEGORY_INK: Record<keyof TokenUsageTotals["cost"], number> = { cacheRead: 22, cacheWrite: 45, input: 68, output: 90 };

/** The value of a metric for totals or a provider split's entry. */
export function metricOf(metric: TokenUsageMetric, totals: TokenUsageTotals) {
  return metric === "cost" ? totals.costUsd : tokenTotal(totals);
}

export function splitValue(metric: TokenUsageMetric, split: TokenUsageSplit, provider: ModelProvider) {
  const point = split[provider];
  return point ? (metric === "cost" ? point.costUsd : point.tokens) : 0;
}

/** A day key ("2026-10-16") as a date at noon UTC, so formatting it in any time zone keeps its day. */
const dayDate = (key: string) => new Date(`${key}T12:00:00Z`);
const dayLabel = (key: string, weekday = false) =>
  dayDate(key).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC", ...(weekday ? { weekday: "short" } : {}) });

/** What the report covers, in words: "Past 7 days", "Thu, Oct 16", "Oct 12 – Oct 18". */
export function periodLabel(report: Pick<TokenUsageReport, "range" | "days">) {
  if (report.days)
    return report.days.from === report.days.to ? dayLabel(report.days.from, true) : `${dayLabel(report.days.from)} – ${dayLabel(report.days.to)}`;
  return TOKEN_USAGE_RANGES.find((range) => range.value === report.range)?.label ?? "";
}

/** The calendar days the report covers, to draw at full strength. */
export function coveredDays(report: Pick<TokenUsageReport, "calendar" | "since" | "until">) {
  const covered = new Set<string>();
  report.calendar.forEach((day, index) => {
    const end = report.calendar[index + 1]?.start ?? Number.POSITIVE_INFINITY;
    if (day.start < report.until && end > report.since) covered.add(day.key);
  });
  return covered;
}

/**
 * The calendar as week columns, Monday first: each column holds seven days or nulls before the first and after today.
 * `month` names the month a column starts, where it changes.
 */
export function calendarWeeks(calendar: TokenUsageDay[]) {
  const weeks: { month?: string; days: (TokenUsageDay | null)[] }[] = [];
  if (!calendar.length) return weeks;
  const weekday = (day: TokenUsageDay) => (dayDate(day.key).getUTCDay() + 6) % 7;
  let week: (TokenUsageDay | null)[] = Array.from({ length: weekday(calendar[0]!) }, () => null);
  const flush = () => {
    const first = week.find(Boolean);
    const previous = weeks.at(-1)?.days.find(Boolean);
    const month =
      first && (!previous || first.key.slice(0, 7) !== previous.key.slice(0, 7))
        ? dayDate(first.key).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })
        : undefined;
    while (week.length < 7) week.push(null);
    weeks.push({ ...(month ? { month } : {}), days: week });
    week = [];
  };
  for (const day of calendar) {
    week.push(day);
    if (week.length === 7) flush();
  }
  if (week.length) flush();
  return weeks;
}

/** Each day's shade, 0 (nothing) to 5, from the fifths of the busy days, so one huge day doesn't wash out the rest. */
export function calendarLevels(calendar: TokenUsageDay[], metric: TokenUsageMetric) {
  const value = (day: TokenUsageDay) => (metric === "cost" ? day.costUsd : day.tokens);
  const busy = calendar.map(value).filter((v) => v > 0);
  // oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy; Hermes on older phone builds lacks toSorted
  busy.sort((a, b) => a - b);
  const cuts = [0.2, 0.4, 0.6, 0.8].map((q) => busy[Math.min(busy.length - 1, Math.floor(q * busy.length))] ?? 0);
  return new Map(
    calendar.map((day) => {
      const v = value(day);
      return [day.key, v <= 0 ? 0 : 1 + cuts.filter((cut) => v > cut).length];
    }),
  );
}

/** The calendar's headline: its total, active days and busiest day. */
export function calendarSummary(calendar: TokenUsageDay[], metric: TokenUsageMetric) {
  const value = (day: TokenUsageDay) => (metric === "cost" ? day.costUsd : day.tokens);
  let total = 0;
  let active = 0;
  let busiest: TokenUsageDay | null = null;
  for (const day of calendar) {
    total += value(day);
    if (value(day) > 0) active++;
    if (!busiest || value(day) > value(busiest)) busiest = day;
  }
  return { total, active, busiest: busiest && value(busiest) > 0 ? { label: dayLabel(busiest.key), value: value(busiest) } : null };
}

export function calendarDayLabel(day: TokenUsageDay) {
  return dayLabel(day.key, true);
}

/** A row's second line: "Archived · 4 d ago", "Outside Milagre · Today", "~/Code/tools". */
export function chatMeta(chat: TokenUsageChat, now: number) {
  if (chat.kind === "folder") return chat.detail ?? "";
  const elapsed = now - chat.lastAt;
  const when = elapsed < 24 * 3_600_000 ? "Today" : `${Math.floor(elapsed / (24 * 3_600_000))} d ago`;
  if (chat.kind === "archived") return `Archived · ${when}`;
  if (chat.kind === "outside") return `Outside Milagre · ${when}`;
  return when;
}
