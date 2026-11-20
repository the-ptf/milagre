import { isDesktopStep } from "./desktop-steps.ts";
import type { ChatStep, ImageAttachment } from "./model.ts";

export function replyImageFile(step: ChatStep, attachments: ImageAttachment[] = []): string | undefined {
  if (!step.file) return undefined;
  return attachments.find((image) => image.sourcePath === step.file)?.path || step.file;
}

export function viewedImageName(step: ChatStep): string {
  return (step.sourceFile || step.file || "").split(/[\\/]/).pop() || "Viewed image";
}

export type ReplyPart = { type: "text"; text: string } | { type: "steps"; steps: ChatStep[] };

/**
 * Steps sit at their offset (the length of the reply's text when they started); steps next to each other form one
 * group, a step without an offset goes after the text, whitespace-only text is left out.
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

export type ArtifactStep = ChatStep & { artifact: NonNullable<ChatStep["artifact"]> };
export const isArtifactCard = (step: ChatStep): step is ArtifactStep => step.kind === "artifact" && step.status === "done" && !!step.artifact;

export type HeartbeatStep = ChatStep & { routine: NonNullable<ChatStep["routine"]> };
export const isHeartbeatCard = (step: ChatStep): step is HeartbeatStep => step.status === "done" && !!step.routine;

export type ActivityEntry = { type: "text"; text: string } | { type: "step"; step: ChatStep };

/**
 * The answer is the reply's last text; the activity is everything else in order. The worktree's setup, generated
 * images, designs (once each, at the newest version), Heartbeat cards and computer use steps (`desktop`) come back
 * apart.
 */
export function replyActivity(
  body: string,
  allSteps: ChatStep[] = [],
): {
  setup: ChatStep[];
  activity: ActivityEntry[];
  images: ChatStep[];
  viewedImages: ChatStep[];
  artifacts: ArtifactStep[];
  heartbeats: HeartbeatStep[];
  desktop: ChatStep[];
  answer: string;
  /** How many activity entries come before the answer; the rest happened after it (a tool call the text led into). */
  answerAt: number;
} {
  const setup = allSteps.filter((step) => step.kind === "setup");
  const images = allSteps.filter((step) => step.kind === "image" && step.imageOrigin !== "viewed");
  const viewedImages = allSteps.filter((step) => step.kind === "image" && step.imageOrigin === "viewed");
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
  const answerAt =
    answerIndex === -1 ? activity.length : parts.slice(0, answerIndex).reduce((total, part) => total + (part.type === "text" ? 1 : part.steps.length), 0);
  return { setup, activity, images, viewedImages, artifacts, heartbeats, desktop, answer, answerAt };
}

/** The calls the reply is running now: the steps after its last text, while no text has followed them yet. */
export function liveActivity(body: string, steps: ChatStep[] = []): ChatStep[] {
  const { activity, answer, answerAt } = replyActivity(body, steps);
  return (answer.trim() ? activity.slice(answerAt) : activity).flatMap((entry) => (entry.type === "step" ? [entry.step] : []));
}

/**
 * The live calls the loader under the transcript shows in place of their activity row. A call waiting for approval keeps
 * its group in the transcript, beside its approval card.
 */
export function loaderActivity(body: string, steps: ChatStep[] = [], waitingStepIds: readonly string[] = []): ChatStep[] {
  const live = liveActivity(body, steps);
  return live.some((step) => waitingStepIds.includes(step.id)) ? [] : live;
}

/** The last thinking, when no text came after it; shown under the answer. */
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
 * "Thought for 12s · read 2 files · ran 3 commands", plus the cost when the agent said (Kiro: "· 0.04 credits"). Files
 * count once however often read or edited; `failed` is how many steps failed.
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
