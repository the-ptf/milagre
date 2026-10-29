import { useCallback, useEffect, useRef, useState } from "react";
import { whisperPrompt } from "@milagre/shared/dictation";
import { ipcErrorMessage } from "@milagre/shared/result";
import {
  ERRORS,
  IDLE,
  RECORDING_LIMIT_SECONDS,
  dictationReducer,
  meterLevel,
  type Dictation,
  type DictationAction,
  type DictationError,
  type Selection,
} from "@milagre/shared/voice-dictation";
import { useBridge } from "../lib/computer-bridge";
import { useSettings } from "../lib/settings";

/** Where the transcript goes: the draft's selection when the mic was clicked. */
export type DictationAnchor = { selection: Selection };

const SAMPLE_RATE = 16_000;

/** A recording as Whisper reads it: 16 kHz, mono, 16-bit PCM. The audio context resamples while it decodes. */
async function pcm16(blob: Blob): Promise<ArrayBuffer> {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
    const out = new Int16Array(decoded.length);
    for (let i = 0; i < out.length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i]!;
      out[i] = Math.max(-1, Math.min(1, sample / channels.length)) * 0x7fff;
    }
    return out.buffer;
  } finally {
    void context.close();
  }
}

type Take = {
  id: number;
  anchor: DictationAnchor;
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  terms: Promise<string[]>;
  audio: AudioContext;
};

/**
 * Click the mic to record, click again to transcribe with Whisper on this computer, the Chat's project words as its prompt.
 * The first take downloads the speech model; `download` says how far it is. Leaving the Chat (`scope`, which changes even
 * between two Chats in one folder: the composer is reused) throws the take away.
 */
export function useDictation(cwd: string, scope: string, onTranscript: (text: string, anchor: DictationAnchor) => void) {
  const bridge = useBridge();
  const { dictationLanguage } = useSettings();
  const [state, setState] = useState<Dictation>(IDLE);
  const [download, setDownload] = useState<{ received: number; total: number } | null>(null);
  const phase = useRef<Dictation>(IDLE);
  const take = useRef<Take | null>(null);
  const counter = useRef(0);
  const meter = useRef<HTMLElement | null>(null);
  const deliver = useRef(onTranscript);
  useEffect(() => {
    deliver.current = onTranscript;
  });

  const move = useCallback((action: DictationAction) => {
    phase.current = dictationReducer(phase.current, action);
    setState(phase.current);
  }, []);

  /** Lets go of the microphone; later answers from the take are ignored. */
  const abandon = useCallback(() => {
    const current = take.current;
    take.current = null;
    counter.current += 1;
    if (!current) return;
    if (current.recorder.state !== "inactive") current.recorder.stop();
    for (const track of current.stream.getTracks()) track.stop();
    void current.audio.close();
  }, []);

  const fail = useCallback(
    (error: DictationError) => {
      abandon();
      setDownload(null);
      move({ type: "fail", error });
    },
    [abandon, move],
  );

  const stop = useCallback(async () => {
    const current = take.current;
    if (!current || phase.current.phase !== "recording") return;
    move({ type: "stop" });
    const stopped = new Promise((resolve) => current.recorder.addEventListener("stop", resolve, { once: true }));
    current.recorder.stop();
    for (const track of current.stream.getTracks()) track.stop();
    void current.audio.close();
    const live = () => take.current?.id === current.id;
    const unlisten = window.milagre.dictation.onProgress((progress) => {
      if (live()) setDownload(progress.received < progress.total ? progress : null);
    });
    try {
      await stopped;
      const audio = await pcm16(new Blob(current.chunks, { type: current.recorder.mimeType }));
      const terms = await current.terms;
      if (!live()) return;
      const { text } = await window.milagre.dictation.transcribe({ audio, language: dictationLanguage, prompt: whisperPrompt(terms) });
      if (!live()) return;
      take.current = null;
      setDownload(null);
      if (!text) return move({ type: "fail", error: ERRORS["no-speech"] });
      move({ type: "done" });
      deliver.current(text, current.anchor);
    } catch (error) {
      if (live()) fail({ kind: "failed", message: ipcErrorMessage(error) || ERRORS.failed.message });
    } finally {
      unlisten();
    }
  }, [dictationLanguage, fail, move]);

  const start = useCallback(
    async (anchor: DictationAnchor) => {
      if (phase.current.phase !== "idle") return;
      move({ type: "start" });
      const id = (counter.current += 1);
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      } catch (error) {
        if (counter.current !== id) return;
        return fail(error instanceof DOMException && error.name === "NotAllowedError" ? ERRORS.permission : ERRORS.failed);
      }
      if (counter.current !== id) return void stream.getTracks().forEach((track) => track.stop());
      // The project's words are read while the user talks.
      const terms = bridge
        .dictationContext({ cwd })
        .then((context) => context.terms)
        .catch(() => []);
      const audio = new AudioContext();
      // Chromium may start it suspended; the meter only (the recording doesn't go through it).
      void audio.resume();
      const analyser = audio.createAnalyser();
      analyser.fftSize = 1024;
      audio.createMediaStreamSource(stream).connect(analyser);
      const recorder = new MediaRecorder(stream);
      const current: Take = { id, anchor, stream, recorder, chunks: [], terms, audio };
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size) current.chunks.push(event.data);
      });
      take.current = current;
      recorder.start();
      move({ type: "recording" });
      // The mic's halo follows the voice, written straight to the button so a frame costs no render.
      const samples = new Float32Array(analyser.fftSize);
      const frame = () => {
        if (take.current !== current || phase.current.phase !== "recording") return meter.current?.style.setProperty("--level", "0");
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
        meter.current?.style.setProperty("--level", meterLevel(20 * Math.log10(rms || 1e-9)).toFixed(3));
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      setTimeout(() => {
        if (take.current === current) void stop();
      }, RECORDING_LIMIT_SECONDS * 1000);
    },
    [bridge, cwd, fail, move, stop],
  );

  // Another Chat or a closed composer: the take goes with it.
  useEffect(
    () => () => {
      abandon();
      phase.current = IDLE;
    },
    [abandon, cwd, scope],
  );
  useEffect(() => {
    setState(IDLE);
    setDownload(null);
  }, [cwd, scope]);

  return {
    phase: state.phase,
    error: state.error,
    download,
    meter,
    start,
    stop,
    dismiss: useCallback(() => move({ type: "dismiss" }), [move]),
    /** This computer's microphone privacy settings, for a refused microphone. */
    openSettings: useCallback(() => {
      move({ type: "dismiss" });
      void window.milagre.dictation.openSettings();
    }, [move]),
  };
}
