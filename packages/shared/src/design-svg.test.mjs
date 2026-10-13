import assert from "node:assert/strict";
import test from "node:test";
import { renderDesignSvg } from "./design-svg.mjs";

const screen = (nodes, metadata = {}) => ({ schemaVersion: 1, width: 390, height: 844, nodes, ...metadata });
const literalBounds = (nodes) => new Map(nodes.map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0, width: node.width, height: node.height }]));
const color = (value, fallback = "transparent") => value ?? fallback;
const lines = (node) => ({ lines: (node.text ?? "").split("\n"), width: node.width, height: 48, lineHeight: 24 });
const render = (document, bounds = literalBounds(document.nodes), textLayout = lines, resolveColor = color) =>
  renderDesignSvg(document, bounds, textLayout, resolveColor);

test("portable SVG emits native geometry and clips descendants in their parent's coordinate space", () => {
  const document = screen([
    { id: "frame", name: "Card", type: "frame", x: 20, y: 30, width: 100, height: 80, fill: "#fff", radius: 12, opacity: 0.5 },
    { id: "child", parentId: "frame", type: "rectangle", x: 90, y: 80, width: 60, height: 50, fill: "red", radius: 4 },
    { id: "ellipse", type: "ellipse", x: 160, y: 20, width: 80, height: 40, fill: "blue", stroke: "black", strokeWidth: 4 },
  ]);
  const svg = render(document);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /width="390" height="844" viewBox="0 0 390 844"/);
  assert.doesNotMatch(svg, /foreignObject|<html|<div|<script/);
  assert.match(svg, /<clipPath id="clip-0" clipPathUnits="userSpaceOnUse"><rect x="20" y="30" width="100" height="80" rx="12"\/><\/clipPath>/);
  assert.match(svg, /<g id="layer-frame" opacity="0.5" clip-path="url\(#clip-0\)"><title>Card<\/title>.*<g id="layer-child"/);
  assert.match(svg, /<rect x="90" y="80" width="60" height="50" rx="4" fill="red"/);
  assert.match(svg, /<ellipse cx="200" cy="40" rx="40" ry="20" fill="blue"\/>/);
  assert.match(svg, /<ellipse cx="200" cy="40" rx="38" ry="18" fill="none" stroke="black" stroke-width="4"\/>/);
});

test("frame borders retain their fill underneath translucent strokes and clip child content to the inner edge", () => {
  const document = screen([
    { id: "frame", type: "frame", x: 10, y: 20, width: 100, height: 80, radius: 20, fill: "blue", stroke: "#ff000080", strokeWidth: 8 },
    { id: "child", parentId: "frame", type: "rectangle", x: 0, y: 0, width: 200, height: 200, fill: "yellow" },
  ]);
  const svg = render(document);
  assert.match(svg, /<clipPath id="clip-0-content" clipPathUnits="userSpaceOnUse"><rect x="18" y="28" width="84" height="64" rx="12"\/><\/clipPath>/);
  assert.match(svg, /<rect x="10" y="20" width="100" height="80" rx="20" fill="blue"\/>/);
  assert.match(svg, /<rect x="14" y="24" width="92" height="72" rx="16" fill="none" stroke="#ff0000" stroke-opacity="0.502" stroke-width="8"\/>/);
  assert.match(svg, /<g clip-path="url\(#clip-0-content\)"><g id="layer-child"/);
});

test("text uses supplied line breaks, native tspans, alignment and escaped XML", () => {
  const document = screen([
    {
      id: "copy",
      name: 'Title <"&>',
      type: "text",
      x: 10,
      y: 20,
      width: 200,
      height: 100,
      text: "unused",
      fontFamily: "Arial, sans-serif",
      fontSize: 20,
      fontWeight: 700,
      textAlign: "center",
      fill: "$ink",
    },
  ]);
  const calls = [];
  const svg = render(
    document,
    undefined,
    (node, width) => {
      calls.push({ id: node.id, width });
      return { lines: ["  Native & safe", "<second>", ""], width: 160, height: 84, lineHeight: 28 };
    },
    (value, fallback) => (value === "$ink" ? "#123456" : color(value, fallback)),
  );
  assert.deepEqual(calls, [{ id: "copy", width: 200 }]);
  assert.match(svg, /<title>Title &lt;&quot;&amp;&gt;<\/title>/);
  assert.match(svg, /font-family="&quot;Arial&quot;, sans-serif" font-size="20" font-weight="700" text-anchor="middle"/);
  assert.match(svg, /font-kerning:none;font-variant-ligatures:none/);
  assert.match(svg, /xml:space="preserve"/);
  assert.match(svg, /<tspan x="110" y="40">  Native &amp; safe<\/tspan><tspan x="110" y="68">&lt;second&gt;<\/tspan><tspan x="110" y="96"><\/tspan>/);
  assert.match(svg, /fill="#123456"/);
});

test("resolved hug and fill bounds control geometry and text wrapping", () => {
  const document = screen([{ id: "text", type: "text", width: 1, height: 1, text: "Right aligned", textAlign: "right", fontSize: 16 }]);
  const bounds = new Map([["text", { x: 40, y: 50, width: 180, height: 48 }]]);
  let width;
  const svg = render(document, bounds, (node, value) => {
    width = value;
    return lines(node);
  });
  assert.equal(width, 180);
  assert.match(svg, /<rect x="40" y="50" width="180" height="48" rx="0"\/>/);
  assert.match(svg, /text-anchor="end"/);
  assert.match(svg, /<tspan x="220" y="66.8">Right aligned<\/tspan>/);
});

test("bordered text wraps and aligns within the same content box as the HTML preview", () => {
  const document = screen([
    { id: "text", type: "text", x: 10, y: 20, width: 100, height: 60, text: "Bordered", fontSize: 20, stroke: "#123", strokeWidth: 4, textAlign: "right" },
  ]);
  let width;
  const svg = render(document, undefined, (node, available) => {
    width = available;
    return lines(node);
  });
  assert.equal(width, 92);
  assert.match(svg, /<clipPath id="clip-0-content" clipPathUnits="userSpaceOnUse"><rect x="14" y="24" width="92" height="52" rx="0"\/><\/clipPath>/);
  assert.match(svg, /<tspan x="106" y="42">Bordered<\/tspan>/);
  assert.match(svg, /fill="none" stroke="#123" stroke-width="4"/);
});

test("images retain inline or HTTPS sources with cover sizing and rounded clipping", () => {
  const document = screen([
    {
      id: "photo",
      type: "image",
      x: 20,
      y: 30,
      width: 100,
      height: 80,
      radius: 8,
      src: "https://example.com/photo.png?a=1&b=2",
      stroke: "#000",
      strokeWidth: 2,
    },
    { id: "inline", type: "image", x: 140, y: 30, width: 20, height: 20, src: "data:image/png;base64,AA==" },
  ]);
  const svg = render(document);
  assert.match(svg, /xmlns:xlink="http:\/\/www\.w3\.org\/1999\/xlink"/);
  assert.match(svg, /<clipPath id="clip-0-content" clipPathUnits="userSpaceOnUse"><rect x="22" y="32" width="96" height="76" rx="6"\/><\/clipPath>/);
  assert.match(
    svg,
    /<image x="22" y="32" width="96" height="76" href="https:\/\/example.com\/photo\.png\?a=1&amp;b=2" xlink:href="https:\/\/example.com\/photo\.png\?a=1&amp;b=2" preserveAspectRatio="xMidYMid slice"\/>/,
  );
  assert.match(svg, /href="data:image\/png;base64,AA=="/);
  assert.ok(svg.indexOf('preserveAspectRatio="xMidYMid slice"') < svg.indexOf('stroke="#000"'), "the image cannot paint over its border");
});

test("hidden or unplaced layers and descendants are absent without changing sibling paint order", () => {
  const document = screen([
    { id: "top", type: "rectangle", width: 20, height: 20 },
    { id: "hidden", type: "frame", width: 20, height: 20, hidden: true },
    { id: "secret", parentId: "hidden", type: "text", width: 20, height: 20, text: "Do not render" },
    { id: "unplaced", type: "rectangle", width: 20, height: 20 },
    { id: "last", type: "rectangle", width: 20, height: 20 },
  ]);
  const bounds = literalBounds(document.nodes);
  bounds.delete("unplaced");
  const svg = render(document, bounds);
  assert.doesNotMatch(svg, /layer-hidden|layer-secret|layer-unplaced|Do not render/);
  assert.ok(svg.indexOf('id="layer-top"') < svg.indexOf('id="layer-last"'));
});

test("color alpha remains portable as paint opacity and multiplies with ancestor opacity", () => {
  const document = screen(
    [
      { id: "short", type: "frame", width: 80, height: 80, fill: "#f008", opacity: 0.5 },
      { id: "long", parentId: "short", type: "rectangle", width: 30, height: 30, fill: "#12ab3480", stroke: "rgba(100%, 0%, 0%, 25%)", opacity: 0.4 },
      { id: "hsl", type: "rectangle", width: 20, height: 20, fill: "hsl(120 100% 50% / 50%)" },
      { id: "transparent", type: "rectangle", width: 20, height: 20, fill: "transparent" },
    ],
    { background: "#fff0" },
  );
  const svg = render(document);
  assert.match(svg, /fill="#ff0000" fill-opacity="0.5333"/);
  assert.match(svg, /fill="#12ab34" fill-opacity="0.502"/);
  assert.match(svg, /stroke="#ff0000" stroke-opacity="0.25"/);
  assert.match(svg, /fill="#00ff00" fill-opacity="0.5"/);
  assert.match(svg, /<g id="layer-short" opacity="0.5"/);
  assert.match(svg, /<g id="layer-long" opacity="0.4"/);
  assert.match(svg, /fill="none"/);
  assert.doesNotMatch(svg, /(?:fill|stroke)="(?:rgba|hsla|hsl|transparent|#[a-f0-9]{8})/i);
});

test("XML output replaces invalid control characters without dropping Unicode text", () => {
  const document = screen([{ id: "text", type: "text", width: 200, height: 40, text: "Café 日本語 \u{1f33f}\u0000\ud800" }]);
  const svg = render(document);
  assert.match(svg, /Café 日本語 \u{1f33f}\ufffd\ufffd/u);
  assert.equal(svg.includes("\u0000"), false);
});

test("an empty design is still a standalone document with a background", () => {
  assert.match(render(screen([])), /<rect x="0" y="0" width="390" height="844" fill="#ffffff"\/><\/svg>$/);
});

test("an image with a source paints no placeholder shape; one without keeps it", () => {
  const document = screen([
    { id: "icon", type: "image", x: 0, y: 0, width: 24, height: 24, src: "data:image/png;base64,iVBORw0KGgo=" },
    { id: "empty", type: "image", x: 0, y: 40, width: 24, height: 24 },
    { id: "tinted", type: "image", x: 0, y: 80, width: 24, height: 24, src: "data:image/png;base64,iVBORw0KGgo=", fill: "#ff0000" },
  ]);
  const svg = render(document);
  const layer = (id) => new RegExp(`<g id="layer-${id}"[\\s\\S]*?</g>`).exec(svg)[0];
  assert.doesNotMatch(layer("icon"), /<rect[^>]*fill=/);
  assert.match(layer("icon"), /<image /);
  assert.match(layer("empty"), /<rect[^>]*fill="#d8ded8"/);
  assert.match(layer("tinted"), /<rect[^>]*fill="#ff0000"/);
});

test("Inter text names the measured face it draws with; other families keep the requested weight", () => {
  const svg = render(
    screen([
      { id: "inter", type: "text", x: 0, y: 0, width: 200, height: 40, text: "Inter", fontWeight: 650 },
      { id: "light", type: "text", x: 0, y: 40, width: 200, height: 40, text: "Light", fontFamily: "Inter, sans-serif", fontWeight: 450 },
      { id: "arial", type: "text", x: 0, y: 80, width: 200, height: 40, text: "Arial", fontFamily: "Arial", fontWeight: 650 },
    ]),
  );
  assert.deepEqual(
    [...svg.matchAll(/font-weight="(\d+)"/g)].map((match) => match[1]),
    ["600", "400", "650"],
  );
});
