import assert from "node:assert/strict";
import test, { mock } from "node:test";

(globalThis as any).localStorage = { getItem: (key: string) => (key === "milagre.measureNavigation" ? "1" : null) };
const frames: Array<() => void> = [];
(globalThis as any).requestAnimationFrame = (callback: () => void) => frames.push(callback);
(globalThis as any).cancelAnimationFrame = () => {};
const { beginChatSwitch, commitChatSwitch, transcriptShown } = await import("./chat-switch-timing.ts");

const NAME = "milagre:chat-switch";
const paint = () => {
  while (frames.length) frames.shift()!();
};
const measured = () => performance.getEntriesByName(NAME).length;

test("a switch is measured from the ask to its transcript's frame; asking for the Chat on screen measures nothing", () => {
  performance.clearMeasures(NAME);
  beginChatSwitch("/p#2");
  commitChatSwitch("/p#2");
  paint();
  assert.equal(measured(), 1);
  // /p#2 is on screen now: asking for it again is no switch, and no commit would end it.
  beginChatSwitch("/p#2");
  commitChatSwitch("/p#2");
  paint();
  assert.equal(measured(), 1);
  // A new Chat's screen shows no transcript: opening the Chat again is a switch.
  transcriptShown(null);
  beginChatSwitch("/p#2");
  commitChatSwitch("/p#2");
  paint();
  assert.equal(measured(), 2);
});

test("a switch whose transcript never commits in time is dropped, not measured late", () => {
  const now = mock.method(performance, "now", () => 1_000);
  try {
    performance.clearMeasures(NAME);
    beginChatSwitch("/p#3");
    now.mock.mockImplementation(() => 12_000);
    commitChatSwitch("/p#3");
    paint();
    assert.equal(measured(), 0);
  } finally {
    now.mock.restore();
  }
});

test("a switch counts from the ask until a moment after its transcript commits, so its panels land at once", async () => {
  const { chatSwitching } = await import("./chat-switch-timing.ts");
  const now = mock.method(performance, "now", () => 50_000);
  try {
    transcriptShown(null);
    assert.equal(chatSwitching(), false);
    beginChatSwitch("/p#4");
    assert.equal(chatSwitching(), true);
    // A slow page: still switching until its transcript commits.
    now.mock.mockImplementation(() => 51_500);
    assert.equal(chatSwitching(), true);
    commitChatSwitch("/p#4");
    assert.equal(chatSwitching(), true);
    now.mock.mockImplementation(() => 51_900);
    assert.equal(chatSwitching(), false);
    // Asking for the Chat on screen is no switch: a panel toggled then still springs.
    beginChatSwitch("/p#4");
    assert.equal(chatSwitching(), false);
    // One that never commits stops counting after two seconds.
    beginChatSwitch("/p#5");
    now.mock.mockImplementation(() => 53_950);
    assert.equal(chatSwitching(), false);
  } finally {
    now.mock.restore();
  }
});
