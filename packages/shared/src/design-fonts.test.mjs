import assert from "node:assert/strict";
import test from "node:test";
import { designFontFamily, designHtml, designInterWeight, designSvg, designTextLayout, validateDesignDocument } from "./design.mjs";
import {
  DESIGN_CATALOG_FAMILIES,
  designCatalogFont,
  designDrawnWeight,
  designFontBuffers,
  designFontFaces,
  designFontsLoaded,
  designInterHasGlyph,
  loadDesignFonts,
} from "./design-fonts.mjs";

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

test("a catalog family is embedded only after it loads, at the measured weights its text uses", async () => {
  const document = validateDesignDocument(screen("Bebas Neue, Arial, sans-serif"));
  document.nodes.push({
    id: "garamond",
    type: "text",
    width: 300,
    height: 40,
    text: "Rua dos Remédios",
    fontFamily: "EB Garamond, Georgia, serif",
    fontWeight: 560,
  });
  assert.equal(designFontsLoaded(document), false);
  assert.doesNotMatch(designFontFaces(document), /Bebas Neue/);
  await loadDesignFonts(document);
  assert.equal(designFontsLoaded(document), true);
  const faces = designFontFaces(document);
  assert.match(faces, /font-family:"Bebas Neue";font-weight:1 1000;/);
  // EB Garamond is drawn at 400 and 500; 560 renders with 500, which claims the weights nearest to it.
  assert.match(faces, /font-family:"EB Garamond";font-weight:451 1000;/);
  assert.equal((faces.match(/@font-face/g) ?? []).length, 2);
  assert.equal(designDrawnWeight("EB Garamond, serif", 560), 500);
  assert.equal(designDrawnWeight("Fraunces, serif", 560), 560);
  // Every Inter weight for the rasterizer's defaults, plus the two catalog faces.
  assert.equal(designFontBuffers(document).length, 6);
  assert.match(designHtml(document), /font-family:"EB Garamond"/);
  assert.match(designSvg(document), /font-family="&quot;EB Garamond&quot;, &quot;Georgia&quot;, serif" font-size="16" font-weight="500"/);
});

test("catalog families wrap with their own measured advances, and only as the first family", () => {
  const node = (fontFamily) => ({ type: "text", text: "Nine is the number on our door", fontFamily, fontSize: 40 });
  const condensed = designTextLayout(node("Bebas Neue, Arial, sans-serif"));
  const sans = designTextLayout(node("Arial, Bebas Neue"));
  assert.ok(condensed.width < sans.width * 0.8, `Bebas Neue is condensed: ${condensed.width} vs ${sans.width}`);
  assert.equal(designCatalogFont("bebas neue, Arial").family, "Bebas Neue");
  assert.equal(designCatalogFont("Arial, Bebas Neue"), undefined);
  assert.ok(DESIGN_CATALOG_FAMILIES.includes("EB Garamond"));
});
