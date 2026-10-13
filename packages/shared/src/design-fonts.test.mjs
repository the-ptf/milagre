import assert from "node:assert/strict";
import test from "node:test";
import { designFontFamily, designHtml, designInterWeight, designSvg, designTextLayout, validateDesignDocument } from "./design.mjs";
import { designFontFaces, designInterHasGlyph } from "./design-fonts.mjs";

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
  assert.match(faces, /font-family:"Inter";font-weight:1 450;font-style:normal;src:url\(data:font\/ttf;base64,/);
  assert.match(faces, /font-weight:551 650;/);
  assert.doesNotMatch(faces, /font-weight:(451 550|651 1000);/);
  assert.equal(designFontFaces(doc([textNode("x", { fontFamily: "Georgia" })])), "");
});

test("Inter is detected only as the first family, exactly", () => {
  const node = (fontFamily) => textNode("t", { fontFamily, text: "Reservations and filters", fontSize: 20 });
  const inter = designTextLayout(node("Inter")).width;
  for (const fontFamily of ["Interstate", "Inter Tight", "Arial, Inter"]) {
    assert.equal(designFontFaces(doc([node(fontFamily)])), "", `${fontFamily} embeds no face`);
    assert.notEqual(designTextLayout(node(fontFamily)).width, inter, `${fontFamily} has no Inter metrics`);
  }
  assert.equal(designTextLayout(node("Interstate")).width, designTextLayout(node("Helvetica")).width, "Interstate falls back to the generic sans metrics");
  for (const fontFamily of ["inter, sans-serif", " INTER ", undefined]) {
    assert.match(designFontFaces(doc([node(fontFamily)])), /@font-face/, `${fontFamily} embeds the face`);
    assert.equal(designTextLayout(node(fontFamily)).width, inter, `${fontFamily} has Inter metrics`);
  }
});

test("each embedded face covers the weight range that designInterWeight maps to it", () => {
  const faces = designFontFaces(doc([textNode("a", { fontWeight: 450 }), textNode("b", { fontWeight: 500 })]));
  assert.equal((faces.match(/@font-face/g) ?? []).length, 2);
  assert.match(faces, /font-weight:1 450;/);
  assert.match(faces, /font-weight:451 550;/);
  // Every integer weight lands in exactly the range of the face designInterWeight picks.
  const all = designFontFaces(doc([400, 500, 600, 700].map((fontWeight) => textNode(`w${fontWeight}`, { fontWeight }))));
  const ranges = [...all.matchAll(/font-weight:(\d+) (\d+);/g)].map(([, from, to]) => [Number(from), Number(to)]);
  assert.deepEqual(ranges, [
    [1, 450],
    [451, 550],
    [551, 650],
    [651, 1000],
  ]);
  for (let weight = 100; weight <= 900; weight++) {
    const covering = ranges.filter(([from, to]) => weight >= from && weight <= to);
    assert.equal(covering.length, 1, `weight ${weight}`);
    assert.equal(ranges.indexOf(covering[0]), [400, 500, 600, 700].indexOf(designInterWeight(weight)), `weight ${weight}`);
  }
});

test("HTML and SVG carry the embedded faces; Inter text disables contextual alternates", () => {
  const document = doc([textNode("title", { fontWeight: 600 })]);
  const html = designHtml(document);
  assert.match(html, /<style>@font-face\{font-family:"Inter";font-weight:551 650;/);
  assert.match(html, /font-feature-settings:&quot;calt&quot; 0/);
  const svg = designSvg(document);
  assert.match(svg, /<defs><style>@font-face\{font-family:"Inter";font-weight:551 650;/);
  assert.match(svg, /font-family="&quot;Inter&quot;, &quot;Arial&quot;, sans-serif"/);
});

test("all four weights plus heavy text stay within the 8 MiB render budget", () => {
  const big = "Lorem ipsum dolor sit amet ".repeat(4000);
  const document = doc([400, 500, 600, 700].map((fontWeight) => textNode(`w${fontWeight}`, { fontWeight, text: big.slice(0, 20000), height: 4000 })));
  assert.doesNotThrow(() => designHtml(document));
  assert.doesNotThrow(() => designSvg(document));
});

test("the bundled Inter subset covers ASCII, Latin-1 and common punctuation, not other scripts", () => {
  for (const character of ["A", "z", "~", "é", "ó", "—", "“", "→", "€", " ", "\t", "\n"]) assert.ok(designInterHasGlyph(character), character);
  for (const character of ["ł", "ż", "ś", "Ж", "日", "😀", "✓", "★"]) assert.equal(designInterHasGlyph(character), false, character);
});
