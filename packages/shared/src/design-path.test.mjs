import assert from "node:assert/strict";
import test from "node:test";
import { designDiagnostics, designHtml, designSvg, validateDesignDocument } from "./design.mjs";
import { designPathGeometry, validDesignPath } from "./design-path.mjs";

const screen = (nodes) => ({ schemaVersion: 1, width: 390, height: 300, nodes });

test("path data is commands and numbers only", () => {
  assert.ok(validDesignPath("M0 0 L10 10 C 1,2 3,4 5,6 Z"));
  assert.ok(validDesignPath("m12 2a10 10 0 1 1-.01 0z"));
  for (const bad of ['M0 0"/><script>alert(1)</script>', "M0 0 url(#x)", "L10 10", "M", "M0 0 &amp;"]) assert.equal(validDesignPath(bad), false, bad);
  assert.throws(() => validateDesignDocument(screen([{ id: "p", type: "path", width: 24, height: 24, path: "M0 0<svg>" }])), /path data only/);
});

test("a path layer needs path data or an arc and refuses fields it can't draw", () => {
  assert.throws(() => validateDesignDocument(screen([{ id: "p", type: "path", width: 24, height: 24 }])), /needs path data or an arc/);
  assert.throws(() => validateDesignDocument(screen([{ id: "p", type: "path", width: 24, height: 24, path: "M0 0L1 1", arc: { sweep: 90 } }])), /not both/);
  assert.throws(() => validateDesignDocument(screen([{ id: "p", type: "path", width: 24, height: 24, path: "M0 0L1 1", text: "x" }])), /can't use text/);
  assert.throws(
    () => validateDesignDocument(screen([{ id: "r", type: "rectangle", width: 24, height: 24, strokeDash: [2] }])),
    /Only path layers use strokeDash/,
  );
});

test("an arc is a ring stroke inset by its width, starting at 12 o'clock", () => {
  const box = { x: 0, y: 0, width: 100, height: 100 };
  assert.deepEqual(designPathGeometry({ arc: { sweep: 90 }, strokeWidth: 10 }, box), {
    d: "M50 5A45 45 0 0 1 95 50",
    viewBox: "0 0 100 100",
    arc: true,
    strokeWidth: 10,
  });
  assert.match(designPathGeometry({ arc: { sweep: 360 } }, box).d, /^M50 2A48 48 0 1 1 50 98A48 48 0 1 1 50 2$/);
  assert.equal(designPathGeometry({ path: "M0 0", viewBox: [0, 0, 24, 24] }, box).viewBox, "0 0 24 24");
});

test("path layers render in HTML and SVG with fill, stroke, caps, joins and dashes", () => {
  const document = screen([
    { id: "ring", type: "path", x: 10, y: 10, width: 60, height: 60, arc: { start: 0, sweep: 270 }, stroke: "#ff375f", strokeWidth: 8 },
    {
      id: "glyph",
      type: "path",
      x: 100,
      y: 10,
      width: 48,
      height: 48,
      viewBox: [0, 0, 24, 24],
      path: "M2 12h20",
      stroke: "#0a84ff",
      strokeWidth: 2,
      strokeCap: "round",
      strokeJoin: "round",
      strokeDash: [4, 2],
    },
    { id: "blob", type: "path", x: 200, y: 10, width: 40, height: 40, path: "M0 0H40V40Z", fill: "#30d158" },
  ]);
  const html = designHtml(document);
  assert.match(html, /<path d="M30 4A26 26 0 1 1 4 30" fill="none" stroke="#ff375f" stroke-width="8" stroke-linecap="round" stroke-linejoin="miter"\/>/);
  assert.match(
    html,
    /viewBox="0 0 24 24"[^>]*><path d="M2 12h20" fill="transparent" stroke="#0a84ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="4 2"\/>/,
  );
  assert.match(html, /<path d="M0 0H40V40Z" fill="#30d158"\/>/);
  assert.doesNotMatch(html, /border:8px/);
  const svg = designSvg(document, { embedFonts: false });
  assert.match(
    svg,
    /<svg x="10" y="10" width="60" height="60" viewBox="0 0 60 60"[^>]*><path d="M30 4A26 26 0 1 1 4 30" fill="none" stroke="#ff375f" stroke-width="8"/,
  );
  assert.match(svg, /<path d="M2 12h20" fill="none" stroke="#0a84ff"/);
});

test("a path behind text leaves its contrast unchecked rather than guessed", () => {
  const { contrastChecks } = designDiagnostics(
    validateDesignDocument(
      screen([
        { id: "chart", type: "path", x: 0, y: 0, width: 200, height: 100, path: "M0 0H200V100H0Z", fill: "#000000" },
        { id: "label", type: "text", x: 10, y: 10, width: 100, height: 20, text: "42%", fill: "#000000" },
      ]),
    ),
  );
  assert.equal(contrastChecks[0].status, "unsupported");
});
