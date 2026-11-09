import assert from "node:assert/strict";
import test from "node:test";
import { designInterFonts, DESIGN_INTER_WEIGHTS } from "./design-font-data.mjs";

test("Inter ships as four small TrueType subsets", () => {
  assert.deepEqual(DESIGN_INTER_WEIGHTS, [400, 500, 600, 700]);
  for (const weight of DESIGN_INTER_WEIGHTS) {
    const bytes = Buffer.from(designInterFonts[weight], "base64");
    assert.equal(bytes.readUInt32BE(0), 0x00010000, `${weight} is TrueType`);
    assert.ok(bytes.length > 30_000 && bytes.length < 100_000, `${weight} is a Latin subset (${bytes.length} bytes)`);
  }
});
