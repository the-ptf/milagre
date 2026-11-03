import { RESOLVED_STEP } from "@milagre/shared/artifact";
import type { Snapshot } from "./client";

/** Refresh comments during a turn and after short turns whose live steps the phone never received. */
export function commentActivity(snapshot: Snapshot | null, chatId: string | undefined, kind: "page" | "artifact"): string {
  if (!snapshot || !chatId) return "";
  const sessionId = chatId.slice(chatId.lastIndexOf("#") + 1);
  const lastReply = snapshot.project.state.sessions[sessionId]?.summary?.lastAt;
  const steps = snapshot.runs.runs[chatId]?.steps
    .filter((step) => step.status === "done" && (kind === "page" || step.kind === "artifact" || step.title === RESOLVED_STEP))
    .map((step) => step.id);
  return JSON.stringify([lastReply, steps]);
}
