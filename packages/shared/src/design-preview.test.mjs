import assert from "node:assert/strict";
import test from "node:test";
import { designImageDocument, designPreviewDocument } from "./design-preview.mjs";
import { designSvg, validateDesignDocument } from "./design.mjs";

test("image previews replace remote images with the same grey placeholder as agent rasters without changing the source", () => {
  const doc = {
    schemaVersion: 1,
    width: 240,
    height: 240,
    nodes: [
      { id: "logo", type: "image", src: "https://example.com/logo.png", fill: "#f00", width: 30, height: 30 },
      { id: "inline", type: "image", src: "data:image/png;base64,AA==", width: 20, height: 20 },
    ],
  };
  const preview = designPreviewDocument(doc);
  assert.equal(preview.nodes[0].src, undefined);
  assert.equal(preview.nodes[0].fill, undefined);
  assert.equal(preview.nodes[1], doc.nodes[1]);
  assert.equal(doc.nodes[0].src, "https://example.com/logo.png");
  assert.equal(doc.nodes[0].fill, "#f00");
  const svg = designSvg(preview, { embedFonts: false });
  assert.ok(!svg.includes("https://example.com"));
  assert.ok(svg.includes("#d8ded8"));
  assert.equal(designImageDocument(doc, () => false).nodes[1].src, undefined, "raster's oversize policy shares the placeholder transformation");
});

test("catalog-only stacks get a sans-serif fallback while generic and monospace stacks retain their metrics", () => {
  const families = ["Plus Jakarta Sans", '"Menlo", monospace', "Inter, Arial, sans-serif", "serif", '"serif"', "system-ui", "ui-monospace"];
  const doc = {
    schemaVersion: 1,
    width: 240,
    height: 240,
    nodes: families.map((fontFamily, i) => ({ id: String(i), type: "text", width: 90, height: 20, text: "Hello", fontFamily })),
  };
  assert.deepEqual(
    designPreviewDocument(doc).nodes.map((n) => n.fontFamily),
    ["Plus Jakarta Sans, sans-serif", families[1], families[2], "serif", '"serif", sans-serif', "system-ui", "ui-monospace"],
  );
  assert.deepEqual(
    doc.nodes.map((n) => n.fontFamily),
    families,
  );
});

test("preview fallbacks keep valid near-limit font families within the document schema", () => {
  const fontFamily = "A".repeat(149);
  const doc = { schemaVersion: 1, width: 240, height: 240, nodes: [{ id: "text", type: "text", width: 100, height: 30, text: "Hello", fontFamily }] };
  const preview = designPreviewDocument(doc);
  assert.equal(preview.nodes[0].fontFamily, undefined);
  assert.doesNotThrow(() => designSvg(preview, { embedFonts: false }));
  assert.equal(doc.nodes[0].fontFamily, fontFamily);
});

test("adding fallback families cannot push a near-limit document over its character budget", () => {
  const nodes = Array.from({ length: 50 }, (_, i) => ({ id: `text${i}`, type: "text", width: 100, height: 20, text: "a".repeat(19000), fontFamily: "Inter" }));
  const doc = { schemaVersion: 1, width: 240, height: 240, nodes };
  const before = JSON.stringify(doc).length;
  const remaining = 999998 - before;
  for (let i = 0, left = remaining; left > 0; i++) {
    const add = Math.min(1000, left);
    nodes[i].text += "a".repeat(add);
    left -= add;
  }
  assert.equal(JSON.stringify(doc).length, 999998);
  const preview = designPreviewDocument(doc);
  assert.ok(JSON.stringify(preview).length <= 1000000);
  assert.doesNotThrow(() => validateDesignDocument(preview));
  assert.ok(preview.nodes.every((node) => !node.fontFamily || node.fontFamily.endsWith("sans-serif")));
});
