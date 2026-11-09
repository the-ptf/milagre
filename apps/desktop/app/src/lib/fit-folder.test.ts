import assert from "node:assert/strict";
import test from "node:test";
import { fitFolder, shortestFolder } from "./fit-folder.ts";

const within = (max: number) => (text: string) => text.length <= max;

test("a folder that fits shows whole", () => {
  assert.equal(fitFolder("apps/mobile/src/hooks", within(40)), "apps/mobile/src/hooks");
});

test("a long folder drops whole middle segments, keeping the first two and the last", () => {
  const path = "apps/desktop/app/src/components";
  assert.equal(fitFolder(path, within(29)), "apps/desktop/…/src/components");
  assert.equal(fitFolder(path, within(25)), "apps/desktop/…/components");
  assert.equal(fitFolder("apps/mobile/src/hooks", within(20)), "apps/mobile/…/hooks");
});

test("too narrow for any form, or too short to shorten, is null", () => {
  assert.equal(fitFolder("apps/desktop/app/src/components", within(10)), null);
  assert.equal(fitFolder("packages/app/src", within(5)), null);
  assert.equal(shortestFolder("apps/desktop/app/src/lib"), "apps/desktop/…/lib");
  assert.equal(shortestFolder("src/lib"), "src/lib");
});
