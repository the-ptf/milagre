import assert from "node:assert/strict";
import { test } from "node:test";
import { armSendLaunch, claimSendLaunch, launchOffset } from "./send-launch-store.ts";

const field = (x: number, y: number) => ({ current: { measureInWindow: (callback: (x: number, y: number) => void) => callback(x, y) } });

test("the first pending user message claims the launch once, from where the composer was", async () => {
  armSendLaunch(field(24, 700), 1_000);
  const launch = claimSendLaunch("client-1", 1_200);
  assert.deepEqual(await launch, { x: 24, y: 700 });
  assert.equal(claimSendLaunch("client-2", 1_300), null);
});

test("a saved message without a client id never claims it", () => {
  armSendLaunch(field(24, 700), 1_000);
  assert.equal(claimSendLaunch(undefined, 1_100), null);
  assert.notEqual(claimSendLaunch("client-1", 1_100), null);
});

test("a launch older than two seconds plays nothing", () => {
  armSendLaunch(field(24, 700), 1_000);
  assert.equal(claimSendLaunch("client-1", 3_500), null);
});

test("the offset moves the bubble back to the composer", () => {
  assert.deepEqual(launchOffset({ x: 24, y: 700 }, { x: 180.4, y: 96 }), { x: -156, y: 604 });
});
