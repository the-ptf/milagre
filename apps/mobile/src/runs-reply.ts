import { reconcileState } from "@milagre/shared/reconcile";
import type { Runs, RunsReply } from "./client.ts";

/** Each reply lists all live turns. Never carry a missing turn or its old detail forward. */
export function mergeRunsReply(current: Runs, reply: RunsReply): Runs {
  if ((reply.seq ?? 0) < (current.seq ?? 0)) return current;
  if (reply.detailChats === undefined) return reconcileState(current, reply);
  const runs: Runs["runs"] = {};
  for (const [key, summary] of Object.entries(reply.summaries ?? {})) runs[key] = { ...summary, text: "", steps: [] };
  Object.assign(runs, reply.runs);
  return reconcileState(current, { seq: reply.seq, runs });
}
