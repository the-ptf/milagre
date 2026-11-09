import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "pele";
import { diagramLabel, diagramTheme, isMermaidFence, nativeDiagramSvg, resolveDiagramSvg } from "./diagram.ts";

const theme = diagramTheme({ background: "#101010", ink: "#f0f0f0", muted: "#909090", line: "#404040", accent: "#3e9afd" });

test("a mermaid fence is a diagram, named for what Pele detects", () => {
  assert.equal(isMermaidFence("mermaid"), true);
  assert.equal(isMermaidFence(" Mermaid "), true);
  assert.equal(isMermaidFence("mermaid.js"), false);
  assert.equal(diagramLabel("flowchart"), "Flowchart");
  assert.equal(diagramLabel("sequence"), "Sequence diagram");
  assert.equal(diagramLabel("stateDiagram-v2"), "State diagram");
  assert.equal(diagramLabel(null), "Diagram");
  assert.equal(diagramLabel("somethingNew"), "Diagram");
});

test("the theme mixes surfaces from the ink over the background", () => {
  assert.equal(theme["--pele-bg"], "#101010");
  assert.equal(theme["--pele-surface"], "#202020");
  assert.equal(diagramTheme({ background: "rgb(0 0 0)", ink: "#fff", muted: "#999", line: "#333", accent: "#00f" })["--pele-surface"], "rgb(0 0 0)");
});

test("every colour is written out, for SVG that sees no CSS", () => {
  for (const source of [
    "flowchart LR\n  A[Phone] -->|fallback| B[relay]\n  B --> C{cap?}\n  style C fill:#f96",
    'pie title Pets\n  "Dogs" : 3\n  "Cats" : 1',
    "sequenceDiagram\n  Alice->>Bob: Hi\n  Note over Alice,Bob: a note",
    "gantt\n  dateFormat YYYY-MM-DD\n  section A\n  X :crit, a, 2026-01-01, 2d",
  ]) {
    const { svg } = render(source, { maxWidth: 360 });
    const resolved = resolveDiagramSvg(svg, theme);
    assert.doesNotMatch(resolved, /var\(/, source);
    assert.match(resolved, /#101010|#f0f0f0/, "the theme's colours are used");
    const native = nativeDiagramSvg(svg, theme);
    assert.doesNotMatch(native, /var\(| style=|<a\b|<title>| class=| role=| data-id=/, source);
    assert.match(native, /^<svg\b[^>]* width="[\d.]+" height="[\d.]+"/);
  }
});

test("a style fill a diagram sets itself survives as an attribute", () => {
  const { svg } = render("flowchart LR\n  A --> B\n  style B fill:#ff9966", {});
  assert.match(nativeDiagramSvg(svg, theme), /fill="#ff9966"/);
});
