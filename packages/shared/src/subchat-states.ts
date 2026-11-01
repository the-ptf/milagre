// What each Subchat of a Chat is doing, for the Subchats pill above that Chat's composer on desktop and phone. A
// Subchat is a Chat whose session keeps this Chat's id as `parent` (subchats.ts). Its finished report shows in the
// transcript as one line (`reportMarker`); the pill and its list carry the rest.
import { formatElapsed } from "./display-clock.ts";
import type { AgentQuestion, PermissionRequest } from "./model.ts";

/** In the order the pill counts them: what needs the user first, then live work, then what ended. */
export const SUBCHAT_KINDS = ["needs-you", "failed", "working", "holding", "queued", "stopped", "done"] as const;
export type SubchatKind = (typeof SUBCHAT_KINDS)[number];

const LABELS: Record<SubchatKind, string> = {
  "needs-you": "Needs you",
  failed: "Failed",
  working: "Working",
  holding: "Holding",
  queued: "Queued",
  stopped: "Stopped",
  done: "Done",
};

/** A pending question or approval of a Subchat's turn, answered from the parent Chat. */
export type SubchatRequest = { kind: "question"; requestId: string; questions: AgentQuestion[] } | { kind: "approval"; request: PermissionRequest };

export interface SubchatInput {
  key: string;
  title: string;
  session: { done_at?: number; summary?: { lastOutcome?: "completed" | "failed" | "cancelled"; lastAt?: number } };
  /** The Subchat's live turn, when one runs. */
  run?: {
    text?: string;
    startedAt?: number;
    approvals?: PermissionRequest[];
    questions?: { requestId: string; questions: AgentQuestion[] }[];
    answered?: Record<string, unknown>;
  } | null;
  /** A Delegation to it waits in its queue. */
  queued?: boolean;
  /** Its enabled Heartbeat, when it has one. */
  heartbeat?: { nextRunAt?: number; runCount?: number; maxRuns?: number } | null;
  /** How its last report to this Chat ended, from the transcript. */
  report?: string;
}

export interface SubchatState {
  key: string;
  title: string;
  kind: SubchatKind;
  label: string;
  /** One line under the title: the question, the latest line of work, the next beat or how it ended. */
  detail: string;
  /** Elapsed time of a live turn, as "3m 05s". */
  elapsed?: string;
  /** The first unanswered question or approval, for the inline answers. */
  request?: SubchatRequest;
}

/** The last line the agent wrote, for a live row: one line, cut at the front when long. */
// Markdown read as plain text for a one-line detail: no code ticks, emphasis marks or link targets.
const plain = (text: string) =>
  text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(`+|\*{1,3})([^`*]+)\1/g, "$2")
    .replace(/`/g, "");

export function latestLine(text: string | undefined, max = 120): string {
  const lines = plain(text ?? "")
    .split("\n")
    .map((line) => line.replace(/^[#>*\-\s]+/, "").trim())
    .filter(Boolean);
  const line = lines.at(-1) ?? "";
  return line.length > max ? `…${line.slice(line.length - max + 1)}` : line;
}

function waitingRequest(run: SubchatInput["run"]): SubchatRequest | undefined {
  const answered = run?.answered ?? {};
  const approval = run?.approvals?.find((request) => !(request.requestId in answered));
  if (approval) return { kind: "approval", request: approval };
  const question = run?.questions?.find((request) => !(request.requestId in answered));
  return question ? { kind: "question", requestId: question.requestId, questions: question.questions } : undefined;
}

function nextBeat(heartbeat: NonNullable<SubchatInput["heartbeat"]>, now: number): string {
  const parts = [];
  if (typeof heartbeat.nextRunAt === "number") {
    const minutes = Math.max(0, Math.round((heartbeat.nextRunAt - now) / 60_000));
    parts.push(minutes < 1 ? "next beat now" : minutes < 60 ? `next beat in ${minutes} min` : `next beat in ${Math.round(minutes / 60)} h`);
  }
  if (heartbeat.maxRuns) parts.push(`run ${heartbeat.runCount ?? 0} of ${heartbeat.maxRuns}`);
  return parts.join(" · ") || "Heartbeat on";
}

/** One Subchat's state: a pending request beats a live turn, which beats a Heartbeat, a queue and how it ended. */
export function subchatState(input: SubchatInput, now: number): SubchatState {
  const make = (kind: SubchatKind, detail: string, extra: Partial<SubchatState> = {}): SubchatState => ({
    key: input.key,
    title: input.title,
    kind,
    label: LABELS[kind],
    detail,
    ...extra,
  });
  const run = input.run;
  const elapsed = run && typeof run.startedAt === "number" ? formatElapsed(now - run.startedAt) : undefined;
  const request = waitingRequest(run);
  if (request) {
    const detail = request.kind === "approval" ? `Asks to run: ${request.request.title}` : `Asks: ${request.questions[0]?.question ?? "a question"}`;
    return make("needs-you", detail, { request, elapsed });
  }
  if (run) return make("working", latestLine(run.text) || "Working", { elapsed });
  if (input.queued) return make("queued", "Starts after the Chat's running turn");
  if (input.heartbeat) return make("holding", nextBeat(input.heartbeat, now));
  const outcome = input.session.summary?.lastOutcome;
  const ended = latestLine(input.report);
  if (outcome === "failed") return make("failed", ended || "Its last turn failed");
  if (outcome === "cancelled") return make("stopped", ended || "Stopped");
  return make("done", plain(input.report ?? "").trim() || "Finished");
}

export interface SubchatSummary {
  /** The kind that leads the pill (its dot), the first one present in SUBCHAT_KINDS order. */
  lead: SubchatKind | null;
  /** "1 needs you", "2 working", …, in SUBCHAT_KINDS order; Stopped and Done count together as ended. */
  parts: { kind: SubchatKind; text: string }[];
}

/** The pill's words for a set of Subchats. */
export function subchatSummary(states: readonly SubchatState[]): SubchatSummary {
  const count = (kinds: SubchatKind[]) => states.filter((state) => kinds.includes(state.kind)).length;
  const parts: SubchatSummary["parts"] = [];
  const add = (kind: SubchatKind, n: number, text: string) => n > 0 && parts.push({ kind, text: `${n} ${text}` });
  add("needs-you", count(["needs-you"]), "needs you");
  add("failed", count(["failed"]), "failed");
  add("working", count(["working"]), "working");
  add("holding", count(["holding"]), "holding");
  add("queued", count(["queued"]), "queued");
  add("done", count(["done", "stopped"]), "done");
  const lead = SUBCHAT_KINDS.find((kind) => states.some((state) => state.kind === kind)) ?? null;
  return { lead, parts };
}

/** Subchats first by what needs the user, then by the order they were made. */
export function sortSubchats(states: readonly SubchatState[]): SubchatState[] {
  const rank = (state: SubchatState) => SUBCHAT_KINDS.indexOf(state.kind);
  return states
    .map((state, index) => ({ state, index }))
    .sort((a, b) => rank(a.state) - rank(b.state) || a.index - b.index)
    .map(({ state }) => state);
}

type ReportContext = { kind: string; status?: string; fromLabel?: string; negotiation?: unknown };

/**
 * The one line a Delegation report stands for in the transcript (its text opens on tap), or null for a message that
 * isn't one. Negotiation rounds keep their full text: the other side's position is the conversation.
 */
export function reportMarker(context: ReportContext | null | undefined): { text: string; kind: SubchatKind } | null {
  if (!context || context.kind !== "delegation-report" || context.negotiation) return null;
  const name = (context.fromLabel ?? "").split(" / ").at(-1) || "A Chat";
  if (context.status === "failed") return { text: `${name} failed`, kind: "failed" };
  if (context.status === "cancelled") return { text: `${name} stopped`, kind: "stopped" };
  return { text: `${name} finished`, kind: "done" };
}

/** The body of the latest Delegation report each Chat sent into this transcript, by the sender's Chat key. */
export function latestReports(messages: readonly { body?: string; context?: unknown }[]): Map<string, string> {
  const reports = new Map<string, string>();
  for (const message of messages) {
    const context = message.context as { kind?: string; from?: string } | null | undefined;
    if (context?.kind === "delegation-report" && typeof context.from === "string") reports.set(context.from, message.body ?? "");
  }
  return reports;
}

/** The Chats a Delegation from `key` made (its direct Subchats) that are still listed, oldest first. */
export function directSubchats(sessions: Record<string, { id: number; parent?: number; archived?: boolean }> | undefined, key: string): string[] {
  const hash = key.lastIndexOf("#");
  if (!sessions || hash < 0) return [];
  const parent = Number(key.slice(hash + 1));
  return Object.values(sessions)
    .filter((session) => session.parent === parent && !session.archived)
    .sort((a, b) => a.id - b.id)
    .map((session) => `${key.slice(0, hash)}#${session.id}`);
}
