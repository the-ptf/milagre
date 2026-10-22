// Source branch sync copy, shared by desktop and phone (see docs/superpowers/specs/2026-10-08-main-branch-sync-design.md).

export type MainSyncOutcome = "updated" | "up-to-date" | "skipped" | "failed";
export type MainSyncResult = { at: number; outcome: MainSyncOutcome; branch: string; commit?: string; message?: string };
export type MainSyncSettings = { branch: string; override: boolean | null; defaultValue: boolean; enabled: boolean; last: MainSyncResult | null };
export type MainSyncStatus = { projectPath: string; last: MainSyncResult };
export type MainSyncChoice = "default" | "on" | "off";

export const MAIN_SYNC_TITLE = "Sync source branch before new Worktrees";
export const MAIN_SYNC_HINT = "Fast-forwards the source branch from its remote. Skipped when it has local changes or commits.";

export function choiceOf(override: boolean | null): MainSyncChoice {
  return override === null ? "default" : override ? "on" : "off";
}

export function overrideOf(choice: MainSyncChoice): boolean | null {
  return choice === "default" ? null : choice === "on";
}

export function mainSyncChoices(defaultValue: boolean): { value: MainSyncChoice; title: string }[] {
  return [
    { value: "default", title: `Default (${defaultValue ? "On" : "Off"})` },
    { value: "on", title: "On" },
    { value: "off", title: "Off" },
  ];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago" or "2 d ago". */
export function ago(at: number, now: number): string {
  const elapsed = now - at;
  // NaN and negative (clock skew) both land here.
  if (!(elapsed >= MINUTE)) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  return `${Math.floor(elapsed / DAY)} d ago`;
}

export function mainSyncStatusLine(last: MainSyncResult | null, now: number): string {
  if (!last) return "Not synced yet";
  const when = ago(last.at, now);
  if (last.outcome === "updated") return `Synced ${last.branch} ${when}${last.commit ? ` (${last.commit})` : ""}`;
  if (last.outcome === "up-to-date") return `${last.branch} was up to date ${when}`;
  if (last.outcome === "skipped") return `Skipped ${when}: ${last.message ?? "nothing to do"}`;
  return `Couldn't sync ${when}: ${last.message ?? "unknown error"}`;
}
