import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { tap } from "./primitives/tap";
import { VOCABULARY_WAIT_MS, fixUpModelName, snapTerms, whisperModelFor } from "@milagre/shared/dictation";
import {
  ERRORS,
  IDLE,
  METERING_INTERVAL_MS,
  createStreamingDictation,
  dictationReducer,
  type Dictation,
  type DictationAction,
  type Selection,
  type StreamingDictation,
} from "@milagre/shared/voice-dictation";
import { askForMicrophone, newVoiceTake, type VoiceTake } from "./voice-recorder";
import { createMicrophone } from "./voice-take";
import { getTranscriber } from "./voice-transcription";
import { cancelWhisperModel, downloadWhisperModel, useWhisperModels } from "./voice-transcription-whisper";
import { useDictationFixModel, useDictationFixUp, useDictationLanguage, useDictationModel } from "./chat-display-setting";
import type { Client } from "./client";

/** Where the transcript goes: the draft and caret as they were when the mic was tapped. */
export type DictationAnchor = { draft: string; selection: Selection };

export type DictationCorrection = { model: string; text: Promise<string> };

export type DictationPartial = { text: string; settled: number };

const NO_PARTIAL: DictationPartial = { text: "", settled: 0 };

export type DictationChat = { client: Client; cwd: string; chatTitle?: string; provider?: string; chatId?: number };

const microphone = createMicrophone();

/**
 * Speech is transcribed locally while recording; tap again to finish. `onTranscript` gets the final text, its anchor and
 * its optional fix-up: misheard names corrected by the Mac using the chosen model. Its promise never rejects.
 * With a `chat`, the project's words go straight to the recognizer.
 * Backgrounding the app, leaving the screen or a recorder failure throws the take away. `available` is false where the phone
 * cannot transcribe on device (a build without a usable native recognizer). A take whose Whisper model isn't on the phone
 * yet downloads it first (`downloading`) and records once it lands; `download` is how far that download is, 0..1, or null.
 */
export function useVoiceDictation(onTranscript: (text: string, anchor: DictationAnchor, correction: DictationCorrection | null) => void, chat?: DictationChat) {
  const [transcriber] = useState(getTranscriber);
  const [owner] = useState(Symbol);
  const [state, setState] = useState<Dictation>(IDLE);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [partial, setPartial] = useState<DictationPartial>(NO_PARTIAL);
  const [language] = useDictationLanguage();
  const [model] = useDictationModel();
  const [fixUpEnabled] = useDictationFixUp();
  const [fixModel] = useDictationFixModel();
  const models = useWhisperModels();
  const fetching = useRef<{ id: number; model: string } | null>(null);
  const level = useSharedValue(0);
  const phase = useRef<Dictation>(IDLE);
  const take = useRef<{
    id: number;
    recorder: VoiceTake;
    stream: StreamingDictation;
    anchor: DictationAnchor;
    prepared: Promise<void>;
    fixUp: ((text: string) => DictationCorrection) | null;
  } | null>(null);
  const counter = useRef(0);
  const meter = useRef<ReturnType<typeof setInterval> | null>(null);
  const deliver = useRef(onTranscript);
  const chatRef = useRef(chat);
  useEffect(() => {
    deliver.current = onTranscript;
    chatRef.current = chat;
  });

  const move = useCallback((action: DictationAction) => {
    phase.current = dictationReducer(phase.current, action);
    setState(phase.current);
  }, []);

  const stopMeter = useCallback(() => {
    if (meter.current) clearInterval(meter.current);
    meter.current = null;
    level.set(0);
  }, [level]);

  const release = useCallback(() => {
    microphone.release(owner);
  }, [owner]);

  const abandon = useCallback(
    (uri?: string | null): Promise<void> => {
      const current = take.current;
      take.current = null;
      release();
      counter.current += 1;
      stopMeter();
      current?.stream.cancel();
      setPartial(NO_PARTIAL);
      return current ? current.recorder.discard(uri) : Promise.resolve();
    },
    [release, stopMeter],
  );

  const cancel = useCallback((): Promise<void> => {
    const waiting = fetching.current;
    if (waiting) {
      fetching.current = null;
      cancelWhisperModel(waiting.model);
      counter.current += 1;
      release();
      setDownloading(null);
      move({ type: "done" });
      return Promise.resolve();
    }
    if (!take.current) return Promise.resolve();
    const gone = abandon();
    move({ type: "done" });
    return gone;
  }, [abandon, move, release]);

  const fail = useCallback(
    (error: (typeof ERRORS)[keyof typeof ERRORS]) => {
      void abandon();
      move({ type: "fail", error });
    },
    [abandon, move],
  );

  const stop = useCallback(async () => {
    const current = take.current;
    if (!current || phase.current.phase !== "recording") return;
    tap();
    move({ type: "stop" });
    stopMeter();
    let uri: string | null = null;
    let reason: string = ERRORS.failed.message;
    try {
      uri = await current.recorder.finish();
      release();
      await current.prepared.catch((error: unknown) => {
        if (error instanceof Error && error.message) reason = error.message;
        throw error;
      });
      if (take.current?.id !== current.id) return void current.recorder.discard(uri);
      const text = await current.stream.finish();
      if (take.current?.id !== current.id) return void current.recorder.discard(uri);
      take.current = null;
      setPartial(NO_PARTIAL);
      void current.recorder.discard(uri);
      if (!text) return move({ type: "fail", error: ERRORS["no-speech"] });
      move({ type: "done" });
      deliver.current(text, current.anchor, current.fixUp?.(text) ?? null);
    } catch {
      if (take.current?.id !== current.id) return void current.recorder.discard(uri);
      take.current = null;
      current.stream.cancel();
      setPartial(NO_PARTIAL);
      release();
      void current.recorder.discard(uri);
      move({ type: "fail", error: { kind: "failed", message: reason } });
    }
  }, [move, release, stopMeter]);

  const start = useCallback(
    async (anchor: DictationAnchor) => {
      if (!transcriber || phase.current.phase !== "idle") return;
      tap();
      const handoff = microphone.claim(owner, cancel);
      move({ type: "start" });
      const id = (counter.current += 1);
      setPartial(NO_PARTIAL);
      const missing = transcriber.missingModel(language, model);
      if (missing) {
        fetching.current = { id, model: missing };
        setDownloading(missing);
        move({ type: "download" });
        try {
          await downloadWhisperModel(missing);
        } catch (error) {
          if (fetching.current?.id !== id) return;
          fetching.current = null;
          setDownloading(null);
          release();
          return move({ type: "fail", error: { kind: "failed", message: error instanceof Error && error.message ? error.message : ERRORS.failed.message } });
        }
        if (fetching.current?.id !== id) return;
        fetching.current = null;
        setDownloading(null);
        move({ type: "downloaded" });
      }
      const prepared = transcriber.prepare(language, model);
      prepared.catch(() => {});
      const target = chatRef.current;
      const terms = target?.cwd
        ? target.client
            .call<{ terms: string[] }>("dictation:context", [
              { cwd: target.cwd, chatTitle: target.chatTitle, ...(target.chatId === undefined ? {} : { scope: target.cwd, chatId: target.chatId }) },
            ])
            .then(
              (result) => result?.terms ?? [],
              () => [],
            )
        : Promise.resolve([]);
      let vocabulary: string[] = [];
      const known = terms.then((words) => {
        vocabulary = words;
      });
      const vocabularyReady = Promise.race([known, new Promise((resolve) => setTimeout(resolve, VOCABULARY_WAIT_MS))]);
      const stream = createStreamingDictation({
        transcribe: async (audio) => {
          await Promise.all([prepared, vocabularyReady]);
          if (take.current?.id !== id) return "";
          return snapTerms(await transcriber.transcribe(audio, { language, terms: vocabulary, model }), vocabulary);
        },
        onPartial: (text, settled) => {
          if (take.current?.id === id) setPartial({ text, settled });
        },
      });
      const recorder = newVoiceTake((pcm) => stream.append(pcm));
      const fixUp =
        fixUpEnabled && target?.cwd
          ? (text: string): DictationCorrection => ({
              model: fixUpModelName(fixModel, target.provider),
              text: Promise.resolve()
                .then(() =>
                  target.client.call<{ text: string }>("dictation:polish", [
                    {
                      cwd: target.cwd,
                      text,
                      chatTitle: target.chatTitle,
                      provider: target.provider,
                      model: fixModel,
                      ...(target.chatId === undefined ? {} : { scope: target.cwd, chatId: target.chatId }),
                    },
                  ]),
                )
                .then(
                  (result) => snapTerms(result?.text || text, vocabulary),
                  () => text,
                ),
            })
          : null;
      take.current = { id, recorder, stream, anchor, prepared, fixUp };
      const live = () => take.current?.id === id;
      try {
        const permission = await askForMicrophone();
        if (!live()) return;
        if (!permission.granted) return fail(ERRORS.permission);
        await handoff;
        if (!live()) return;
        const recording = await recorder.start((status) => {
          if (!live()) return;
          if (status.hasError || status.mediaServicesDidReset) fail(ERRORS.failed);
          else if (status.isFinished) void stop();
        });
        if (!recording || !live()) return;
        move({ type: "recording" });
        meter.current = setInterval(() => {
          level.set(recorder.level());
        }, METERING_INTERVAL_MS);
      } catch {
        if (live()) fail(ERRORS.failed);
      }
    },
    [cancel, fail, fixModel, fixUpEnabled, language, level, model, move, owner, release, stop, transcriber],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      // iOS reports `inactive` while its permission dialog is up; only a real background throws the take away.
      if (next !== "background") return;
      const { phase: current } = phase.current;
      if (current === "preparing" || current === "recording") fail(ERRORS.interrupted);
    });
    return () => subscription.remove();
  }, [fail]);

  useEffect(
    () => () => {
      if (fetching.current) cancelWhisperModel(fetching.current.model);
      fetching.current = null;
      void abandon();
    },
    [abandon],
  );

  const received = downloading ? models[downloading]?.received : null;
  return {
    available: transcriber !== null,
    phase: state.phase,
    error: state.error,
    download: state.phase === "downloading" && downloading ? (received ?? 0) / whisperModelFor("phone", downloading).size : null,
    partial,
    level,
    start,
    stop,
    cancel,
    dismiss: useCallback(() => move({ type: "dismiss" }), [move]),
  };
}
