/** Give a committed screen a frame to paint, then run work. Cancelling also stops the second frame. */
export function afterPaint(work: () => void): () => void {
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(work);
  });
  return () => cancelAnimationFrame(frame);
}
