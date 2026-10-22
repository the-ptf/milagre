import { providerName } from "./providers.mjs";
import type { AdvisorResultContext } from "./model.ts";
export function advisorResultLabel(context: AdvisorResultContext): string {
  const outcome = context.outcome === "completed" ? "result" : context.outcome === "failed" ? "failed" : "stopped";
  return `${advisorResultRole(context)} ${outcome}: ${context.title}`;
}
export function advisorResultRole(context: Pick<AdvisorResultContext, "provider" | "mode">): string {
  return `${providerName(context.provider)} ${context.mode === "execution" ? "execution agent" : "advisor"}`;
}

/** Provider input roles remain user/assistant; clients identify host context as app-owned. */
export function messageSender(message: Pick<import("./model.ts").ChatMessage, "role" | "context">): "app" | "user" | "assistant" {
  return typeof message.context === "object" && message.context?.kind === "advisor-result" ? "app" : (message.role ?? "assistant");
}
