type Measurable = { measureInWindow: (callback: (x: number, y: number) => void) => void };

export const SEND_LAUNCH_MS = 520;
const LAUNCH_TTL_MS = 2000;

export type Point = { x: number; y: number };
type Armed = { at: number; from: Promise<Point | null> };

let armed: Armed | null = null;

export function armSendLaunch(source: { current: Measurable | null }, now = Date.now()) {
  const view = source.current;
  if (!view) return;
  const from = new Promise<Point | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), LAUNCH_TTL_MS);
    view.measureInWindow((x, y) => {
      clearTimeout(timer);
      resolve(Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null);
    });
  });
  armed = { at: now, from };
}

export function claimSendLaunch(clientMessageId: string | null | undefined, now = Date.now()) {
  const current = armed;
  if (!current || !clientMessageId) return null;
  armed = null;
  return now - current.at > LAUNCH_TTL_MS ? null : current.from;
}

export function launchOffset(from: Point, to: Point): Point {
  return { x: Math.round(from.x - to.x), y: Math.round(from.y - to.y) };
}
