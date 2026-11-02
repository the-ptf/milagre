import { useCallback, useEffect, useRef, useState } from "react";
import captureWorklet from "../lib/dictation-worklet.js?url&no-inline";
import { VOCABULARY_WAIT_MS, fixUpModelName, snapTerms, whisperLanguage, whisperModelFor, whisperPrompt } from "@milagre/shared/dictation";
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
import { useDictationModels } from "./useDictationModels";

export type DictationAnchor = { selection: Selection };

/** A finished take's fix-up: the model's short name for the status line, and its answer, which never rejects. */
export type DictationCorrection = { model: string; text: Promise<string> };

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
  /** The fix-up of the take's final words, or null when Settings turns it off. */
  fixUp: ((text: string) => DictationCorrection) | null;
  finishCapture: () => Promise<void>;
  limit: ReturnType<typeof setTimeout> | null;
};

function closeAudio(audio: AudioContext) {
  if (audio.state !== "closed") void audio.close().catch(() => {});
}

/**
 * Local PCM capture and partial inference while speaking. Only the final transcript edits or sends the draft. A take whose
 * model isn't on this computer yet downloads it first (`downloading`, with `download` progress) and records once it lands.
 */
export function useDictation(
  cwd: string,
  scope: string,
  /** The final transcript, and its fix-up when Settings has it on. */
  onTranscript: (text: string, anchor: DictationAnchor, correction: DictationCorrection | null) => void,
  /** The Chat dictated into (its Project scope and id): the names its last turns used guide the recognizer. */
  chat: { scope?: string; chatId?: number; provider?: string } = {},
) {
  const bridge = useBridge();
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const { dictationLanguage, dictationModel, dictationFixUp, dictationFixModel } = useSettings();
  const model = whisperModelFor("desktop", dictationModel);
  const models = useDictationModels();
  const [state, setState] = useState<Dictation>(IDLE);
  const [partial, setPartial] = useState<DictationPartial>(NO_PARTIAL);
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
    if (current.limit) clearTimeout(current.limit);
    current.processor.port.close();
    current.processor.disconnect();
    for (const track of current.stream.getTracks()) track.stop();
    closeAudio(current.audio);
  }, []);

  const cancel = useCallback(() => {
    // Cancelling while the model downloads stops the download too: the take was the only reason for it.
    if (phase.current.phase === "downloading") void window.milagre.dictation.cancel(model.id).catch(() => {});
    counter.current += 1;
    abandon();
    setPartial(NO_PARTIAL);
    move({ type: "done" });
  }, [abandon, model.id, move]);

  const fail = useCallback(
    (error: DictationError) => {
      abandon();
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
      current.processor.port.close();
      take.current = null;
      setPartial(NO_PARTIAL);
      if (!text) return move({ type: "fail", error: ERRORS["no-speech"] });
      move({ type: "done" });
      deliver.current(text, current.anchor, current.fixUp?.(text) ?? null);
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
      const live = () => counter.current === id;
      const language = whisperLanguage(dictationLanguage, model);
      try {
        // The model downloads before the microphone opens: nothing is recorded that would wait minutes for it.
        const status = await window.milagre.dictation.status();
        if (!live()) return;
        if (!status.find((item) => item.id === model.id)?.ready) {
          move({ type: "download" });
          try {
            await window.milagre.dictation.download(model.id);
          } catch (error) {
            if (live()) fail({ kind: "failed", message: ipcErrorMessage(error) || ERRORS.failed.message });
            return;
          }
          if (!live()) return;
          move({ type: "downloaded" });
        }
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
        if (!live()) return void stream.getTracks().forEach((track) => track.stop());
        let vocabulary: string[] = [];
        const terms = bridge
          .dictationContext({ cwd, scope: chatRef.current.scope || undefined, chatId: chatRef.current.chatId })
          .then((context) => {
            vocabulary = context.terms;
          })
          .catch(() => {});
        // The first inference waits briefly for the project's words; a slow or offline computer doesn't hold it up.
        const vocabularyReady = Promise.race([terms, new Promise((resolve) => setTimeout(resolve, VOCABULARY_WAIT_MS))]);
        // Load the model during capture, rather than after Stop.
        const prepared = window.milagre.dictation.prepare(model.id);
        prepared.catch(() => {});
        // Chromium's silent sink renders the capture graph without opening the speakers or depending on an output device.
        const options: AudioContextOptions & { sinkId: { type: "none" } } = { sampleRate: DICTATION_SAMPLE_RATE, sinkId: { type: "none" } };
        audio = new AudioContext(options);
        await audio.audioWorklet.addModule(captureWorklet);
        await audio.resume();
        if (!live()) {
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
            await Promise.all([prepared, vocabularyReady]);
            if (!live()) return "";
            const result = await window.milagre.dictation.transcribe({
              audio: pcm,
              language,
              prompt: whisperPrompt(vocabulary, language),
              model: model.id,
            });
            return snapTerms(result.text, vocabulary);
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
          // A computer without the fix-up (an older paired Mac) leaves the words as heard.
          fixUp: dictationFixUp
            ? (text) => ({
                model: fixUpModelName(dictationFixModel, chatRef.current.provider),
                text: Promise.resolve()
                  .then(() =>
                    bridge.polishDictation({
                      cwd,
                      text,
                      provider: chatRef.current.provider,
                      model: dictationFixModel,
                      scope: chatRef.current.scope || undefined,
                      chatId: chatRef.current.chatId,
                    }),
                  )
                  .then(
                    (result) => snapTerms(result?.text || text, vocabulary),
                    () => text,
                  ),
              })
            : null,
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
        stream?.getTracks().forEach((track) => track.stop());
        if (audio) closeAudio(audio);
        if (live()) fail(error instanceof DOMException && error.name === "NotAllowedError" ? ERRORS.permission : ERRORS.failed);
      }
    },
    [bridge, cwd, dictationFixModel, dictationFixUp, dictationLanguage, fail, model, move, stop],
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
    setPartial(NO_PARTIAL);
  }, [cwd, scope]);

  useEffect(() => {
    if (state.phase !== "preparing" && state.phase !== "downloading") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.phase, cancel]);

  const downloading = models[model.id]?.received;
  return {
    phase: state.phase,
    error: state.error,
    /** How far the take's model download is, while the take waits on it. */
    download: state.phase === "downloading" ? { received: downloading ?? 0, total: model.size } : null,
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
