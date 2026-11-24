import assert from "node:assert/strict";
import test from "node:test";
import { designHtml, designSvg, loadDesignFonts, setDesignSymbols, validateDesignDocument } from "./design.mjs";
import { DESIGN_SF_SYMBOL_LUCIDE, designSymbolLucide, designSymbolWeight } from "./design-symbols.mjs";
import { designIcons } from "./design-icons.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const screen = (nodes) => ({ schemaVersion: 1, width: 390, height: 300, nodes });

test("every mapped SF Symbol names a real Lucide icon, and variants fall back to their base", () => {
  for (const [symbol, icon] of Object.entries(DESIGN_SF_SYMBOL_LUCIDE)) assert.ok(designIcons[icon], `${symbol} → ${icon}`);
  assert.deepEqual(designSymbolLucide("heart.fill"), { icon: "heart", filled: true, exact: true });
  assert.deepEqual(designSymbolLucide("calendar.badge.plus"), { icon: "calendar", filled: false, exact: false });
  assert.deepEqual(designSymbolLucide("person.crop.circle.fill"), { icon: "circle-user", filled: false, exact: true });
  assert.equal(designSymbolLucide("zz.top").icon, "circle-dashed");
  assert.equal(designSymbolWeight(600), 0.3);
});

test("an icon layer names an SF Symbol with sf: and a weight with fontWeight", () => {
  assert.ok(validateDesignDocument(screen([{ id: "i", type: "icon", width: 24, height: 24, icon: "sf:heart.fill", fontWeight: 600 }])));
  assert.throws(() => validateDesignDocument(screen([{ id: "i", type: "icon", width: 24, height: 24, icon: "sf:Heart Fill" }])), /isn't an SF Symbol name/);
  assert.throws(() => validateDesignDocument(screen([{ id: "i", type: "icon", width: 24, height: 24, icon: "hart" }])), /sf:name/);
});

test("without a host, an SF Symbol draws as its Lucide icon, filled for filled symbols", () => {
  const document = screen([{ id: "i", type: "icon", width: 24, height: 24, icon: "sf:heart.fill", fill: "#ff375f", fontWeight: 700 }]);
  assert.match(designHtml(document), new RegExp(`fill="#ff375f" stroke="#ff375f" stroke-width="2.5"[^>]*>${designIcons.heart.replaceAll("/", "\\/")}`));
  assert.match(designSvg(document, { embedFonts: false }), /fill="#ff375f" stroke="#ff375f" stroke-width="2.5"/);
});

test("on a host with SF Symbols, the symbol's mask is tinted with the layer's color in HTML and SVG", async () => {
  const requests = [];
  setDesignSymbols({
    load: async (batch) => {
      requests.push(...batch);
      return batch.map((request) => (request.name === "heart.fill" ? { key: request.key, png: PNG, width: 24, height: 22 } : null));
    },
  });
  try {
    const document = screen([
      { id: "a", type: "icon", x: 10, y: 10, width: 24, height: 24, icon: "sf:heart.fill", fill: "#ff375f", fontWeight: 600 },
      { id: "b", type: "icon", x: 40, y: 10, width: 24, height: 24, icon: "sf:no.such.symbol" },
    ]);
    await loadDesignFonts(document);
    assert.deepEqual(
      requests.map(({ name, weight }) => [name, weight]),
      [
        ["heart.fill", 0.3],
        ["no.such.symbol", 0],
      ],
    );
    const html = designHtml(document);
    assert.match(html, /background:#ff375f;-webkit-mask:url\(data:image\/png;base64,iVBOR[^)]*\) center\/contain no-repeat/);
    assert.match(html, /circle-dashed|stroke-dasharray|<svg viewBox="0 0 24 24"/);
    const svg = designSvg(document, { embedFonts: false });
    assert.match(svg, /<mask id="symbol-0" maskUnits="userSpaceOnUse" x="10" y="10" width="24" height="24"><image [^>]*href="data:image\/png;base64,iVBOR/);
    assert.match(svg, /<rect x="10" y="10" width="24" height="24" fill="#ff375f" mask="url\(#symbol-0\)"\/>/);
  } finally {
    setDesignSymbols(null);
  }
});
