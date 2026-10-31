import assert from "node:assert/strict";
import test from "node:test";
import { afterPaint } from "./after-paint.ts";

globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

test("afterPaint waits for two frames and can cancel before either frame", (t) => {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  t.mock.method(globalThis, "requestAnimationFrame", (work: FrameRequestCallback) => {
    frames.set(++id, work);
    return id;
  });
  t.mock.method(globalThis, "cancelAnimationFrame", (frame: number) => frames.delete(frame));
  const paint = () => {
    // Callbacks scheduled inside a frame belong to the next frame.
    // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot before callbacks append another frame
    for (const [frame, work] of [...frames]) {
      frames.delete(frame);
      work(0);
    }
  };
  let called = 0;
  afterPaint(() => called++);
  paint();
  assert.equal(called, 0);
  paint();
  assert.equal(called, 1);
  for (const firstFrame of [false, true]) {
    const cancel = afterPaint(() => called++);
    if (firstFrame) paint();
    cancel();
    paint();
    paint();
    assert.equal(called, 1);
    assert.equal(frames.size, 0);
  }
});
