import { useCallback, useEffect, useRef, useState } from "react";
import captureWorklet from "../lib/dictation-worklet.js?url&no-inline";
import { recognitionVocabulary, fixUpModelName, whisperLanguage, whisperModelFor, whisperPrompt } from "@milagre/shared/dictation";
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

export type DictationAnchor = { selection: Selection; draft?: string; attachments?: string[]; quotes?: string[] };

export type DictationCorrection = { model: string; text: Promise<string> };

export type DictationPartial = { text: string; settled: number };

const NO_PARTIAL: DictationPartial = { text: "", settled: 0 };

type Take = {
  id: number;
  anchor: DictationAnchor;
  stream: MediaStream;
  audio: AudioContext;
  processor: AudioWorkletNode;
  transcript: StreamingDictation;
  format: (text: string) => string;
  fixUp: ((text: string) => DictationCorrection) | null;
  finishCapture: () => Promise<void>;
  limit: ReturnType<typeof setTimeout> | null;
};

function closeAudio(audio: AudioContext) {
  if (audio.state !== "closed") void audio.close().catch(() => {});
}

export function useDictation(
  cwd: string,
  scope: string,
  onTranscript: (text: string, anchor: DictationAnchor, correction: DictationCorrection | null) => void,
  chat: { scope?: string; chatId?: number; provider?: string } = {},
) {
  const bridge = useBridge();
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const { dictationSymbols: symbols, dictationLanguage, dictationModel, dictationFixUp, dictationFixModel } = useSettings();
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
      const formatted = current.format(text);
      const correction = current.fixUp?.(text) ?? null;
      deliver.current(formatted, current.anchor, correction);
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
        const vocabulary = recognitionVocabulary(
          anchor,
          bridge.dictationContext({ cwd, scope: chatRef.current.scope || undefined, chatId: chatRef.current.chatId }),
          symbols,
        );
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
            await prepared;
            if (!live()) return "";
            const result = await window.milagre.dictation.transcribe({
              audio: pcm,
              language,
              prompt: whisperPrompt(vocabulary.terms, language),
              model: model.id,
            });
            return vocabulary.preview(result.text);
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
          format: vocabulary.format,
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
                    (result) => vocabulary.format(result?.text || text),
                    () => vocabulary.format(text),
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
        showMeter(analyser, meter, () => take.current === current && phase.current.phase === "recording");
        current.limit = setTimeout(() => {
          if (take.current === current) void stop();
        }, RECORDING_LIMIT_SECONDS * 1000);
      } catch (error) {
        stream?.getTracks().forEach((track) => track.stop());
        if (audio) closeAudio(audio);
        if (live()) fail(error instanceof DOMException && error.name === "NotAllowedError" ? ERRORS.permission : ERRORS.failed);
      }
    },
    [bridge, cwd, dictationFixModel, dictationFixUp, dictationLanguage, fail, model, move, stop, symbols],
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
    download: state.phase === "downloading" ? { received: downloading ?? 0, total: model.size } : null,
    partial,
    setMeter: useCallback((node: HTMLElement | null) => {
      meter.current = node;
    }, []),
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

function showMeter(analyser: AnalyserNode, meter: { current: HTMLElement | null }, recording: () => boolean) {
  const samples = new Float32Array(analyser.fftSize);
  const frame = () => {
    if (!recording()) return meter.current?.style.setProperty("--level", "0");
    analyser.getFloatTimeDomainData(samples);
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    meter.current?.style.setProperty("--level", meterLevel(20 * Math.log10(rms || 1e-9)).toFixed(3));
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
