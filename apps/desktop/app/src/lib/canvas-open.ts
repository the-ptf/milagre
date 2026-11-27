import type { CanvasLive } from "@milagre/shared/canvas";
import type { AgentQuestion, PermissionRequest, QuestionRequest } from "../model.ts";

/** `open` with `key` opened last: added, or moved to the end when already open. Opening one never closes another. */
export function openChat(open: readonly string[], key: string): string[] {
  return [...open.filter((item) => item !== key), key];
}

export function closeChat(open: readonly string[], key: string): string[] {
  return open.includes(key) ? open.filter((item) => item !== key) : (open as string[]);
}

/**
 * `open` without the Chats gone from the canvas: archived, or their Project left with nothing to show. Only Projects the
 * canvas went through count (`considered`): a Link's view shows some Projects, and the windows of the others stay open.
 * The same list when none left.
 */
export function keepOnCanvas(
  open: readonly string[],
  onCanvas: ReadonlySet<string>,
  considered: ReadonlySet<string>,
  projectOf: (key: string) => string,
): string[] {
  const gone = (key: string) => considered.has(projectOf(key)) && !onCanvas.has(key);
  return open.some(gone) ? open.filter((key) => !gone(key)) : (open as string[]);
}

/** A Chat window: its first size, the smallest it can be resized to, and the space it keeps from sections and other windows. */
export const WINDOW = { width: 420, height: 536, minWidth: 340, minHeight: 320, gap: 48 } as const;

export type Box = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

const overlaps = (a: Box, b: Box, gap: number) =>
  a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;

/**
 * Where a Project's new windows go, on the canvas's own coordinates: right of its section, side by side in the order
 * given, each level with its card (`top`). A window that would cover another Project's section, or a window already
 * placed, moves right past it, so no card and no other window is under it.
 */
export function placeWindows(section: Box, blockers: readonly Box[], windows: ReadonlyArray<{ top: number; width: number; height: number }>): Point[] {
  const taken = [...blockers];
  let cursor = section.x + section.width + WINDOW.gap;
  return windows.map(({ top, width, height }) => {
    const box = { x: cursor, y: top, width, height };
    for (let pass = 0; pass <= taken.length; pass++) {
      const blocker = taken.find((other) => overlaps(box, other, WINDOW.gap / 2));
      if (!blocker) break;
      box.x = blocker.x + blocker.width + WINDOW.gap;
    }
    taken.push(box);
    cursor = box.x + width + WINDOW.gap;
    return { x: box.x, y: box.y };
  });
}

/** What the canvas keeps of a Chat's window on this computer: where it was left, its size, and how its line was bent. */
export type WindowRecord = { x?: number; y?: number; width?: number; height?: number; bend?: Point };

/**
 * `records` without the Chats gone from a Project still on the canvas (archived, their Worktree removed). A Project not on
 * the canvas right now keeps its records: its Chats may come back. The same object when nothing is gone.
 */
export function forgetGone(
  records: Readonly<Record<string, WindowRecord>>,
  onCanvas: ReadonlySet<string>,
  projectsShown: ReadonlySet<string>,
  projectOf: (key: string) => string,
): Record<string, WindowRecord> {
  const gone = Object.keys(records).filter((key) => projectsShown.has(projectOf(key)) && !onCanvas.has(key));
  if (!gone.length) return records as Record<string, WindowRecord>;
  return Object.fromEntries(Object.entries(records).filter(([key]) => !gone.includes(key)));
}

/**
 * What a closed card adds under a Chat's row, in pixels, so sections size before React Flow measures. Each block in
 * CardLive renders at exactly this height: the step line; an approval with its buttons; a question with one row per
 * option (and "Other…"), or with an "Answer…" button when it needs the Chat's own form.
 */
export const LIVE = { step: 20, approval: 70, questionBase: 56, questionOption: 32, questionForm: 86 } as const;
const QUICK_OPTIONS = 4;

/** Whether a closed card answers this approval in place: not a Delegation or a setup command, which are read in full first. */
export function quickApproval(request: PermissionRequest): boolean {
  return request.kind !== "delegation" && request.kind !== "setup" && !request.delegation;
}

/** The question a closed card answers with one click: the only one asked, single choice, a few options, nothing secret. */
export function quickQuestion(request: QuestionRequest): AgentQuestion | undefined {
  if (request.secretRequest || request.bugReport || request.questions.length !== 1) return undefined;
  const question = request.questions[0];
  if (!question || question.multiSelect || question.secret || !question.options.length || question.options.length > QUICK_OPTIONS) return undefined;
  return question;
}

export function liveHeight(live: CanvasLive | undefined): number {
  const pending = live?.pending;
  if (pending?.kind === "approval") return LIVE.approval;
  if (pending?.kind === "question") {
    const question = quickQuestion(pending.request);
    return question ? LIVE.questionBase + (question.options.length + (question.allowOther ? 1 : 0)) * LIVE.questionOption : LIVE.questionForm;
  }
  return live?.step ? LIVE.step : 0;
}

export type Side = "left" | "right" | "top" | "bottom";

/**
 * Where a window's line meets its card and the window: the sides that face each other, so the line never wraps around
 * either of them. Side by side wins; a window overlapping its card's columns goes above or below it.
 */
export function lineSides(card: Box, window: Box): { card: Side; window: Side } {
  if (window.x >= card.x + card.width) return { card: "right", window: "left" };
  if (window.x + window.width <= card.x) return { card: "left", window: "right" };
  return window.y + window.height / 2 >= card.y + card.height / 2 ? { card: "bottom", window: "top" } : { card: "top", window: "bottom" };
}

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * A window's line from `from` to `to`: straight, or bent through a point the user dragged. The point is kept as an
 * `offset` from the straight line's middle, so it follows when the card or the window moves. The curve is a quadratic
 * through that point at its middle (its control point is the middle plus twice the offset).
 */
export function bentLine(from: Point, to: Point, offset: Point | null): { path: string; point: Point } {
  const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  if (!offset) return { path: `M ${round(from.x)},${round(from.y)} L ${round(to.x)},${round(to.y)}`, point: middle };
  const point = { x: middle.x + offset.x, y: middle.y + offset.y };
  const control = { x: middle.x + 2 * offset.x, y: middle.y + 2 * offset.y };
  return { path: `M ${round(from.x)},${round(from.y)} Q ${round(control.x)},${round(control.y)} ${round(to.x)},${round(to.y)}`, point };
}
