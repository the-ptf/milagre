import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_APPEARANCE, clampChatWidth, MONO_FONTS, UI_FONTS, fontStack, parseAppearance } from "./appearance.mjs";

test("parseAppearance keeps good fields and defaults bad ones", () => {
  assert.deepEqual(parseAppearance({ chatSize: "huge", motion: "fast", sidebarUsage: "compact" }), {
    ...DEFAULT_APPEARANCE,
    motion: "fast",
    sidebarUsage: "compact",
  });
  assert.deepEqual(parseAppearance({ sidebarUsage: "invalid" }), DEFAULT_APPEARANCE);
  assert.deepEqual(parseAppearance(null), DEFAULT_APPEARANCE);
});

test("fontStack falls back to system unless bundled or installed", () => {
  const system = UI_FONTS[0].stack;
  assert.equal(UI_FONTS[0].id, "system");
  assert.equal(
    fontStack(UI_FONTS, "berkeley", () => false),
    system,
  );
  assert.equal(
    fontStack(UI_FONTS, "charter", () => false),
    system,
  );
  assert.ok(fontStack(MONO_FONTS, "jetbrains-mono", () => false).includes('"JetBrains Mono"'));
  assert.ok(fontStack(UI_FONTS, "charter", () => true).includes('"Charter"'));
});

test("custom chat width clamps to 600..2400 and defaults to 900", () => {
  assert.equal(parseAppearance({ chatWidth: "custom", chatWidthPx: 5000 }).chatWidthPx, 2400);
  assert.equal(parseAppearance({ chatWidth: "custom", chatWidthPx: 1100 }).chatWidthPx, 1100);
  assert.equal(parseAppearance({}).chatWidthPx, 900);
  assert.equal(clampChatWidth("x"), 900);
  assert.equal(clampChatWidth(300), 600);
});
