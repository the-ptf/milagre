import assert from "node:assert/strict";
import test from "node:test";
import { designFontFamily, designHtml, designSvg, designTextLayout, validateDesignDocument } from "./design.mjs";
import { designFontFaces } from "./design-fonts.mjs";

const screen = (fontFamily) => ({
  schemaVersion: 1,
  width: 390,
  height: 844,
  nodes: [
    {
      id: "label",
      type: "text",
      width: 300,
      height: 40,
      text: "Font test",
      fontFamily,
    },
  ],
});

test("custom font names are quoted consistently while generic families stay generic", () => {
  assert.equal(designFontFamily(), '"Inter", "Arial", sans-serif');
  assert.equal(designFontFamily("Font 3, SF.Pro, 3D Font, UI-SANS-SERIF"), '"Font 3", "SF.Pro", "3D Font", ui-sans-serif');
  const document = validateDesignDocument(screen("Font 3, SF.Pro, sans-serif"));
  assert.match(designHtml(document), /font-family:&quot;Font 3&quot;, &quot;SF.Pro&quot;, sans-serif/);
  assert.match(designSvg(document), /font-family="&quot;Font 3&quot;, &quot;SF.Pro&quot;, sans-serif"/);
});

test("font lists reject empty families, CSS syntax and line controls before rendering", () => {
  for (const fontFamily of ["", " ", "Inter,,serif", ",Arial", "Arial, ", "Arial\nserif", "Arial; color:red", '"Arial"', "Arial\\serif"]) {
    assert.throws(() => validateDesignDocument(screen(fontFamily)), /font family/);
  }
});

const textNode = (id, extra = {}) => ({ id, type: "text", width: 300, height: 40, text: id, ...extra });
const doc = (nodes) => validateDesignDocument({ schemaVersion: 1, width: 390, height: 844, nodes });

test("only the Inter weights a document's visible text uses are embedded", () => {
  const faces = designFontFaces(
    doc([
      textNode("a"),
      textNode("b", { fontWeight: 600 }),
      textNode("c", { fontWeight: 650 }),
      textNode("d", { fontFamily: "Arial", fontWeight: 700 }),
      textNode("e", { fontWeight: 500, hidden: true }),
    ]),
  );
  assert.equal((faces.match(/@font-face/g) ?? []).length, 2);
  assert.match(faces, /font-family:"Inter";font-weight:400;font-style:normal;src:url\(data:font\/ttf;base64,/);
  assert.match(faces, /font-weight:600;/);
  assert.doesNotMatch(faces, /font-weight:(500|700);/);
  assert.equal(designFontFaces(doc([textNode("x", { fontFamily: "Georgia" })])), "");
});

test("a family that merely contains the letters inter gets neither Inter metrics nor an embedded face", () => {
  const node = textNode("road", { fontFamily: "Interstate", text: "Reservations and filters", fontSize: 20 });
  assert.equal(designFontFaces(doc([node])), "");
  assert.notEqual(designTextLayout(node).width, designTextLayout({ ...node, fontFamily: "Inter" }).width);
  assert.equal(designTextLayout(node).width, designTextLayout({ ...node, fontFamily: "Helvetica" }).width, "Interstate falls back to the generic sans metrics");
});

test("HTML and SVG carry the embedded faces; Inter text disables contextual alternates", () => {
  const document = doc([textNode("title", { fontWeight: 600 })]);
  const html = designHtml(document);
  assert.match(html, /<style>@font-face\{font-family:"Inter";font-weight:600;/);
  assert.match(html, /font-feature-settings:&quot;calt&quot; 0/);
  const svg = designSvg(document);
  assert.match(svg, /<defs><style>@font-face\{font-family:"Inter";font-weight:600;/);
  assert.match(svg, /font-family="&quot;Inter&quot;, &quot;Arial&quot;, sans-serif"/);
});

test("all four weights plus heavy text stay within the 8 MiB render budget", () => {
  const big = "Lorem ipsum dolor sit amet ".repeat(4000);
  const document = doc([400, 500, 600, 700].map((fontWeight) => textNode(`w${fontWeight}`, { fontWeight, text: big.slice(0, 20000), height: 4000 })));
  assert.doesNotThrow(() => designHtml(document));
  assert.doesNotThrow(() => designSvg(document));
});
