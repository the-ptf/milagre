import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// The production build's CSS minifier keeps only the last of `backdrop-filter` and `-webkit-backdrop-filter` in a rule,
// so a prefixed line written after the plain one left beta.33's composer, Details glass, top band, status pills and
// palette backdrop with no blur at all: Chromium ignores the prefixed property. Electron is Chromium, so write the plain
// property alone.
test("styles.css writes backdrop-filter without the -webkit- prefix", () => {
  const css = readFileSync(join(import.meta.dirname, "styles.css"), "utf8");
  const prefixed = css.split("\n").flatMap((line, index) => (/-webkit-backdrop-filter\s*:/.test(line) ? [index + 1] : []));
  assert.deepEqual(prefixed, [], "Drop -webkit-backdrop-filter: the minifier keeps it over backdrop-filter, and Chromium ignores it");
});
