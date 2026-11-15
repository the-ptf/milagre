export function afterPaint(work: () => void): () => void {
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(work);
  });
  return () => cancelAnimationFrame(frame);
}
