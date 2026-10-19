import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_APPEARANCE, MONO_FONTS, UI_FONTS, fontStack, parseAppearance } from "./appearance.mjs";

test("parseAppearance keeps good fields and defaults bad ones", () => {
  assert.deepEqual(parseAppearance({ chatSize: "huge", motion: "fast" }), { ...DEFAULT_APPEARANCE, motion: "fast" });
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
