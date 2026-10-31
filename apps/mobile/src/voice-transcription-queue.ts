// Apple's file recognizer cannot be interrupted. A cancelled take keeps its native call until it settles; the next
// take's prepare/inference waits here, so two hooks never enter the native recognizer at the same time.
let tail: Promise<unknown> = Promise.resolve();

export function serializeTranscription<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work);
  tail = next.catch(() => {});
  return next;
}
