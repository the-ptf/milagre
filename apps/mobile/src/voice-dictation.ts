// The pure parts of dictating into the composer: where a transcript lands, how loud the mic is, and the state a take moves through.

export const RECORDING_LIMIT_SECONDS = 300;
export const METERING_INTERVAL_MS = 80;

export type Selection = { start: number; end: number };

export type DictationPhase = "idle" | "preparing" | "recording" | "transcribing";

export type DictationErrorKind = "permission" | "no-speech" | "failed" | "interrupted";

export type DictationError = { kind: DictationErrorKind; message: string };

export type Dictation = { phase: DictationPhase; error: DictationError | null };

export type DictationAction =
  | { type: "start" }
  | { type: "recording" }
  | { type: "stop" }
  | { type: "done" }
  | { type: "fail"; error: DictationError }
  | { type: "dismiss" };

export const IDLE: Dictation = { phase: "idle", error: null };

export const ERRORS = {
  permission: { kind: "permission", message: "Allow microphone access in Settings to dictate." },
  "no-speech": { kind: "no-speech", message: "No speech heard. Try again." },
  failed: { kind: "failed", message: "Could not transcribe that. Try again." },
  interrupted: { kind: "interrupted", message: "Dictation stopped when you left Milagre. Nothing was added." },
} as const satisfies Record<DictationErrorKind, DictationError>;

/** A take moves idle > preparing > recording > transcribing > idle; anything out of order is ignored. `fail` and `done` end it from any phase. */
export function dictationReducer(state: Dictation, action: DictationAction): Dictation {
  switch (action.type) {
    case "start":
      return state.phase === "idle" ? { phase: "preparing", error: null } : state;
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
