// The lifecycle of one microphone take, free of the native audio module so it can be driven by a test. A take can be
import { meterLevel } from "@milagre/shared/voice-dictation";

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

export type AudioPort = {
  configure(): Promise<void>;
  activate(): Promise<void>;
  deactivate(): Promise<void>;
  createRecorder(): RecorderLike;
  deleteFile(path: string): void;
};

export function createTakeLock() {
  const pending = new Set<Promise<unknown>>();
  return {
    track<T>(work: Promise<T>): Promise<T> {
      pending.add(work);
      const forget = () => pending.delete(work);
      work.then(forget, forget);
      return work;
    },
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

  start(onStatus: (status: RecorderStatus) => void): Promise<boolean> {
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
        file ??= recorder.uri;
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

export function createMicrophone() {
  let holder: { owner: symbol; cancel: () => Promise<void> } | null = null;
  return {
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
