import assert from "node:assert/strict";
import test from "node:test";
import { applyDesignOperations, createDesignInstance, createExampleDesign, designWarnings, designWarningText, validateDesignDocument } from "./design.mjs";

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

test("text below 3:1 against its backdrop is reported at every size; readable pairs are not", () => {
  const document = doc([
    { id: "dark", type: "frame", x: 0, y: 0, width: 390, height: 200, fill: "#111111" },
    { id: "muted", parentId: "dark", type: "text", width: 300, height: 30, text: "Muted", fill: "#333333", fontSize: 14 },
    { id: "big", parentId: "dark", type: "text", y: 40, width: 300, height: 40, text: "Big", fill: "#444444", fontSize: 28 },
    { id: "soft", parentId: "dark", type: "text", y: 90, width: 300, height: 30, text: "Soft", fill: "#777777", fontSize: 14 },
    { id: "fine", type: "text", y: 300, width: 300, height: 30, text: "Fine", fill: "#111111" },
  ]);
  assert.deepEqual(kinds(document), ["low-contrast:muted", "low-contrast:big"]);
  assert.match(designWarnings(document)[0].message, /^Text "muted" has \d\.\d:1 contrast against its background; below 3:1 it is hard to read\.$/);
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

const photo = { id: "photo", type: "image", width: 390, height: 300, src: "data:image/png;base64,AAAA" };
const caption = (extra = {}) => ({ id: "caption", type: "text", y: 100, width: 200, height: 30, text: "Caption", fill: "#ffffff", ...extra });

test("text over an image is never judged, inside a frame or at the top level", () => {
  assert.deepEqual(
    kinds(doc([{ id: "frame", type: "frame", width: 390, height: 300, fill: "#ffffff" }, { ...photo, parentId: "frame" }, caption({ parentId: "frame" })])),
    [],
  );
  assert.deepEqual(kinds(doc([photo, caption()])), []);
});

test("a shape drawn behind the text is its backdrop, even as a sibling of the text", () => {
  const frame = { id: "frame", type: "frame", width: 390, height: 300, fill: "#ffffff" };
  const plate = { id: "plate", parentId: "frame", type: "rectangle", x: 0, y: 90, width: 390, height: 60, fill: "#111111" };
  assert.deepEqual(kinds(doc([frame, plate, caption({ parentId: "frame" })])), []);
  assert.deepEqual(kinds(doc([frame, plate, caption({ parentId: "frame", fill: "#333333" })])), ["low-contrast:caption"]);
});

test("text only half over a dark shape has no single backdrop and is not judged", () => {
  const plate = { id: "plate", type: "rectangle", x: 0, y: 90, width: 100, height: 60, fill: "#111111" };
  assert.deepEqual(kinds(doc([plate, caption()])), []);
});

test("a shape drawn after the text, or hidden, is not behind it", () => {
  const plate = { id: "plate", type: "rectangle", x: 0, y: 90, width: 390, height: 60, fill: "#111111" };
  assert.deepEqual(kinds(doc([caption(), plate])), ["low-contrast:caption"]);
  assert.deepEqual(kinds(doc([{ ...plate, hidden: true }, caption()])), ["low-contrast:caption"]);
});

test("an icon or another text layer is never a backdrop", () => {
  const plate = { id: "plate", type: "rectangle", x: 0, y: 90, width: 390, height: 60, fill: "#111111" };
  const glyph = { id: "glyph", type: "icon", x: 0, y: 90, width: 390, height: 60, fill: "#ffffff", icon: "star" };
  assert.deepEqual(kinds(doc([plate, glyph, caption()])), []);
  const label = { id: "label", type: "text", x: 0, y: 90, width: 390, height: 60, text: "Label", fill: "#ffffff" };
  assert.deepEqual(kinds(doc([plate, label, caption({ y: 100 })])), []);
});

const plate = (fill) => ({ id: "plate", type: "rectangle", x: 0, y: 90, width: 390, height: 60, fill });

test("unreadable or translucent colours skip the contrast check instead of warning", () => {
  for (const fill of ["black", "#000000ff", "hsl(0, 0%, 0%)", "rgba(0, 0, 0, 0.5)"]) {
    assert.deepEqual(kinds(doc([plate(fill), caption()])), [], `backdrop ${fill}`);
    assert.deepEqual(kinds(doc([caption({ fill })])), [], `text ${fill}`);
  }
  assert.deepEqual(kinds(doc([caption({ fill: "#222222", opacity: 0.4 })])), []);
  assert.deepEqual(kinds(doc([{ ...plate("#111111"), opacity: 0.5 }, caption({ fill: "#222222" })])), []);
});

const heading = (height) => ({
  id: "heading",
  type: "text",
  width: 330,
  height,
  text: "Make room\nfor a good day.",
  fontFamily: "Georgia, serif",
  fontSize: 36,
  fill: "#111111",
});

test("text is clipped only when glyphs are cut, not when just the line box overhangs", () => {
  assert.deepEqual(kinds(doc([heading(96)])), []);
  assert.deepEqual(kinds(doc([heading(80)])), ["clipped-text:heading"]);
  assert.deepEqual(kinds(doc([heading(40)])), ["clipped-text:heading"]);
});

test("ordinary auto-layout, hug sizing and component instances produce no warnings", () => {
  const column = [
    { id: "column", type: "frame", x: 20, y: 20, width: 300, height: 260, fill: "#ffffff", layout: "vertical", padding: 16, gap: 12 },
    { id: "title", parentId: "column", type: "text", width: 268, height: 30, text: "Title", fill: "#111111", fontSize: 22 },
    {
      id: "body",
      parentId: "column",
      type: "text",
      widthMode: "fill",
      width: 268,
      height: 40,
      text: "Body copy that wraps onto a second line.",
      fill: "#222222",
      fontSize: 14,
    },
    { id: "row", parentId: "column", type: "frame", width: 268, height: 40, layout: "horizontal", gap: 8 },
    { id: "chip", parentId: "row", type: "rectangle", width: 60, height: 40, fill: "#eeeeee" },
    { id: "grow", parentId: "row", type: "rectangle", widthMode: "fill", width: 10, height: 40, fill: "#dddddd" },
    {
      id: "pill",
      parentId: "column",
      type: "frame",
      widthMode: "hug",
      heightMode: "hug",
      width: 10,
      height: 10,
      layout: "horizontal",
      padding: 10,
      fill: "#111111",
    },
    { id: "pill-label", parentId: "pill", type: "text", widthMode: "hug", heightMode: "hug", width: 10, height: 10, text: "Hug", fill: "#ffffff" },
    { id: "button", type: "frame", x: 20, y: 300, width: 180, height: 44, component: true, fill: "#123456", layout: "horizontal", padding: 10 },
    { id: "button-label", parentId: "button", type: "text", width: 100, height: 24, text: "Continue", fill: "#ffffff" },
  ];
  const base = doc(column);
  const withInstance = applyDesignOperations(base, createDesignInstance(base, "button", "copy", { x: 20, y: 400 }));
  assert.ok(withInstance.nodes.some((node) => node.componentSourceId === "button-label"));
  assert.deepEqual(kinds(withInstance), []);
});

test("the stock example produces no warnings", () => {
  assert.deepEqual(designWarnings(validateDesignDocument(createExampleDesign())), []);
});
