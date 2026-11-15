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
  if (!(elapsed >= MINUTE)) return "Updated just now";
  if (elapsed < HOUR) return `Updated ${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `Updated ${Math.floor(elapsed / HOUR)}h ago`;
  return `Updated ${Math.floor(elapsed / DAY)}d ago`;
}

export function formatResetsAt(resetsAt: string | null, now: number): string | null {
  if (!resetsAt || !Number.isFinite(Date.parse(resetsAt))) return null;
  if (Date.parse(resetsAt) - now < DAY) return formatResetsIn(resetsAt, now);
  return `Resets ${new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(resetsAt))}`;
}

export function overviewUpdatedAt(snapshot: UsageSnapshot | null): string | null {
  const times =
    snapshot?.providers
      .filter((item) => item.windows.length > 0)
      .map((item) => Date.parse(item.updatedAt))
      .filter(Number.isFinite) ?? [];
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

export type UsageInSidebar = "button" | "meters" | "off";

export type SidebarUsagePick = UsageInSidebar | "compact";

export const SIDEBAR_USAGE_PICKS: readonly { id: SidebarUsagePick; label: string; hint: string }[] = [
  { id: "button", label: "Button", hint: "A button beside Filters shows every provider's limits" },
  { id: "meters", label: "Meters", hint: "A meter per provider; hover one for its limits and reset times" },
  { id: "compact", label: "Compact meters", hint: "Provider icons in one line; hover one for its limits" },
  { id: "off", label: "Off", hint: "Plan usage stays in Settings › Usage" },
];

export function sidebarUsagePick(usageInSidebar: UsageInSidebar, sidebarUsage: "expanded" | "compact"): SidebarUsagePick {
  return usageInSidebar === "meters" && sidebarUsage === "compact" ? "compact" : usageInSidebar;
}

export function sidebarUsagePickSettings(pick: SidebarUsagePick): { usageInSidebar: UsageInSidebar; sidebarUsage?: "expanded" | "compact" } {
  if (pick === "compact") return { usageInSidebar: "meters", sidebarUsage: "compact" };
  if (pick === "meters") return { usageInSidebar: "meters", sidebarUsage: "expanded" };
  return { usageInSidebar: pick };
}

export const USAGE_BUTTON_LABEL = "Plan usage";

/** Nothing saved means the button. */
export function parseUsageInSidebar(value: unknown, legacyShow?: unknown): UsageInSidebar {
  if (value === "button" || value === "meters" || value === "off") return value;
  if (legacyShow === true) return "meters";
  if (legacyShow === false) return "off";
  return "button";
}

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

export function seedSnapshot(current: UsageSnapshot | null, cached: UsageSnapshot): UsageSnapshot | null {
  if (current || cached.providers.length === 0) return current;
  return cached;
}

export function mergeSnapshot(previous: UsageSnapshot | null, next: UsageSnapshot, now: number): UsageSnapshot {
  if (previous?.accountKey !== next.accountKey) previous = null;
  return {
    ...(next.accountKey ? { accountKey: next.accountKey } : {}),
    ...(next.generatedAt ? { generatedAt: next.generatedAt } : {}),
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

export function accountUsageGroups(snapshot: UsageSnapshot | null) {
  return PROVIDERS.map((provider) => ({ provider, accounts: snapshot?.providers.filter((item) => item.provider === provider) ?? [] })).filter(
    (group) => group.accounts.length > 0,
  );
}

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

export const CONTEXT_WARN_PERCENT = 75;
export const CONTEXT_CRITICAL_PERCENT = 90;

export function contextTone(percent: number): "normal" | "warning" | "critical" {
  if (percent >= CONTEXT_CRITICAL_PERCENT) return "critical";
  if (percent >= CONTEXT_WARN_PERCENT) return "warning";
  return "normal";
}

export function contextHint(percent: number): string | null {
  return percent >= CONTEXT_WARN_PERCENT ? `Context above ${CONTEXT_WARN_PERCENT}% may reduce response quality and slow replies.` : null;
}
