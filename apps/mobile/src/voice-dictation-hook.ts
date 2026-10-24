import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { tap } from "./primitives/tap";
import { ERRORS, IDLE, METERING_INTERVAL_MS, dictationReducer, type Dictation, type DictationAction, type Selection } from "./voice-dictation";
import { askForMicrophone, newVoiceTake, type VoiceTake } from "./voice-recorder";
import { createMicrophone } from "./voice-take";
import { getTranscriber } from "./voice-transcription";

/** Where the transcript goes: the draft and caret as they were when the mic was tapped. */
export type DictationAnchor = { draft: string; selection: Selection };

/** The take that is preparing or recording anywhere in the app: one microphone, so starting another ends it quietly. */
const microphone = createMicrophone();

/**
 * Tap the mic to record, tap again to transcribe on the phone. `onTranscript` gets the text and the anchor the take began with.
 * Backgrounding the app, leaving the screen or a recorder failure throws the take away. `available` is false where the phone
 * cannot transcribe on device (Android, before iOS 26, a build without the native module).
 */
export function useVoiceDictation(onTranscript: (text: string, anchor: DictationAnchor) => void) {
  const [transcriber] = useState(getTranscriber);
  const [owner] = useState(Symbol);
  const [state, setState] = useState<Dictation>(IDLE);
  const level = useSharedValue(0);
  const phase = useRef<Dictation>(IDLE);
  const take = useRef<{ id: number; recorder: VoiceTake; anchor: DictationAnchor; prepared: Promise<void> } | null>(null);
  const counter = useRef(0);
  const meter = useRef<ReturnType<typeof setInterval> | null>(null);
  const deliver = useRef(onTranscript);
  useEffect(() => {
    deliver.current = onTranscript;
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

  /**
   * Ends the current take, if any: later answers from it are ignored and its recorder and file are released. The promise
   * settles once they are, audio session included.
   */
  const abandon = useCallback(
    (uri?: string | null): Promise<void> => {
      const current = take.current;
      take.current = null;
      release();
      counter.current += 1;
      stopMeter();
      return current ? current.recorder.discard(uri) : Promise.resolve();
    },
    [release, stopMeter],
  );

  /** Throws the take away without a message: the sidebar hid, or another field took the microphone. Settles once it is released. */
  const cancel = useCallback((): Promise<void> => {
    if (!take.current) return Promise.resolve();
    const gone = abandon();
    move({ type: "done" });
    return gone;
  }, [abandon, move]);

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
    try {
      uri = await current.recorder.finish();
      release();
      await current.prepared;
      if (take.current?.id !== current.id) return void current.recorder.discard(uri);
      const text = uri && transcriber ? await transcriber.transcribe(uri) : "";
      if (take.current?.id !== current.id) return void current.recorder.discard(uri);
      take.current = null;
      void current.recorder.discard(uri);
      if (!text) return move({ type: "fail", error: ERRORS["no-speech"] });
      move({ type: "done" });
      deliver.current(text, current.anchor);
    } catch {
      if (take.current?.id !== current.id) return void current.recorder.discard(uri);
      take.current = null;
      release();
      void current.recorder.discard(uri);
      move({ type: "fail", error: ERRORS.failed });
    }
  }, [move, release, stopMeter, transcriber]);

  const start = useCallback(
    async (anchor: DictationAnchor) => {
      if (!transcriber || phase.current.phase !== "idle") return;
      tap();
      // Another field's take is cancelled first; the audio session is not activated before it has been given back.
      const handoff = microphone.claim(owner, cancel);
      move({ type: "start" });
      const id = (counter.current += 1);
      const recorder = newVoiceTake();
      // The language model downloads while the user talks; the transcript waits for it, the recording does not.
      const prepared = transcriber.prepare();
      prepared.catch(() => {});
      take.current = { id, recorder, anchor, prepared };
      const live = () => take.current?.id === id;
      try {
        const permission = await askForMicrophone();
        if (!live()) return;
        if (!permission.granted) return fail(ERRORS.permission);
        await handoff;
        if (!live()) return;
        // False when the take was cancelled on the way: the recorder has already released everything it had.
        const recording = await recorder.start((status) => {
          if (!live()) return;
          if (status.hasError || status.mediaServicesDidReset) fail(ERRORS.failed);
          // The five-minute limit, a call or another app taking the microphone end the recording by themselves.
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
    [cancel, fail, level, move, owner, stop, transcriber],
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
      void abandon();
    },
    [abandon],
  );

  return {
    available: transcriber !== null,
    phase: state.phase,
    error: state.error,
    level,
    start,
    stop,
    cancel,
    dismiss: useCallback(() => move({ type: "dismiss" }), [move]),
  };
}
