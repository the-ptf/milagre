import { silentPcm } from "./dictation.mjs";

export const DICTATION_SAMPLE_RATE = 16_000;
const FRAME = 1600;
const PAUSE = 11_200;
const MAX_SEGMENT = 30 * DICTATION_SAMPLE_RATE;
const OVERLAP = 8000;

type Segment = { chunks: Int16Array[]; length: number; speechEnd: number; decoded: number; text: string; sealed: boolean; overlap: boolean };

function samplesOf(segment: Segment, end = segment.length): Int16Array {
  const out = new Int16Array(end);
  let offset = 0;
  for (const chunk of segment.chunks) {
    const count = Math.min(chunk.length, end - offset);
    out.set(chunk.subarray(0, count), offset);
    offset += count;
    if (offset === end) break;
  }
  return out;
}

/** Only the forced 30-second boundary overlaps audio. Ordinary pauses must preserve repeated words. */
function transcriptOf(segments: Segment[]): string {
  let words: string[] = [];
  const normalized = (word: string) => word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  for (const segment of segments) {
    const next = segment.text.trim().split(/\s+/).filter(Boolean);
    let skip = 0;
    if (segment.overlap) {
      for (let count = 1; count <= Math.min(12, words.length, next.length); count++) {
        if (next.slice(0, count).every((word, i) => normalized(word) === normalized(words[words.length - count + i]!))) skip = count;
      }
    }
    words = words.concat(next.slice(skip));
  }
  return words.join(" ");
}

/**
 * How many characters at the front of the transcript can no longer change: the run of segments from the start that are
 * both sealed (a pause or the 30-second boundary closed them) and fully decoded. Anything after that is still being
 * revised by the next inference. It says the text has stopped moving, never that it is the right text.
 */
function settledLength(segments: Segment[]): number {
  let count = 0;
  for (const segment of segments) {
    if (!segment.sealed || segment.decoded < segment.speechEnd) break;
    count++;
  }
  if (!count) return 0;
  const full = transcriptOf(segments);
  let settled = Math.min(transcriptOf(segments.slice(0, count)).length, full.length);
  // The space that joins the settled words to the revised ones belongs to neither; keep it out of the revised run.
  while (settled < full.length && full[settled] === " ") settled++;
  return settled;
}

/**
 * Bounded, local dictation with any file/PCM recognizer. One inference runs at a time; incoming audio replaces the
 * next partial snapshot instead of queuing stale snapshots. Pauses seal segments. Stop reuses a result when no new
 * speech arrived, or decodes only the unfinished segment. The draft is committed by the caller only after finish.
 */
export function createStreamingDictation({
  transcribe,
  onPartial,
}: {
  transcribe: (pcm: ArrayBuffer) => Promise<string>;
  /** The transcript so far, and how many of its leading characters have stopped changing. */
  onPartial: (text: string, settled: number) => void;
}) {
  const segments: Segment[] = [];
  let current: Segment | null = null;
  let running: Promise<void> | null = null;
  let finishing: Promise<string> | null = null;
  let stopped = false;
  let cancelled = false;
  let failure: unknown;
  let received = 0;

  function pending() {
    return segments.find(
      (segment) => segment.speechEnd > segment.decoded && (stopped || segment.sealed || segment.speechEnd - segment.decoded >= DICTATION_SAMPLE_RATE),
    );
  }

  function kick() {
    if (running || cancelled || failure || !pending()) return;
    running = (async () => {
      for (let segment = pending(); segment; segment = pending()) {
        if (cancelled) return;
        const through = segment.speechEnd;
        const pcm = samplesOf(segment, Math.min(segment.length, through + 3200));
        const text = await transcribe(pcm.buffer as ArrayBuffer);
        if (cancelled) return;
        segment.text = text.trim();
        segment.decoded = through;
        onPartial(transcriptOf(segments), settledLength(segments));
      }
    })()
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        running = null;
      });
  }

  return {
    append(pcm: Int16Array) {
      if (stopped || cancelled || failure) return;
      // The recorder's timer may run a buffer late. Keep the take valid and cap its audio at the recording limit.
      pcm = pcm.subarray(0, Math.max(0, 300 * DICTATION_SAMPLE_RATE - received));
      received += pcm.length;
      for (let offset = 0; offset < pcm.length; offset += FRAME) {
        const frame = pcm.slice(offset, offset + FRAME);
        const speech = !silentPcm(frame);
        if (!current) {
          if (!speech) continue;
          current = { chunks: [], length: 0, speechEnd: 0, decoded: 0, text: "", sealed: false, overlap: false };
          segments.push(current);
        }
        current.chunks.push(frame);
        current.length += frame.length;
        if (speech) current.speechEnd = current.length;
        if (current.length - current.speechEnd >= PAUSE) {
          current.sealed = true;
          current = null;
        } else if (current.length >= MAX_SEGMENT) {
          const tail = samplesOf(current).slice(-OVERLAP);
          current.sealed = true;
          current = { chunks: [tail], length: tail.length, speechEnd: tail.length, decoded: 0, text: "", sealed: false, overlap: true };
          segments.push(current);
        }
      }
      kick();
    },
    finish(): Promise<string> {
      finishing ??= (async () => {
        stopped = true;
        do {
          kick();
          await running;
          if (failure) throw failure;
          if (cancelled) return "";
        } while (pending());
        return cancelled ? "" : transcriptOf(segments);
      })();
      return finishing;
    },
    cancel() {
      cancelled = true;
      current = null;
      segments.length = 0;
    },
    /** Waits for the current partial inference, without ending capture (also useful for benchmarks). */
    async idle() {
      await running;
    },
  };
}

export type StreamingDictation = ReturnType<typeof createStreamingDictation>;

/** Stateful box-filter resampling: hardware rates, channel mixing and partial sample windows survive buffer boundaries. */
export function createDictationResampler() {
  let sum = 0;
  let weight = 0;
  let rate = 0;
  return (data: Float32Array, sampleRate: number, channels = 1): Int16Array => {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isInteger(channels) || channels < 1 || data.length % channels) {
      throw new Error("Unsupported microphone audio format.");
    }
    if (sampleRate !== rate) {
      sum = 0;
      weight = 0;
      rate = sampleRate;
    }
    const step = DICTATION_SAMPLE_RATE / sampleRate;
    const out: number[] = [];
    for (let i = 0; i < data.length; i += channels) {
      let mono = 0;
      for (let channel = 0; channel < channels; channel++) mono += data[i + channel]! / channels;
      let left = step;
      while (left > 1e-9) {
        const part = Math.min(1 - weight, left);
        sum += mono * part;
        weight += part;
        left -= part;
        if (weight >= 1 - 1e-9) {
          out.push(Math.round(Math.max(-1, Math.min(1, sum)) * 32767));
          sum = 0;
          weight = 0;
        }
      }
    }
    return Int16Array.from(out);
  };
}

/** The Apple file recognizer accepts a WAV buffer; no intermediate JS-side file or native patch is needed. */
export function dictationWav(pcm: ArrayBuffer): ArrayBuffer {
  const wav = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(wav);
  const tag = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, DICTATION_SAMPLE_RATE, true);
  view.setUint32(28, DICTATION_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  new Uint8Array(wav, 44).set(new Uint8Array(pcm));
  return wav;
}
