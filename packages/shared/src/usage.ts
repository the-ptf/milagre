import { PROVIDERS, providerName } from "@milagre/shared/providers";
import type { ModelProvider, ProviderUsage, UsageSnapshot } from "./model";
import { formatTokens } from "./tokens.mjs";
export type UsageDisplay = "used" | "remaining";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const PROVIDER_NAMES = Object.fromEntries(PROVIDERS.map((provider) => [provider, providerName(provider)])) as Record<ModelProvider, string>;

export type UsageTone = "normal" | "warning" | "critical";

export function usageTone(usedPercent: number): UsageTone {
  const rounded = Math.round(usedPercent);
  if (rounded >= 95) return "critical";
  if (rounded >= 80) return "warning";
  return "normal";
}

export function formatPercent(usedPercent: number) {
  return `${Math.round(usedPercent)}%`;
}

/** The percent to show: what's been used, or what's left of the window. */
export function shownPercent(usedPercent: number, display: UsageDisplay) {
  return display === "remaining" ? Math.max(0, 100 - usedPercent) : usedPercent;
}

export function shownSuffix(display: UsageDisplay) {
  return display === "remaining" ? "left" : "used";
}

export function formatResetsIn(resetsAt: string | null, now: number): string | null {
  if (!resetsAt) return null;
  const target = Date.parse(resetsAt);
  if (Number.isNaN(target)) return null;
  const remaining = target - now;
  if (remaining <= 0) return "Resetting…";
  if (remaining < HOUR) return `Resets in ${Math.max(1, Math.ceil(remaining / MINUTE))}m`;
  if (remaining < DAY) return `Resets in ${Math.floor(remaining / HOUR)}h ${Math.floor((remaining % HOUR) / MINUTE)}m`;
  return `Resets in ${Math.floor(remaining / DAY)}d ${Math.floor((remaining % DAY) / HOUR)}h`;
}

export function formatUpdatedAgo(updatedAt: string, now: number): string {
  const elapsed = now - Date.parse(updatedAt);
  // NaN and negative (clock skew) both land here.
  if (!(elapsed >= MINUTE)) return "Updated just now";
  if (elapsed < HOUR) return `Updated ${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `Updated ${Math.floor(elapsed / HOUR)}h ago`;
  return `Updated ${Math.floor(elapsed / DAY)}d ago`;
}

/** Short windows use a countdown; longer windows show the computer viewer's local reset time. */
export function formatResetsAt(resetsAt: string | null, now: number): string | null {
  if (!resetsAt || !Number.isFinite(Date.parse(resetsAt))) return null;
  if (Date.parse(resetsAt) - now < DAY) return formatResetsIn(resetsAt, now);
  return `Resets ${new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(resetsAt))}`;
}

/** Use the oldest last-good read so a fresh account never makes another account's stale data look current. */
export function overviewUpdatedAt(snapshot: UsageSnapshot | null): string | null {
  const times =
    snapshot?.providers
      .filter((item) => item.windows.length > 0)
      .map((item) => Date.parse(item.updatedAt))
      .filter(Number.isFinite) ?? [];
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

/** The providers the sidebar shows: those with numbers. One in error keeps showing its last-known windows. */
export function visibleProviders(snapshot: UsageSnapshot) {
  return snapshot.providers.filter((item) => item.status !== "unavailable" && item.windows.length > 0);
}

export function usageLabel(usage: ProviderUsage, display: UsageDisplay = "used") {
  const account = usage.account?.email || usage.account?.label;
  const name = `${PROVIDER_NAMES[usage.provider]}${account ? ` (${account})` : ""}`;
  if (usage.windows.length === 0) return `${name} usage unavailable`;
  const windows = usage.windows.slice(0, 2).map((item) => `${item.label} ${formatPercent(shownPercent(item.usedPercent, display))} ${shownSuffix(display)}`);
  return `${name} usage${usage.status === "error" ? ", last known" : ""}: ${windows.join(", ")}`;
}

// The saved numbers only seed an empty snapshot: a fresh read that landed first wins.
export function seedSnapshot(current: UsageSnapshot | null, cached: UsageSnapshot): UsageSnapshot | null {
  if (current || cached.providers.length === 0) return current;
  return cached;
}

// A failed refresh keeps the last good windows and their timestamp, so the card
// stays useful and "Updated Xm ago" stays truthful while showing the error.
// Windows that have reset since are dropped: their old numbers no longer apply.
export function mergeSnapshot(previous: UsageSnapshot | null, next: UsageSnapshot, now: number): UsageSnapshot {
  if (previous?.accountKey !== next.accountKey) previous = null;
  return {
    ...(next.accountKey ? { accountKey: next.accountKey } : {}),
    providers: next.providers.map((current) => {
      if (current.status !== "error") return current;
      const before = previous?.providers.find((item) => item.provider === current.provider && item.account?.id === current.account?.id);
      if (!before || before.windows.length === 0) return current;
      const windows = before.windows.filter((item) => !item.resetsAt || Date.parse(item.resetsAt) > now);
      const banked = before.bankedResets ? { bankedResets: before.bankedResets } : {};
      return { ...current, windows, updatedAt: before.updatedAt, ...banked };
    }),
  };
}

export { formatTokens };

/** All Accounts stay separate, including two providers' connected CLI accounts, both named `default`. */
export function accountUsageGroups(snapshot: UsageSnapshot | null) {
  return PROVIDERS.map((provider) => ({ provider, accounts: snapshot?.providers.filter((item) => item.provider === provider) ?? [] })).filter(
    (group) => group.accounts.length > 0,
  );
}

/** How full the agent's context window is: the percent used and the token counts behind it. */
export function contextSummary({ used, size }: { used: number; size: number }) {
  const ratio = size > 0 ? Math.min(1, Math.max(0, used / size)) : 0;
  const percent = Math.round(ratio * 100);
  return {
    ratio,
    percent,
    tokens: `${formatTokens(used)} of ${formatTokens(size)} tokens`,
    left: `${formatTokens(Math.max(0, size - used))} left`,
  };
}

/** From here the ring turns to the accent colour. */
export const CONTEXT_WARN_PERCENT = 75;
/** From here the ring turns red to indicate the window is nearly full. */
export const CONTEXT_CRITICAL_PERCENT = 90;

/** How the ring is drawn for a percent used: the colour step it has reached. */
export function contextTone(percent: number): "normal" | "warning" | "critical" {
  if (percent >= CONTEXT_CRITICAL_PERCENT) return "critical";
  if (percent >= CONTEXT_WARN_PERCENT) return "warning";
  return "normal";
}

/** Explain the warning threshold; the button supplies the action. */
export function contextHint(percent: number): string | null {
  return percent >= CONTEXT_WARN_PERCENT ? `Context above ${CONTEXT_WARN_PERCENT}% may reduce response quality and slow replies.` : null;
}
