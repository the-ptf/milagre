import { useEffect, useState } from "react";
import { computerOfKey } from "@milagre/shared/chat-scopes";
import { retryKind } from "@milagre/shared/send-retry";
import { bridgeForKey, isRemoteKey } from "./computer-bridge.ts";

export const MAX_KEPT_BYTES = 64 * 1024 * 1024;
export const FAILED_MS = 60_000;
export const TRIED_MS = 5_000;
export const MAX_READS = 6;
const UNANSWERED = /offline|reach|answering another|too many|busy|timed out|took too long|disconnected|not sent|closed|closing/i;
const unanswered = (error: unknown) => retryKind(error) !== null || UNANSWERED.test(error instanceof Error ? error.message : String(error));
const MAX_FAILURES = 256;
const reads = new Map<string, { read: Promise<string>; bytes: number }>();
let kept = 0;
const failures = new Map<string, { until: number; error: unknown }>();
type Queue = { running: number; waiting: Array<() => void>; draining: boolean };
const queues = new Map<string, Queue>();

const forget = (key: string) => {
  const entry = reads.get(key);
  if (!entry) return;
  kept -= entry.bytes;
  reads.delete(key);
};

function drain(queue: Queue) {
  while (queue.running < MAX_READS && queue.waiting.length) {
    queue.running++;
    queue.waiting.pop()!();
  }
}

async function inTurn<T>(computerId: string, read: () => Promise<T>): Promise<T> {
  let queue = queues.get(computerId);
  if (!queue) queues.set(computerId, (queue = { running: 0, waiting: [], draining: false }));
  const own = queue;
  await new Promise<void>((resolve) => {
    own.waiting.push(resolve);
    if (own.draining) return;
    own.draining = true;
    queueMicrotask(() => {
      own.draining = false;
      drain(own);
    });
  });
  try {
    return await read();
  } finally {
    own.running--;
    drain(own);
  }
}

export function remoteImageDataUrl(scope: string, path: string): Promise<string> {
  const key = JSON.stringify([scope, path]);
  const known = reads.get(key);
  if (known) {
    reads.delete(key);
    reads.set(key, known);
    return known.read;
  }
  const failed = failures.get(key);
  if (failed && Date.now() < failed.until) return Promise.reject(failed.error);
  failures.delete(key);
  const entry = { read: Promise.resolve(""), bytes: 0 };
  entry.read = inTurn(computerOfKey(scope), () => bridgeForKey(scope).readMedia({ scope, path })).then((media) => {
    const url = `data:${media.type};base64,${media.base64}`;
    if (reads.get(key) === entry) {
      entry.bytes = url.length;
      kept += url.length;
      for (const [oldest] of reads) {
        if (kept <= MAX_KEPT_BYTES || oldest === key) break;
        forget(oldest);
      }
    }
    return url;
  });
  reads.set(key, entry);
  entry.read.catch((error: unknown) => {
    if (reads.get(key) !== entry) return;
    forget(key);
    failures.set(key, { until: Date.now() + (unanswered(error) ? TRIED_MS : FAILED_MS), error });
    for (const [oldest] of failures) {
      if (failures.size <= MAX_FAILURES) break;
      failures.delete(oldest);
    }
  });
  return entry.read;
}

type Loaded = { scope: string | null; sources: Record<string, string>; failed: Record<string, true> };

export function useRemoteMedia(scope: string | null, paths: string[]): { sources: Record<string, string>; failed: Record<string, true> } {
  const [loaded, setLoaded] = useState<Loaded>({ scope: null, sources: {}, failed: {} });
  const wanted = JSON.stringify(paths);
  useEffect(() => {
    if (!scope || !isRemoteKey(scope)) return;
    let live = true;
    for (const path of JSON.parse(wanted) as string[])
      void remoteImageDataUrl(scope, path).then(
        (src) => {
          if (live)
            setLoaded((previous) => {
              const base = previous.scope === scope ? previous : { scope, sources: {}, failed: {} };
              return base.sources[path] === src ? base : { ...base, sources: { ...base.sources, [path]: src } };
            });
        },
        () => {
          if (live)
            setLoaded((previous) => {
              const base = previous.scope === scope ? previous : { scope, sources: {}, failed: {} };
              return base.failed[path] ? base : { ...base, failed: { ...base.failed, [path]: true } };
            });
        },
      );
    return () => {
      live = false;
    };
  }, [scope, wanted]);
  return loaded.scope === scope ? loaded : { sources: {}, failed: {} };
}
