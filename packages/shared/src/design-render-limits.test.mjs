import assert from "node:assert/strict";
import test from "node:test";
import { designFontFaces, designHtml, designSvg, validateDesignDocument } from "./design.mjs";
import { designRenderBudget, MAX_DESIGN_RENDER_BYTES } from "./design-render-limits.mjs";

const screen = (nodes) => ({ schemaVersion: 1, width: 390, height: 844, nodes });
const narrowText = (extra = {}) => ({ id: "article", name: "Article body", type: "text", width: 1, height: 1, fontSize: 2, text: "a".repeat(20000), ...extra });
const count = (source, tag) => [...source.matchAll(new RegExp(`<${tag}\\b`, "g"))].length;

test("narrow text keeps source content but emits only visible lines in HTML and SVG", () => {
  const document = screen([narrowText()]);
  const before = JSON.stringify(document);
  assert.equal(count(designHtml(document), "span"), 1);
  assert.equal(count(designSvg(document), "tspan"), 1);
  // The embedded Inter faces are a fixed cost; the markup around them must stay small.
  const faces = Buffer.byteLength(designFontFaces(validateDesignDocument(document)));
  assert.ok(faces > 0);
  assert.ok(Buffer.byteLength(designHtml(document)) - faces < 3000);
  assert.ok(Buffer.byteLength(designSvg(document)) - faces < 2000);
  assert.equal(JSON.stringify(document), before);
  assert.equal(validateDesignDocument(document).nodes[0].text.length, 20000);
});

test("text clipping keeps partial lines and short line-height overhang while excluding border space", () => {
  const cases = [
    { height: 10, fontSize: 10, lineHeight: 1, expected: 1 },
    { height: 11, fontSize: 10, lineHeight: 1, expected: 2 },
    { height: 13, stroke: "black", strokeWidth: 2, fontSize: 10, lineHeight: 1, expected: 1 },
    { height: 15, stroke: "black", strokeWidth: 2, fontSize: 10, lineHeight: 1, expected: 2 },
    { height: 4, stroke: "black", strokeWidth: 2, fontSize: 10, lineHeight: 1, expected: 0 },
    { height: 5, fontSize: 10, lineHeight: 0.5, expected: 2 },
  ];
  for (const { expected, ...properties } of cases) {
    const document = screen([narrowText({ text: "a".repeat(10), ...properties })]);
    assert.equal(count(designHtml(document), "span"), expected, JSON.stringify(properties));
    assert.equal(count(designSvg(document), "tspan"), expected, JSON.stringify(properties));
  }
});

test("a valid small document cannot amplify past either renderer's 8 MiB budget", () => {
  const document = screen(Array.from({ length: 40 }, (_, index) => narrowText({ id: `article${index}`, height: 16000, lineHeight: 1 })));
  assert.ok(JSON.stringify(validateDesignDocument(document)).length < 1000000);
  for (const render of [designHtml, designSvg]) {
    assert.throws(() => render(document), /exceeds the 8 MiB rendered size limit at layer "Article body" \(article\d+\)/);
  }
});

test("render limits count UTF-8 bytes cumulatively and allow the exact boundary", () => {
  const take = designRenderBudget("SVG");
  assert.equal(take("é".repeat(MAX_DESIGN_RENDER_BYTES / 2)).length, MAX_DESIGN_RENDER_BYTES / 2);
  assert.throws(() => take("a", { id: "last", name: "Final layer" }), /Final layer/);
});
