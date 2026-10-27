import { useEffect, useState } from "react";
import { computerOfKey } from "@milagre/shared/chat-scopes";
import { bridgeForKey, isRemoteKey } from "./computer-bridge.ts";

// Images of a remote chat, read through media:read and kept as data URLs while recent: thumbnails, the lightbox and
// the image menus show the same bytes. What's kept is bounded by its size (a data URL's length), least recently used
// out first. Each read is a round trip to the other Mac, so a read that failed (an image refused or gone) is remembered
// for FAILED_MS and not asked for again on every mount; the next look after that tries again. At most MAX_READS reads
// per computer are on their way at once, and the one asked for last goes first: a Chat paints its latest turns last,
// at the bottom, where it opens, so the images nearest the screen are read first.
export const MAX_KEPT_BYTES = 64 * 1024 * 1024;
export const FAILED_MS = 60_000;
export const MAX_READS = 6;
const MAX_FAILURES = 256;
const reads = new Map<string, { read: Promise<string>; bytes: number }>();
let kept = 0;
const failures = new Map<string, { at: number; error: unknown }>();
// Per computer, the reads on their way and the ones waiting for a slot.
type Queue = { running: number; waiting: Array<() => void>; draining: boolean };
const queues = new Map<string, Queue>();

const forget = (key: string) => {
  const entry = reads.get(key);
  if (!entry) return;
  kept -= entry.bytes;
  reads.delete(key);
};

/** Starts the reads waiting for a free slot, the one asked for last first. */
function drain(queue: Queue) {
  while (queue.running < MAX_READS && queue.waiting.length) {
    queue.running++;
    queue.waiting.pop()!();
  }
}

/**
 * Runs `read` once one of its computer's MAX_READS slots is free, the read asked for last first. The first ones wait a
 * microtask, so every image a render asks for (a Chat's messages mount top to bottom) is queued before any starts.
 */
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
  if (failed && Date.now() - failed.at < FAILED_MS) return Promise.reject(failed.error);
  failures.delete(key);
  const entry = { read: Promise.resolve(""), bytes: 0 };
  entry.read = inTurn(computerOfKey(scope), () => bridgeForKey(scope).readMedia({ scope, path })).then((media) => {
    const url = `data:${media.type};base64,${media.base64}`;
    if (reads.get(key) === entry) {
      entry.bytes = url.length;
      kept += url.length;
      // The newest read stays even when it alone is over the bound.
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
    failures.set(key, { at: Date.now(), error });
    for (const [oldest] of failures) {
      if (failures.size <= MAX_FAILURES) break;
      failures.delete(oldest);
    }
  });
  return entry.read;
}

type Loaded = { scope: string | null; sources: Record<string, string>; failed: Record<string, true> };

/**
 * Each path's data URL once read, for a remote scope; nothing for this Mac's, whose chats use milagre-media://.
 * `failed` names the paths whose read was refused or failed.
 */
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
  // Another scope's images never show under this one.
  return loaded.scope === scope ? loaded : { sources: {}, failed: {} };
}
