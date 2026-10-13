import assert from "node:assert/strict";
import test from "node:test";
import { designWarnings, designWarningText, validateDesignDocument } from "./design.mjs";

const doc = (nodes, extra = {}) => validateDesignDocument({ schemaVersion: 1, width: 390, height: 844, background: "#ffffff", nodes, ...extra });
const kinds = (document) => designWarnings(document).map((warning) => `${warning.kind}:${warning.id}`);

test("clipped text, overflowing children and off-canvas layers are reported", () => {
  const document = doc([
    { id: "card", type: "frame", x: 20, y: 20, width: 200, height: 100, fill: "#ffffff" },
    {
      id: "long",
      parentId: "card",
      type: "text",
      width: 180,
      height: 20,
      text: "This sentence is far too long to fit on one twenty pixel line",
      fill: "#111111",
    },
    { id: "wide", parentId: "card", type: "rectangle", x: 150, y: 10, width: 100, height: 20, fill: "#eeeeee" },
    { id: "outside", type: "rectangle", x: 350, y: 800, width: 100, height: 100, fill: "#eeeeee" },
  ]);
  assert.deepEqual(kinds(document).toSorted(), ["clipped-text:long", "off-canvas:outside", "overflow:wide"]);
});

test("low contrast text is reported against the nearest filled ancestor, scaled for large text", () => {
  const document = doc([
    { id: "dark", type: "frame", x: 0, y: 0, width: 390, height: 200, fill: "#111111" },
    { id: "muted", parentId: "dark", type: "text", width: 300, height: 30, text: "Muted", fill: "#333333", fontSize: 14 },
    { id: "big", parentId: "dark", type: "text", y: 40, width: 300, height: 40, text: "Big", fill: "#777777", fontSize: 28 },
    { id: "fine", type: "text", y: 300, width: 300, height: 30, text: "Fine", fill: "#111111" },
  ]);
  assert.deepEqual(kinds(document), ["low-contrast:muted"]);
});

test("remote images are named; hidden layers and tight but fitting text are not", () => {
  const document = doc([
    { id: "photo", type: "image", width: 100, height: 100, src: "https://example.com/a.png" },
    { id: "ghost", type: "rectangle", x: 380, width: 100, height: 10, hidden: true },
    { id: "fits", type: "text", y: 200, width: 300, height: 22, text: "Fits", fill: "#111111", fontSize: 16 },
  ]);
  assert.deepEqual(kinds(document), ["remote-image:photo"]);
});

test("the warning text is capped at 20 lines", () => {
  const nodes = Array.from({ length: 25 }, (_, index) => ({ id: `o${index}`, type: "rectangle", x: 380, y: index * 20, width: 50, height: 10 }));
  const text = designWarningText(designWarnings(doc(nodes)));
  assert.equal(text.split("\n").length, 21);
  assert.match(text, /…and 5 more$/);
  assert.equal(designWarningText([]), "");
});

test("an icon's fill is a line colour and never a backdrop for text", () => {
  const document = doc([
    { id: "badge", type: "frame", x: 0, y: 0, width: 200, height: 100, fill: "#ffffff" },
    { id: "glyph", parentId: "badge", type: "icon", x: 0, y: 0, width: 24, height: 24, fill: "#000000", icon: "star" },
    { id: "label", parentId: "badge", type: "text", y: 40, width: 150, height: 30, text: "Label", fill: "#111111" },
  ]);
  assert.deepEqual(kinds(document), []);
});

test("a text layer is never a backdrop, even if a malformed document nests under it", () => {
  const document = doc([
    { id: "dark", type: "frame", x: 0, y: 0, width: 300, height: 100, fill: "#000000" },
    { id: "plate", parentId: "dark", type: "text", width: 200, height: 40, text: "Plate", fill: "#ffffff" },
  ]);
  const withChild = {
    ...document,
    nodes: [...document.nodes, { id: "inner", parentId: "plate", type: "text", width: 50, height: 20, text: "In", fill: "#ffffff" }],
  };
  assert.deepEqual(kinds(withChild), []);
});

test("an image ancestor stops the backdrop search instead of lending its fill", () => {
  const document = doc([{ id: "photo", type: "image", width: 300, height: 100, src: "data:image/png;base64,AAAA", fill: "#000000" }]);
  const withCaption = {
    ...document,
    nodes: [...document.nodes, { id: "caption", parentId: "photo", type: "text", width: 200, height: 30, text: "Caption", fill: "#111111" }],
  };
  assert.deepEqual(kinds(withCaption), []);
});
