import type { PullRequest } from "./model.ts";
import { tokenTotal, type TokenUsageReport } from "./token-usage.ts";

export const NEW_CHAT_STATS_LABEL = "New Chat stats";
export const NEW_CHAT_STATS_HINT = "Open pull requests, plan usage and today's tokens on a new Chat.";

export const GLANCE_PR_LIMIT = 4;

export type GlancePrTone = "green" | "orange" | "red" | "purple" | "muted";

export interface GlancePullRequest {
  number: number;
  title: string;
  url: string;
  status: string;
  tone: GlancePrTone;
  draft: boolean;
  /** Since its last update: "2d". Empty when the host didn't say. */
  age: string;
}

export function pullRequestStatus(pr: PullRequest): { status: string; tone: GlancePrTone } {
  if (pr.isDraft) return { status: "draft", tone: "muted" };
  if (pr.hasConflicts) return { status: "conflicts", tone: "red" };
  if (pr.checks === "failed") return { status: "CI failed", tone: "red" };
  if (pr.changesRequested) return { status: "changes requested", tone: "orange" };
  if (pr.checks === "running") return { status: "CI running", tone: "orange" };
  if (pr.isBehind) return { status: "behind base", tone: "orange" };
  if (pr.readyToMerge) return { status: "ready to merge", tone: "purple" };
  return { status: "checks passing", tone: "green" };
}

export type OpenPullRequest = PullRequest & { updatedAt?: string };

export function shortAge(iso: string | undefined, now: number = Date.now()): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(at)) return "";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 14 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

export function openPullRequestRows(list: OpenPullRequest[] | null | undefined, now: number = Date.now()): GlancePullRequest[] {
  const seen = new Set<string>();
  return (list ?? []).flatMap((pr) => {
    if (pr.state !== "OPEN" || seen.has(pr.url)) return [];
    seen.add(pr.url);
    return [{ number: pr.number, title: pr.title, url: pr.url, draft: Boolean(pr.isDraft), age: shortAge(pr.updatedAt, now), ...pullRequestStatus(pr) }];
  });
}

/** Today in the device's time zone, as the token usage report names days ("2026-11-08"). */
export function todayKey(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface GlanceToday {
  costUsd: number;
  tokens: number;
  chats: number;
  /** Cost per hour of the day, 0 to 23 (tokens where nothing is priced). */
  hours: number[];
  currentHour: number;
}

export function glanceToday(report: TokenUsageReport | null | undefined, now: Date = new Date()): GlanceToday | null {
  if (!report) return null;
  const priced = report.totals.costUsd > 0;
  const hours = Array.from({ length: 24 }, () => 0);
  for (const bucket of report.series) {
    const hour = new Date(bucket.start).getHours();
    for (const split of Object.values(bucket.providers)) if (split) hours[hour] = (hours[hour] ?? 0) + (priced ? split.costUsd : split.tokens);
  }
  const chats = report.projects.filter((project) => project.milagre).reduce((sum, project) => sum + project.count, 0);
  return { costUsd: report.totals.costUsd, tokens: tokenTotal(report.totals), chats, hours, currentHour: now.getHours() };
}

/** Each hour's bar height as a share of the busiest hour, 0 to 1. */
export function hourShares(hours: number[]): number[] {
  const peak = Math.max(0, ...hours);
  return hours.map((value) => (peak > 0 ? value / peak : 0));
}
