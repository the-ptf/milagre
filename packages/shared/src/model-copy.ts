import type { PermissionMode, EffortLevel } from "./model.ts";

export const PERMISSION_MODES: Array<{ id: PermissionMode; name: string; description: string }> = [
  { id: "ask", name: "Ask approval", description: "Approve edits and commands as the agent asks" },
  { id: "auto", name: "Auto mode", description: "Allow changes inside this worktree" },
  { id: "full", name: "Full permission", description: "Remove filesystem and network limits" },
];

/** The composer chip's word for each mode. Bot rules is only ever set by a bot, so the picker above never offers it. */
export const PERMISSION_MODE_LABEL: Record<PermissionMode, string> = { ask: "Ask", auto: "Auto", full: "Full", bot: "Bot rules" };

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
