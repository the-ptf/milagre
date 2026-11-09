import { providerName } from "./providers.mjs";
import type { Subagent } from "./model.ts";

/** Compact action labels shared by the canvas and mobile's subagent rows.
 * Match action prefixes rather than words in file paths or tool output.
 */
export function agentActivityLabel(activity = ""): string {
  const text = activity.trim();
  if (/^(?:running|ran|run|testing|test)\b.*\b(?:tests?|pytest|vitest|jest|playwright)\b/i.test(text) || /^testing\b/i.test(text)) return "Running tests";
  if (/^(?:used|using)\b/i.test(text)) return "Using tools";
  if (/^compacting\b/i.test(text)) return "Compacting context";
  if (/^generating\b/i.test(text)) return "Generating images";
  if (/^(?:updated|updating) the to-do list/i.test(text)) return "Planning";
  if (/^(?:ran|started) an agent\b/i.test(text)) return "Coordinating";
  if (/^(?:reading|read|opened?|opening|viewing|viewed|view)\b/i.test(text)) return "Reading files";
  if (/^(?:editing|edited|edit|writing|wrote|write|creating|created|create|patching|patched|apply_patch)\b/i.test(text)) return "Editing files";
  if (/^(?:searching|searched|search|finding|find|found|listed|listing|grep|glob)\b/i.test(text)) return "Searching";
  if (/^(?:reviewing|review|checking|checked|check|inspecting|inspect)\b/i.test(text)) return "Reviewing";
  if (/^(?:building|build|built)\b/i.test(text)) return "Building";
  if (/^(?:running|ran|run|executing|exec_command|bash|shell)\b/i.test(text)) return "Running commands";
  if (/^(?:responding|replying|answered|answering)\b/i.test(text)) return "Responding";
  if (/^(?:planning|plan)\b/i.test(text)) return "Planning";
  if (/^(?:waiting|wait)\b/i.test(text)) return "Waiting";
  if (/^(?:sending|sent|messaging|delegating|spawning)\b/i.test(text)) return "Coordinating";
  if (/^(?:browsing|fetching|fetched|fetch|web)\b/i.test(text)) return "Browsing";
  return "Thinking";
}

export function subagentActivityLabel(agent: Pick<Subagent, "status" | "latestActivity">): string {
  if (agent.status === "running") return agentActivityLabel(agent.latestActivity);
  return {
    initializing: "Waking up",
    waiting: "Waiting",
    completed: "Done",
    failed: "Needs attention",
    cancelled: "Stopped",
    unknown: "Status unavailable",
  }[agent.status];
}

/** Host-owned advisors have controls independent of their parent's provider-native children. */
export function advisorAction(agent: Pick<Subagent, "status" | "source" | "retryable">): "stop" | "retry" | null {
  if (agent.source !== "milagre-advisor") return null;
  if (["initializing", "running", "waiting"].includes(agent.status)) return "stop";
  return agent.retryable ? "retry" : null;
}
export function subagentRoleLabel(agent: Pick<Subagent, "source" | "provider" | "mode">): string | undefined {
  return agent.source === "milagre-advisor"
    ? `${providerName(agent.provider ?? "claude")} ${agent.mode === "execution" ? "execution agent" : "advisor"}`
    : undefined;
}
