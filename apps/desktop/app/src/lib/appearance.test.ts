import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_APPEARANCE, DIFF_PAIRS } from "@milagre/shared/appearance";
import { appearanceVars } from "./appearance.ts";

const none = () => false;

test("emits size, width and motion variables", () => {
  const vars = appearanceVars({ ...DEFAULT_APPEARANCE, chatSize: "large", chatWidth: "full", diffColors: "blue-orange", motion: "off" }, true, none);
  assert.equal(vars["--chat-size"], "15px");
  assert.equal(vars["--chat-width"], "none");
  assert.equal(vars["--motion-scale"], "0");
  assert.equal(vars["--code-size"], "12px");
  assert.equal(vars["--sidebar-delta"], "0px");
});

test("defaults keep today's values", () => {
  const vars = appearanceVars(DEFAULT_APPEARANCE, false, none);
  assert.equal(vars["--chat-size"], "13px");
  assert.equal(vars["--chat-width"], "768px");
  assert.equal(vars["--motion-scale"], "1");
});

test("a non-default diff pair writes its colors and tints", () => {
  const pair = DIFF_PAIRS.find((p) => p.id === "blue-orange")!;
  const dark = appearanceVars({ ...DEFAULT_APPEARANCE, diffColors: "blue-orange" }, true, none);
  assert.equal(dark["--diff-add-color"], pair.dark!.add);
  assert.equal(dark["--diff-remove-color"], pair.dark!.remove);
  assert.match(dark["--diff-add"], /color-mix\(.*14%/);
  assert.match(dark["--diff-add-word"], /28%/);
  const light = appearanceVars({ ...DEFAULT_APPEARANCE, diffColors: "blue-orange" }, false, none);
  assert.equal(light["--diff-add-color"], pair.light!.add);
});

test("red-green emits no diff variables", () => {
  const vars = appearanceVars(DEFAULT_APPEARANCE, true, none);
  assert.deepEqual(
    Object.keys(vars).filter((k) => k.startsWith("--diff")),
    [],
  );
});
