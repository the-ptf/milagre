import assert from "node:assert/strict";
import test from "node:test";
import { designDiagnostics, designHtml, designSvg, validateDesignDocument } from "./design.mjs";
import { DESIGN_MIN_SCREEN } from "./design-schemas.mjs";
import { validateDesignPageSnapshot } from "./design-page.mjs";

test("watch faces, complications and Dynamic Island pieces are drawn at 1x", () => {
  assert.equal(DESIGN_MIN_SCREEN, 16);
  for (const [width, height] of [
    [162, 197],
    [205, 251],
    [16, 16],
    [126, 37],
  ]) {
    const document = validateDesignDocument({ schemaVersion: 1, width, height, background: "#000000", nodes: [] });
    assert.match(designHtml(document), new RegExp(`width:${width}px;height:${height}px`));
    assert.match(designSvg(document, { embedFonts: false }), new RegExp(`width="${width}" height="${height}"`));
  }
  assert.throws(() => validateDesignDocument({ schemaVersion: 1, width: 15, height: 197, nodes: [] }), />=16/);
});

test("lint keeps a small face's layers inside its screen", () => {
  const document = validateDesignDocument({
    schemaVersion: 1,
    width: 162,
    height: 197,
    nodes: [{ id: "ring", type: "path", x: 100, y: 10, width: 80, height: 80, arc: { sweep: 270 } }],
  });
  assert.deepEqual(
    designDiagnostics(document).warnings.map((warning) => [warning.id, warning.kind]),
    [["ring", "off-canvas"]],
  );
});

test("a shared page takes small layer and interactive designs", () => {
  const page = validateDesignPageSnapshot({
    schemaVersion: 1,
    title: "Watch",
    designs: [
      { title: "Face", document: { schemaVersion: 1, width: 162, height: 197, nodes: [] } },
      { title: "Live", interactive: { html: "<!doctype html><p>10:09</p>", width: 205, height: 251 } },
    ],
  });
  assert.deepEqual(
    page.designs.map((design) => (design.document ?? design.interactive).width),
    [162, 205],
  );
});
