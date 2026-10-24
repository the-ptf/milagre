// The lifecycle of one microphone take, free of the native audio module so it can be driven by a test. A take can be
// cancelled at any point of its start; whatever it had allocated by then is released before `discard` resolves, and
// the next take waits for every earlier one to finish releasing the audio session before it activates it again.
import { meterLevel } from "./voice-dictation.ts";

export type RecorderStatus = { hasError?: boolean; mediaServicesDidReset?: boolean; isFinished?: boolean; metering?: number };

/** The slice of the native recorder a take uses. */
export type RecorderLike = {
  readonly uri: string | null;
  readonly isRecording: boolean;
  addListener(event: "recordingStatusUpdate", listener: (status: RecorderStatus) => void): { remove(): void };
  prepareToRecordAsync(): Promise<void>;
  record(options: { forDuration: number }): void;
  getStatus(): { metering?: number };
  stop(): Promise<void>;
  release(): void;
};

/** What a take needs from the phone: the audio session, a recorder, and deleting a file. */
export type AudioPort = {
  /** Puts the audio session in recording mode. */
  configure(): Promise<void>;
  /** Activates the audio session. */
  activate(): Promise<void>;
  /** Leaves recording mode and deactivates the session, so music that was playing resumes. */
  deactivate(): Promise<void>;
  createRecorder(): RecorderLike;
  deleteFile(path: string): void;
};

/** Every take's disposal in progress, so a take that starts next can wait for the ones before it. */
export function createTakeLock() {
  const pending = new Set<Promise<unknown>>();
  return {
    track<T>(work: Promise<T>): Promise<T> {
      pending.add(work);
      const forget = () => pending.delete(work);
      work.then(forget, forget);
      return work;
    },
    /** What is being released now; later work does not count, so a take never waits on its own disposal. */
    snapshot: () => [...pending],
  };
}
export type TakeLock = ReturnType<typeof createTakeLock>;

/**
 * One microphone take. The native recorder exists only between `start` and `discard`/`finish`, so a composer that never
 * dictates never builds one.
 */
export class VoiceTake {
  private recorder: RecorderLike | null = null;
  private listener: { remove(): void } | null = null;
  /** The audio session was claimed (or is being) and has not been given back. */
  private audio = false;
  private cancelled = false;
  private starting: Promise<unknown> | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  private readonly port: AudioPort;
  private readonly lock: TakeLock;
  private readonly limitSeconds: number;

  constructor(port: AudioPort, lock: TakeLock, limitSeconds: number) {
    this.port = port;
    this.lock = lock;
    this.limitSeconds = limitSeconds;
  }

  /** Resolves true once recording, false when the take was cancelled on the way (everything it had is already released). */
  start(onStatus: (status: RecorderStatus) => void): Promise<boolean> {
    // Taken now, not when the first await ends: later disposals belong to takes that come after this one.
    const before = this.lock.snapshot();
    const run = this.begin(before, onStatus);
    this.starting = run;
    return run;
  }

  private async begin(before: Promise<unknown>[], onStatus: (status: RecorderStatus) => void): Promise<boolean> {
    try {
      await Promise.allSettled(before);
      if (await this.stopIfCancelled()) return false;
      this.audio = true;
      await this.port.configure();
      if (await this.stopIfCancelled()) return false;
      await this.port.activate();
      if (await this.stopIfCancelled()) return false;
      const recorder = this.port.createRecorder();
      this.recorder = recorder;
      this.listener = recorder.addListener("recordingStatusUpdate", onStatus);
      await recorder.prepareToRecordAsync();
      if (await this.stopIfCancelled()) return false;
      recorder.record({ forDuration: this.limitSeconds });
      return true;
    } catch (error) {
      await this.teardown({ deleteFile: true });
      throw error;
    }
  }

  private async stopIfCancelled() {
    if (!this.cancelled) return false;
    await this.teardown({ deleteFile: true });
    return true;
  }

  /** The mic level now, 0..1. */
  level() {
    try {
      return meterLevel(this.recorder?.getStatus().metering);
    } catch {
      return 0;
    }
  }

  /**
   * Stops recording and returns the file, which the caller reads and then passes to `discard`. The recorder and the audio
   * session are released here: transcribing only needs the file, and a later `discard` must not touch the session.
   */
  finish(): Promise<string | null> {
    return this.queue(async () => {
      const recorder = this.recorder;
      if (!recorder) return null;
      await recorder.stop();
      const uri = recorder.uri;
      await this.teardown({ deleteFile: false });
      return uri;
    });
  }

  /**
   * Ends the take: a start still under way is waited for and undone, the recorder and the audio session are released and
   * the recording at `uri` (and the recorder's own file) is deleted. Resolves once all of it is done.
   */
  discard(uri?: string | null): Promise<void> {
    this.cancelled = true;
    return this.queue(async () => {
      await this.starting?.catch(() => {});
      await this.teardown({ deleteFile: true, uri });
    });
  }

  private queue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.catch(() => {});
    return this.lock.track(run);
  }

  private async teardown({ deleteFile, uri }: { deleteFile: boolean; uri?: string | null }) {
    const recorder = this.recorder;
    const listener = this.listener;
    const audio = this.audio;
    this.recorder = null;
    this.listener = null;
    this.audio = false;
    listener?.remove();
    let file = uri ?? null;
    if (recorder) {
      try {
        file ??= recorder.uri;
      } catch {}
      try {
        if (recorder.isRecording) await recorder.stop();
      } catch {}
      try {
        recorder.release();
      } catch {}
    }
    if (deleteFile && file) {
      try {
        this.port.deleteFile(file);
      } catch {}
    }
    if (audio) {
      try {
        await this.port.deactivate();
      } catch {}
    }
  }
}

/** The one microphone of the app: whoever claims it ends the take of the previous holder. */
export function createMicrophone() {
  let holder: { owner: symbol; cancel: () => Promise<void> } | null = null;
  return {
    /** Claims the microphone; resolves once the previous holder's take is gone and its audio session given back. */
    claim(owner: symbol, cancel: () => Promise<void>): Promise<void> {
      const previous = holder && holder.owner !== owner ? holder.cancel() : Promise.resolve();
      holder = { owner, cancel };
      return previous.catch(() => {});
    },
    release(owner: symbol) {
      if (holder?.owner === owner) holder = null;
    },
  };
}
