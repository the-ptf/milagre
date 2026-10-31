import { useCallback, useEffect, useRef, useState } from "react";
import captureWorklet from "../lib/dictation-worklet.js?url&no-inline";
import { whisperLanguage, whisperPrompt } from "@milagre/shared/dictation";
import { ipcErrorMessage } from "@milagre/shared/result";
import {
  ERRORS,
  IDLE,
  RECORDING_LIMIT_SECONDS,
  DICTATION_SAMPLE_RATE,
  createDictationResampler,
  createStreamingDictation,
  dictationReducer,
  meterLevel,
  type Dictation,
  type DictationAction,
  type DictationError,
  type Selection,
  type StreamingDictation,
} from "@milagre/shared/voice-dictation";
import { useBridge } from "../lib/computer-bridge";
import { useSettings } from "../lib/settings";

export type DictationAnchor = { selection: Selection };

/** The transcript so far and how much of it has stopped changing. `settled` marks stability, not correctness. */
export type DictationPartial = { text: string; settled: number };

const NO_PARTIAL: DictationPartial = { text: "", settled: 0 };

type Take = {
  id: number;
  anchor: DictationAnchor;
  stream: MediaStream;
  audio: AudioContext;
  processor: AudioWorkletNode;
  transcript: StreamingDictation;
  finishCapture: () => Promise<void>;
  unlisten: () => void;
  limit: ReturnType<typeof setTimeout> | null;
};

function closeAudio(audio: AudioContext) {
  if (audio.state !== "closed") void audio.close().catch(() => {});
}

/** Local PCM capture and partial inference while speaking. Only the final transcript edits or sends the draft. */
export function useDictation(cwd: string, scope: string, onTranscript: (text: string, anchor: DictationAnchor) => void) {
  const bridge = useBridge();
  const { dictationLanguage } = useSettings();
  const [state, setState] = useState<Dictation>(IDLE);
  const [partial, setPartial] = useState<DictationPartial>(NO_PARTIAL);
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

  const abandon = useCallback(() => {
    const current = take.current;
    take.current = null;
    counter.current += 1;
    if (!current) return;
    current.transcript.cancel();
    current.unlisten();
    if (current.limit) clearTimeout(current.limit);
    current.processor.port.close();
    current.processor.disconnect();
    for (const track of current.stream.getTracks()) track.stop();
    closeAudio(current.audio);
  }, []);

  const cancel = useCallback(() => {
    abandon();
    setDownload(null);
    setPartial(NO_PARTIAL);
    move({ type: "done" });
  }, [abandon, move]);

  const fail = useCallback(
    (error: DictationError) => {
      abandon();
      setDownload(null);
      setPartial(NO_PARTIAL);
      move({ type: "fail", error });
    },
    [abandon, move],
  );

  const stop = useCallback(async () => {
    const current = take.current;
    if (!current || phase.current.phase !== "recording") return;
    move({ type: "stop" });
    if (current.limit) clearTimeout(current.limit);
    const live = () => take.current?.id === current.id;
    try {
      // The worklet flushes its last short buffer before acknowledging. No final syllable is left on the audio thread.
      await current.finishCapture();
      for (const track of current.stream.getTracks()) track.stop();
      current.processor.disconnect();
      closeAudio(current.audio);
      if (!live()) return;
      const text = await current.transcript.finish();
      if (!live()) return;
      current.unlisten();
      current.processor.port.close();
      take.current = null;
      setDownload(null);
      setPartial(NO_PARTIAL);
      if (!text) return move({ type: "fail", error: ERRORS["no-speech"] });
      move({ type: "done" });
      deliver.current(text, current.anchor);
    } catch (error) {
      if (live()) fail({ kind: "failed", message: ipcErrorMessage(error) || ERRORS.failed.message });
    }
  }, [fail, move]);

  const start = useCallback(
    async (anchor: DictationAnchor) => {
      if (phase.current.phase !== "idle") return;
      move({ type: "start" });
      setPartial(NO_PARTIAL);
      const id = (counter.current += 1);
      let stream: MediaStream | null = null;
      let audio: AudioContext | null = null;
      let unlisten = () => {};
      const live = () => counter.current === id;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
        if (!live()) return void stream.getTracks().forEach((track) => track.stop());
        let vocabulary: string[] = [];
        void bridge
          .dictationContext({ cwd })
          .then((context) => {
            vocabulary = context.terms;
          })
          .catch(() => []);
        unlisten = window.milagre.dictation.onProgress((progress) => {
          if (live()) setDownload(progress.received < progress.total ? progress : null);
        });
        // Download and initialize during capture, rather than after Stop.
        const prepared = window.milagre.dictation.prepare();
        prepared.catch(() => {});
        // Chromium's silent sink renders the capture graph without opening the speakers or depending on an output device.
        const options: AudioContextOptions & { sinkId: { type: "none" } } = { sampleRate: DICTATION_SAMPLE_RATE, sinkId: { type: "none" } };
        audio = new AudioContext(options);
        await audio.audioWorklet.addModule(captureWorklet);
        await audio.resume();
        if (!live()) {
          unlisten();
          stream.getTracks().forEach((track) => track.stop());
          closeAudio(audio);
          return;
        }
        const source = audio.createMediaStreamSource(stream);
        const analyser = audio.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        const processor = new AudioWorkletNode(audio, "dictation-capture");
        const resample = createDictationResampler();
        const transcript = createStreamingDictation({
          transcribe: async (pcm) => {
            await prepared;
            if (!live()) return "";
            const result = await window.milagre.dictation.transcribe({
              audio: pcm,
              language: whisperLanguage(dictationLanguage),
              prompt: whisperPrompt(vocabulary, dictationLanguage),
            });
            return result.text;
          },
          onPartial: (text, settled) => {
            if (live()) setPartial({ text, settled });
          },
        });
        let finished: (() => void) | null = null;
        processor.port.addEventListener("message", ({ data }: MessageEvent<Float32Array | string>) => {
          if (data === "finished") return finished?.();
          if (data instanceof Float32Array && live()) transcript.append(resample(data, audio!.sampleRate));
        });
        processor.port.start();
        const current: Take = {
          id,
          anchor,
          stream,
          audio,
          processor,
          transcript,
          unlisten,
          limit: null,
          finishCapture: () =>
            new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error("The microphone did not finish recording.")), 2000);
              finished = () => {
                clearTimeout(timeout);
                resolve();
              };
              processor.port.postMessage("finish", []);
            }),
        };
        take.current = current;
        source.connect(processor);
        processor.connect(audio.destination);
        processor.addEventListener("processorerror", () => {
          if (live()) fail(ERRORS.failed);
        });
        move({ type: "recording" });
        const samples = new Float32Array(analyser.fftSize);
        const frame = () => {
          if (take.current !== current || phase.current.phase !== "recording") return meter.current?.style.setProperty("--level", "0");
          analyser.getFloatTimeDomainData(samples);
          const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
          meter.current?.style.setProperty("--level", meterLevel(20 * Math.log10(rms || 1e-9)).toFixed(3));
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        current.limit = setTimeout(() => {
          if (take.current === current) void stop();
        }, RECORDING_LIMIT_SECONDS * 1000);
      } catch (error) {
        unlisten();
        stream?.getTracks().forEach((track) => track.stop());
        if (audio) closeAudio(audio);
        if (live()) fail(error instanceof DOMException && error.name === "NotAllowedError" ? ERRORS.permission : ERRORS.failed);
      }
    },
    [bridge, cwd, dictationLanguage, fail, move, stop],
  );

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
    setPartial(NO_PARTIAL);
  }, [cwd, scope]);

  useEffect(() => {
    if (state.phase !== "preparing") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.phase, cancel]);

  return {
    phase: state.phase,
    error: state.error,
    download,
    partial,
    meter,
    start,
    stop,
    cancel,
    dismiss: useCallback(() => move({ type: "dismiss" }), [move]),
    openSettings: useCallback(() => {
      move({ type: "dismiss" });
      void window.milagre.dictation.openSettings();
    }, [move]),
  };
}
