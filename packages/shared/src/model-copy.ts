import type { PermissionMode, EffortLevel, PersistenceFailure } from "./model.ts";

export const PERMISSION_MODES: Array<{ id: PermissionMode; name: string; description: string }> = [
  { id: "ask", name: "Ask approval", description: "Approve edits and commands as the agent asks" },
  { id: "auto", name: "Auto mode", description: "Allow changes inside this Worktree" },
  { id: "full", name: "Full permission", description: "Remove filesystem and network limits" },
];

/** The composer chip's word for each mode. Bot rules is only ever set by a bot, so the picker above never offers it. */
export const PERMISSION_MODE_LABEL: Record<PermissionMode, string> = { ask: "Ask", auto: "Auto", full: "Full", bot: "Bot rules" };
/**
 * How a permission mode looks on both apps. `icon`: shield (Shield01Icon), security-check (SecurityCheckIcon) or
 * shield-alert (ShieldAlertIcon). `tone` colors the icon, `ink` the label, as palette keys. Full is the only orange
 * mode; nothing is green or accent.
 */
export function permissionPresentation(mode: PermissionMode) {
  if (mode === "full") return { icon: "shield-alert", tone: "orange", ink: "orangeInk" } as const;
  return { icon: mode === "auto" ? "security-check" : "shield", tone: "ink2", ink: "ink2" } as const;
}

/** Words both apps share. Product nouns (Project, Chat, Routine, Run, Link, Heartbeat, Worktree) are capitalised. */
export const UI_COPY = {
  /** The composer's send and stop buttons; `queue` while a turn runs. */
  send: "Send",
  sendFollowUp: "Send follow-up",
  queue: "Queue message",
  stop: "Stop agent",
  renameChat: "Rename Chat",
  newWorktree: "New Worktree",
  noChanges: "No changes yet",
  noProjects: "No Projects found",
  saving: "Saving…",
} as const;

export const SETUP_APPROVAL_COPY = { allow: "Run once", always: "Trust this version", deny: "Skip setup" } as const;

export const EFFORT_COPY: Record<string, { name: string; description: string }> = {
  minimal: { name: "Minimal", description: "Fastest replies with little reasoning" },
  low: { name: "Low", description: "Quick answers for small, clear tasks" },
  medium: { name: "Medium", description: "Balanced thinking for everyday work" },
  high: { name: "High", description: "Careful reasoning for harder changes" },
  xhigh: { name: "Extra high", description: "Deep reasoning for complex problems" },
  max: { name: "Max", description: "Thinks as long as it needs. Slowest" },
  ultra: { name: "Ultra", description: "Splits big work across parallel agents" },
};

export function effortCopy(level: EffortLevel) {
  return EFFORT_COPY[level] ?? { name: level, description: "" };
}

/** The recovery action is the same on desktop and phone; raw errors stay available for other save failures. */
export function persistenceFailureDetail(failure: PersistenceFailure) {
  if (failure.code === "ENOSPC") return "Disk is full. Free space on your computer, then retry.";
  if (failure.code === "EACCES" || failure.code === "EPERM" || /readonly|read-only/i.test(failure.error))
    return "Permission denied. Check that your computer can write to this Project.";
  return failure.error;
}
