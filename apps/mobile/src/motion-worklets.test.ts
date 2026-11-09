import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Worklets run on the UI thread; calling a plain JS helper like `ms(...)` from one crashes at runtime.
for (const file of ["status-pill.tsx", "inbox-motion.tsx", "motion.ts"]) {
  test(`${file}: worklets call no plain JS helpers`, () => {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    const parts = source.split('"worklet";').slice(1);
    for (const part of parts) {
      const body = part.slice(0, part.indexOf("\n      },") > 0 ? part.indexOf("\n      },") : 600);
      assert.doesNotMatch(body, /\bms\(/, "ms() inside a worklet");
      assert.doesNotMatch(body, /getMotionScale|scaledDuration|kitFor/, "JS helper inside a worklet");
    }
  });
}
