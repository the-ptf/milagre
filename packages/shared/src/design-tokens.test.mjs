import assert from "node:assert/strict";
import test from "node:test";
import {
  designDiagnostics,
  designDocumentForMode,
  designHtml,
  designHtmlForMode,
  designModesOf,
  designSvg,
  designTextLayout,
  resolveDesignColor,
  validateDesignDocument,
} from "./design.mjs";
import { designKitWarnings } from "./design-kit.mjs";

const tokens = {
  ink: { light: "#111111", dark: "#f5f5f5", contrast: "#000000" },
  paper: { light: "#ffffff", dark: "#000000" },
  accent: "#0a84ff",
  link: "$accent",
};

const screen = (extra = {}) => ({
  schemaVersion: 1,
  width: 390,
  height: 300,
  background: "$paper",
  tokens,
  nodes: [{ id: "title", type: "text", x: 20, y: 20, width: 300, height: 30, text: "Summary", fill: "$ink", fontSize: 20 }],
  ...extra,
});

test("a token resolves per mode, through references, alpha and color-mix", () => {
  assert.equal(resolveDesignColor(tokens, "$ink"), "#111111");
  assert.equal(resolveDesignColor(tokens, "$ink", "dark"), "#f5f5f5");
  assert.equal(resolveDesignColor(tokens, "$paper", "contrast"), "#ffffff");
  assert.equal(resolveDesignColor(tokens, "$link", "dark"), "#0a84ff");
  assert.equal(resolveDesignColor(tokens, "$accent/0.5"), "rgba(10, 132, 255, 0.5)");
  assert.equal(resolveDesignColor(tokens, "$accent / 25%"), "rgba(10, 132, 255, 0.25)");
  assert.equal(resolveDesignColor(tokens, "color-mix(in srgb, $accent 40%, transparent)"), "rgba(10, 132, 255, 0.4)");
  assert.equal(resolveDesignColor(tokens, "color-mix(in srgb, #000000, #ffffff)"), "#808080");
  assert.equal(resolveDesignColor(tokens, "color-mix(in srgb, rgba(0, 0, 0, 0.5) 50%, $paper)", "dark"), "rgba(0, 0, 0, 0.75)");
  assert.equal(resolveDesignColor({ a: "$b", b: "$a" }, "$a"), null);
  assert.equal(resolveDesignColor(tokens, "$missing"), null);
  assert.equal(resolveDesignColor(tokens, "$accent/2"), null);
});

test("documents with plain tokens stay valid and single-mode; modal tokens are checked in every mode", () => {
  const plain = validateDesignDocument({ ...screen(), tokens: { ink: "#111111", paper: "#ffffff" } });
  assert.deepEqual(designModesOf(plain), ["light"]);
  assert.doesNotMatch(designHtml(plain), /--c0|data-design-mode/);
  assert.deepEqual(designModesOf(validateDesignDocument(screen())), ["light", "dark", "contrast"]);
  assert.throws(() => validateDesignDocument(screen({ tokens: { ...tokens, ink: { light: "#111", dark: "$nope" } } })), /\$nope" does not exist/);
  assert.throws(() => validateDesignDocument(screen({ tokens: { ...tokens, a: "$b", b: "$a" } })), /can't be drawn in light mode/);
  assert.throws(() => validateDesignDocument(screen({ tokens: { ...tokens, ink: { dark: "#fff" } } })));
  const alpha = validateDesignDocument(screen({ nodes: [{ id: "veil", type: "rectangle", width: 10, height: 10, fill: "$ink/0.12" }] }));
  assert.equal(alpha.nodes[0].fill, "$ink/0.12");
});

test("one saved page switches modes through CSS variables", () => {
  const html = designHtml(screen());
  assert.match(html, /:root\{--c\d:#ffffff;--c\d:#111111\}/);
  assert.match(html, /:root\[data-design-mode="dark"\]\{--c\d:#000000;--c\d:#f5f5f5\}/);
  assert.match(html, /color:var\(--c\d\)/);
  assert.match(designHtmlForMode(html, "dark"), /^<!doctype html><html data-design-mode="dark"><head>/);
  assert.equal(designHtmlForMode(html, "light"), html);
});

test("previews and diagnostics draw one mode at a time", () => {
  assert.match(designSvg(screen(), { mode: "dark", embedFonts: false }), /fill="#f5f5f5"/);
  assert.match(designSvg(screen(), { embedFonts: false }), /fill="#111111"/);
  const dim = screen({ tokens: { ...tokens, ink: { light: "#111111", dark: "#1a1a1a" } } });
  const checked = validateDesignDocument(dim);
  assert.deepEqual(
    designDiagnostics(designDocumentForMode(checked, "light")).warnings.map((warning) => warning.kind),
    [],
  );
  assert.deepEqual(
    designDiagnostics(designDocumentForMode(checked, "dark")).warnings.map((warning) => warning.kind),
    ["low-contrast"],
  );
});

test("letter spacing widens measured text and reaches both renderers", () => {
  const node = { id: "t", type: "text", width: 300, height: 30, text: "Hello", fontSize: 20 };
  assert.equal(Math.round(designTextLayout({ ...node, letterSpacing: 2 }).width - designTextLayout(node).width), 10);
  const document = screen({ nodes: [{ ...node, letterSpacing: -0.4 }] });
  assert.match(designHtml(document), /letter-spacing:-0.4px/);
  assert.match(designSvg(document, { embedFonts: false }), /letter-spacing="-0.4"/);
});

test("kit tracking and opacity tokens bind like spacing, and alpha of a kit color stays in the palette", () => {
  const kit = {
    id: "project",
    version: 1,
    title: "Kit",
    colors: { ink: { light: "#111111", dark: "#eeeeee" }, paper: "#ffffff" },
    textStyles: { label: { fontSize: 13, fontWeight: 600, letterSpacing: 0.5 } },
    spacing: {},
    radii: {},
    tracking: { tight: -0.4 },
    opacity: { disabled: 0.4 },
  };
  const document = validateDesignDocument({
    schemaVersion: 1,
    width: 390,
    height: 300,
    kit,
    nodes: [
      { id: "label", type: "text", width: 100, height: 20, text: "Done", textStyle: "label", fill: "$ink/0.6" },
      { id: "dim", type: "rectangle", width: 10, height: 10, fill: "$paper", bindings: { opacity: "disabled" } },
      { id: "tight", type: "text", width: 100, height: 20, text: "Tight", fontSize: 13, fontWeight: 600, bindings: { letterSpacing: "tight" }, fill: "$ink" },
    ],
  });
  assert.equal(document.nodes[0].letterSpacing, 0.5);
  assert.equal(document.nodes[1].opacity, 0.4);
  assert.equal(document.nodes[2].letterSpacing, -0.4);
  assert.deepEqual(
    designKitWarnings(document).map((warning) => [warning.id, warning.field]),
    [["tight", "typography"]],
  );
});
