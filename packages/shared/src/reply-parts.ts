import { isDesktopStep } from "./desktop-steps.ts";
import type { ChatStep } from "./model.ts";

export type ReplyPart = { type: "text"; text: string } | { type: "steps"; steps: ChatStep[] };

/**
 * A reply's text and tool steps in the order they happened. Each step sits at its offset (the
 * length of the reply's text when it started); steps next to each other form one group, and a step
 * without an offset goes after the text. Text that is only whitespace is left out.
 */
export function replyParts(body: string, steps: ChatStep[] = []): ReplyPart[] {
  const parts: ReplyPart[] = [];
  let cursor = 0;
  for (const step of steps) {
    const at = Math.min(Math.max(step.offset ?? body.length, cursor), body.length);
    const text = body.slice(cursor, at);
    cursor = at;
    if (text.trim()) parts.push({ type: "text", text });
    const last = parts.at(-1);
    if (last?.type === "steps") last.steps.push(step);
    else parts.push({ type: "steps", steps: [step] });
  }
  const rest = body.slice(cursor);
  if (rest.trim()) parts.push({ type: "text", text: rest });
  return parts;
}

/** A design the agent showed, finished, which the reply shows as a card. */
export type ArtifactStep = ChatStep & { artifact: NonNullable<ChatStep["artifact"]> };
export const isArtifactCard = (step: ChatStep): step is ArtifactStep => step.kind === "artifact" && step.status === "done" && !!step.artifact;

/** A finished heartbeat_create step that set a Heartbeat (its result named it), which the reply shows as a card. */
export type HeartbeatStep = ChatStep & { routine: NonNullable<ChatStep["routine"]> };
export const isHeartbeatCard = (step: ChatStep): step is HeartbeatStep => step.status === "done" && !!step.routine;

export type ActivityEntry = { type: "text"; text: string } | { type: "step"; step: ChatStep };

/**
 * A reply as its activity and its answer. The answer is the reply's last text; the activity is
 * everything else (thinking, tool steps and the text between them) in the order it happened.
 * The worktree's setup is neither: it comes back apart, to show as a row of its own before both.
 * Generated images come back apart too, to show between the activity and the answer, and so do the designs the agent
 * showed, once each at the newest version this reply made (an artifact step still running, or one that failed, stays in
 * the activity as a row). So do the Heartbeats it set, each as a card, and its computer use steps (`desktop`), which
 * show as one card with the app's live screen.
 */
export function replyActivity(
  body: string,
  allSteps: ChatStep[] = [],
): {
  setup: ChatStep[];
  activity: ActivityEntry[];
  images: ChatStep[];
  artifacts: ArtifactStep[];
  heartbeats: HeartbeatStep[];
  desktop: ChatStep[];
  answer: string;
} {
  const setup = allSteps.filter((step) => step.kind === "setup");
  const images = allSteps.filter((step) => step.kind === "image");
  // One entry per design, at its newest version in this reply, where it was first shown.
  const artifacts: ArtifactStep[] = [];
  for (const step of allSteps.filter(isArtifactCard)) {
    const at = artifacts.findIndex((item) => item.artifact.id === step.artifact.id);
    if (at === -1) artifacts.push(step);
    else if (artifacts[at]!.artifact.version < step.artifact.version) artifacts[at] = step;
  }
  const heartbeats = allSteps.filter(isHeartbeatCard);
  const desktop = allSteps.filter(isDesktopStep);
  const parts = replyParts(
    body,
    allSteps.filter((step) => step.kind !== "setup" && step.kind !== "image" && !isArtifactCard(step) && !isHeartbeatCard(step) && !isDesktopStep(step)),
  );
  const answerIndex = parts.map((part) => part.type).lastIndexOf("text");
  const activity = parts.flatMap((part, index): ActivityEntry[] => {
    if (index === answerIndex) return [];
    return part.type === "text" ? [part] : part.steps.map((step) => ({ type: "step", step }));
  });
  const answer = answerIndex === -1 ? "" : (parts[answerIndex] as { text: string }).text;
  return { setup, activity, images, artifacts, heartbeats, desktop, answer };
}

/**
 * What a reply concluded without writing it: its last thinking, when no text came after it (the agent
 * kept its findings there, then asked a question or ended the turn). Shown under the answer so it isn't
 * hidden in a step the user rarely opens.
 */
export function unspokenThought(body: string, steps: ChatStep[] = []): string {
  const parts = replyParts(
    body,
    steps.filter((step) => step.kind !== "setup" && step.kind !== "image"),
  );
  for (const part of parts.toReversed()) {
    if (part.type === "text") return "";
    const thought = part.steps.findLast((step) => step.kind === "thinking" && step.status !== "running" && step.detail?.trim());
    if (thought) return thought.detail?.trim() ?? "";
  }
  return "";
}

const count = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("#", String(n)));

/** "4s", "1m 15s" */
export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** What a turn cost, as the summary says it: "0.04 credits", "1 credit", "<0.01 credits". */
export function creditsText(credits: number): string {
  if (credits > 0 && credits < 0.01) return "<0.01 credits";
  const value = Number(credits.toFixed(2));
  return `${value} ${value === 1 ? "credit" : "credits"}`;
}

/**
 * What a reply's activity did, in one line: "Thought for 12s · read 2 files · ran 3 commands", and what it cost when the
 * agent said (Kiro: "· 0.04 credits"). Files count once however often they were read or edited; failed is how many steps failed.
 */
export function activitySummary(all: ChatStep[], { credits }: { credits?: number } = {}): { text: string; failed: number } {
  const steps = all.filter((step) => step.kind !== "setup");
  const of = (kind: ChatStep["kind"]) => steps.filter((step) => step.kind === kind);
  const files = (kind: ChatStep["kind"]) => new Set(of(kind).map((step) => step.title)).size;
  const thinking = of("thinking");
  const thinkingMs = thinking.reduce((total, step) => total + (step.durationMs ?? 0), 0);
  const parts = [
    thinking.length ? (thinkingMs ? `thought for ${formatDuration(thinkingMs)}` : "thought") : "",
    files("read") ? count(files("read"), "read 1 file", "read # files") : "",
    of("search").length ? count(of("search").length, "searched once", "searched # times") : "",
    files("edit") ? count(files("edit"), "edited 1 file", "edited # files") : "",
    of("shell").length ? count(of("shell").length, "ran 1 command", "ran # commands") : "",
    of("other").length ? count(of("other").length, "used 1 tool", "used # tools") : "",
    credits !== undefined && Number.isFinite(credits) ? creditsText(credits) : "",
  ].filter(Boolean);
  const text = parts.join(" · ");
  return { text: text.charAt(0).toUpperCase() + text.slice(1), failed: steps.filter((step) => step.status === "failed").length };
}

/** A step title split into plain text and code: "Ran `npm test`" → "Ran ", then the code "npm test". */
export function titleSpans(title: string): Array<{ text: string; code: boolean }> {
  return title
    .split("`")
    .map((text, index) => ({ text, code: index % 2 === 1 }))
    .filter((span) => span.text);
}
