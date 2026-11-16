const FLICK = 500;

/** Progress under the finger, kept inside what the gesture may reach. */
export function dragTo(from: number, translation: number, width: number, min: number, max: number) {
  "worklet";
  return Math.min(max, Math.max(min, from + translation / width));
}

export function entered(previous: number, next: number): "left" | "right" | null {
  "worklet";
  const side = Math.sign(next);
  if (side === 0 || side === Math.sign(previous)) return null;
  return side > 0 ? "left" : "right";
}

export function settle(from: number, progress: number, velocity: number) {
  "worklet";
  if (from === 0) {
    const side = Math.sign(progress);
    const toward = velocity * side;
    return toward > FLICK || (toward > -FLICK && Math.abs(progress) > 1 / 3) ? side : 0;
  }
  const back = -velocity * from;
  return back > FLICK || (back > -FLICK && progress * from < 2 / 3) ? 0 : from;
}
