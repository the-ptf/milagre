export type ChatRowField = "computer" | "pullRequests" | "linearIssue" | "branch" | "diff" | "lastActivity";
export type ChatRowShow = Record<ChatRowField, boolean>;

export const CHAT_ROW_FIELDS: { id: ChatRowField; label: string }[] = [
  { id: "computer", label: "Computer" },
  { id: "pullRequests", label: "Pull requests" },
  { id: "linearIssue", label: "Linear issue" },
  { id: "branch", label: "Branch" },
  { id: "diff", label: "Diff stats" },
  { id: "lastActivity", label: "Last activity" },
];

export const DESKTOP_CHAT_ROW_SHOW: ChatRowShow = { computer: true, pullRequests: true, linearIssue: true, branch: false, diff: false, lastActivity: false };
export const PHONE_CHAT_ROW_SHOW: ChatRowShow = { ...DESKTOP_CHAT_ROW_SHOW, branch: true };

export function parseChatRowShow(value: unknown, fallback: ChatRowShow): ChatRowShow {
  const saved = value && typeof value === "object" ? (value as Partial<Record<ChatRowField, unknown>>) : {};
  const show = { ...fallback };
  for (const { id } of CHAT_ROW_FIELDS) if (typeof saved[id] === "boolean") show[id] = saved[id];
  return show;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A row's last activity, short: "now", "5m", "3h", "2d", "6w". */
export function activityAgo(at: number, now: number): string {
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d`;
  return `${Math.floor(elapsed / (7 * DAY))}w`;
}
