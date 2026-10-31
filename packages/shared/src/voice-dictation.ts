// The pure parts of dictating into the composer (desktop and phone): where a transcript lands, how loud the mic is, and the state a take moves through.
export { createStreamingDictation, createDictationResampler, dictationWav, DICTATION_SAMPLE_RATE, type StreamingDictation } from "./voice-stream.ts";

export const RECORDING_LIMIT_SECONDS = 300;
export const METERING_INTERVAL_MS = 80;

export type DictationActionPreference = "paste" | "send";
export const DICTATION_ACTION_OPTIONS: { value: DictationActionPreference; label: string; description: string }[] = [
  { value: "paste", label: "Paste text", description: "Edit, then send." },
  { value: "send", label: "Send now", description: "No review step." },
];

/** Existing users and unreadable preferences keep the transcript in the composer. */
export function parseDictationAction(value: unknown): DictationActionPreference {
  return value === "send" ? "send" : "paste";
}

export type Selection = { start: number; end: number };

export type DictationPhase = "idle" | "preparing" | "downloading" | "recording" | "transcribing";

export type DictationErrorKind = "permission" | "no-speech" | "failed" | "interrupted";

export type DictationError = { kind: DictationErrorKind; message: string };

export type Dictation = { phase: DictationPhase; error: DictationError | null };

export type DictationAction =
  | { type: "start" }
  | { type: "download" }
  | { type: "downloaded" }
  | { type: "recording" }
  | { type: "stop" }
  | { type: "done" }
  | { type: "fail"; error: DictationError }
  | { type: "dismiss" };

export const IDLE: Dictation = { phase: "idle", error: null };

/** How long a message over the mic stays. A permission refusal stays until the user acts on it. */
export const NOTICE_SECONDS = 3;

export const ERRORS = {
  permission: { kind: "permission", message: "Allow the microphone to dictate." },
  "no-speech": { kind: "no-speech", message: "I didn't hear you. Try again." },
  failed: { kind: "failed", message: "Couldn't transcribe that. Try again." },
  interrupted: { kind: "interrupted", message: "Dictation stopped when you left Milagre. Nothing was added." },
} as const satisfies Record<DictationErrorKind, DictationError>;

/**
 * A take moves idle > preparing > recording > transcribing > idle; anything out of order is ignored. `fail` and `done` end
 * it from any phase. When the speech model isn't on the device yet, preparing first goes through downloading and back:
 * the take records only once the model has landed.
 */
export function dictationReducer(state: Dictation, action: DictationAction): Dictation {
  switch (action.type) {
    case "start":
      return state.phase === "idle" ? { phase: "preparing", error: null } : state;
    case "download":
      return state.phase === "preparing" ? { phase: "downloading", error: null } : state;
    case "downloaded":
      return state.phase === "downloading" ? { phase: "preparing", error: null } : state;
    case "recording":
      return state.phase === "preparing" ? { phase: "recording", error: null } : state;
    case "stop":
      return state.phase === "recording" ? { phase: "transcribing", error: null } : state;
    case "done":
      return state.phase === "idle" ? state : IDLE;
    case "fail":
      return { phase: "idle", error: action.error };
    case "dismiss":
      return state.error ? { ...state, error: null } : state;
  }
}

const NOISE_FLOOR_DB = -60;
const NOISE_FLOOR_AMPLITUDE = 10 ** (NOISE_FLOOR_DB / 20);

/** The recorder's metering in dB (0 is full scale) as 0..1, silent at the -60 dB floor, so quiet rooms do not move the bars. */
export function meterLevel(decibels: number | undefined): number {
  if (decibels === undefined || !Number.isFinite(decibels)) return 0;
  if (decibels <= NOISE_FLOOR_DB) return 0;
  if (decibels >= 0) return 1;
  const amplitude = 10 ** (decibels / 20);
  return Math.sqrt((amplitude - NOISE_FLOOR_AMPLITUDE) / (1 - NOISE_FLOOR_AMPLITUDE));
}

/** Segments from the recognizer joined into one line of text. */
export function joinSegments(segments: { text: string }[]): string {
  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(" ");
}

const NO_SPACE_BEFORE = /^[\s.,;:!?)\]}]/;
const NO_SPACE_AFTER = /[\s([{]$/;

/**
 * The draft with `text` at `selection` (replacing a selected range) and the caret after it. The selection was taken when the
 * recording began, so the draft may have changed since: it is clamped to the draft's current length rather than dropped.
 * A space goes on a side only when the neighboring character would otherwise touch the words. Null for empty text.
 */
export function insertDictation(draft: string, selection: Selection, text: string): { value: string; caret: number } | null {
  const words = text.trim();
  if (!words) return null;
  const start = Math.max(0, Math.min(selection.start, draft.length));
  const end = Math.max(start, Math.min(selection.end, draft.length));
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const lead = before && !NO_SPACE_AFTER.test(before) ? " " : "";
  const trail = after && !NO_SPACE_BEFORE.test(after) ? " " : "";
  const inserted = `${lead}${words}`;
  return { value: `${before}${inserted}${trail}${after}`, caret: start + inserted.length };
}

/**
 * A take's words inside the draft, so the same run can be rewritten in place as the recognizer revises it and taken
 * back out whole when the take is discarded. `settled` is where the revisable tail begins: it marks text that has
 * stopped moving, never text that is known to be right.
 */
export type DictationTake = {
  /** The draft as it was when the mic was tapped, and the caret or selection the words replace. */
  base: string;
  anchor: Selection;
  /** The exact draft this take last wrote; anything else means the user edited around it. */
  produced: string;
  /** The run this take occupies in `produced`: `[start, end)`, the joining space included. */
  start: number;
  end: number;
  /** Offset into the draft where the revisable tail begins; equal to `end` when nothing is provisional. */
  settled: number;
};

/** A take about to write into `draft` at `selection`. Nothing is inserted yet. */
export function startTake(draft: string, selection: Selection): DictationTake {
  const start = Math.max(0, Math.min(selection.start, draft.length));
  const end = Math.max(start, Math.min(selection.end, draft.length));
  return { base: draft, anchor: { start, end }, produced: draft, start, end, settled: end };
}

/**
 * The draft with this take's words rewritten in place from the latest partial. `settled` counts characters of `text`
 * that can no longer change. Null when the take has nothing to write and nothing written yet.
 * The range is clamped to the current draft, so an edit the user made during the take shifts the run rather than
 * dropping it; the words can land in the wrong place if they edited across it.
 */
export function writeTake(take: DictationTake, draft: string, text: string, settled: number): { take: DictationTake; value: string; caret: number } | null {
  const start = Math.max(0, Math.min(take.start, draft.length));
  const end = Math.max(start, Math.min(take.end, draft.length));
  const words = text.trim();
  if (!words) {
    if (start === end) return null;
    const value = draft.slice(0, start) + draft.slice(end);
    return { take: { ...take, produced: value, start, end: start, settled: start }, value, caret: start };
  }
  const edit = insertDictation(draft, { start, end }, words);
  if (!edit) return null;
  const from = edit.caret - words.length;
  const stable = from + Math.max(0, Math.min(settled, words.length));
  return { take: { ...take, produced: edit.value, start, end: edit.caret, settled: stable }, value: edit.value, caret: edit.caret };
}

/** The draft with this take's words taken back out, and the caret or selection to put back. Only the take is discarded. */
export function revertTake(take: DictationTake, draft: string): { value: string; selection: Selection } {
  if (draft === take.produced) return { value: take.base, selection: take.anchor };
  const start = Math.max(0, Math.min(take.start, draft.length));
  const end = Math.max(start, Math.min(take.end, draft.length));
  return { value: draft.slice(0, start) + draft.slice(end), selection: { start, end: start } };
}

/** The part of the draft the recognizer may still rewrite, or null while every dictated word has settled. */
export function provisionalRange(take: DictationTake | null): Selection | null {
  return take && take.settled < take.end ? { start: take.settled, end: take.end } : null;
}

/**
 * `parts` split so the provisional characters sit in pieces of their own. Only text parts are split: a chip is never
 * half provisional. Each piece carries the part it came from, so a caller keeps its own colors and chips.
 */
export function splitProvisional<Part extends { kind: string; text: string }>(
  parts: readonly Part[],
  range: Selection | null,
): { part: Part; text: string; provisional: boolean }[] {
  const pieces: { part: Part; text: string; provisional: boolean }[] = [];
  let offset = 0;
  for (const part of parts) {
    const start = offset;
    const end = (offset += part.text.length);
    if (!range || part.kind !== "text" || range.end <= start || range.start >= end || range.start >= range.end) {
      pieces.push({ part, text: part.text, provisional: false });
      continue;
    }
    const from = Math.max(range.start, start) - start;
    const to = Math.min(range.end, end) - start;
    if (from > 0) pieces.push({ part, text: part.text.slice(0, from), provisional: false });
    pieces.push({ part, text: part.text.slice(from, to), provisional: true });
    if (to < part.text.length) pieces.push({ part, text: part.text.slice(to), provisional: false });
  }
  return pieces;
}
