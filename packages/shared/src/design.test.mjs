import assert from "node:assert/strict";
import test from "node:test";
import {
  DESIGN_INK,
  DESIGN_PLACEHOLDER,
  designDefaultFill,
  applyDesignOperations,
  buildDesignControllerScript,
  createExampleDesign,
  designColor,
  designFontFaces,
  designHtml,
  designLayout,
  designNodeAt,
  designSvg,
  DESIGN_CONTROLLER_SCRIPT,
  diffDesignDocuments,
  validateDesignDocument,
} from "./design.mjs";
import { designIcons } from "./design-icons.mjs";

const screen = () => ({
  schemaVersion: 1,
  width: 390,
  height: 844,
  nodes: [
    { id: "frame", type: "frame", x: 20, y: 30, width: 300, height: 200, layout: "vertical", padding: 10, gap: 8 },
    { id: "title", type: "text", parentId: "frame", width: 100, height: 20, text: "A real layer" },
    { id: "button", type: "rectangle", parentId: "frame", width: 80, height: 40 },
  ],
});

test("a failed edit batch leaves its input untouched", () => {
  const original = screen();
  assert.throws(
    () =>
      applyDesignOperations(original, [
        { op: "update", id: "title", patch: { text: "Changed" } },
        { op: "update", id: "missing", patch: { text: "Gone" } },
      ]),
    /does not exist/,
  );
  assert.equal(original.nodes[1].text, "A real layer");
  const revised = applyDesignOperations(original, [{ op: "update", id: "title", patch: { text: "Changed" } }]);
  assert.equal(revised.nodes[1].text, "Changed");
  assert.equal(original.nodes[1].text, "A real layer");
});

test("tree validation rejects duplicate ids, orphaned layers, non-frame parents and cycles", () => {
  const original = screen();
  assert.throws(() => validateDesignDocument({ ...original, nodes: [...original.nodes, original.nodes[1]] }), /duplicated/);
  assert.throws(() => applyDesignOperations(original, [{ op: "update", id: "title", patch: { parentId: "missing" } }]), /does not exist/);
  assert.throws(() => applyDesignOperations(original, [{ op: "update", id: "button", patch: { parentId: "title" } }]), /must be a frame/);
  assert.throws(() => applyDesignOperations(original, [{ op: "update", id: "frame", patch: { parentId: "frame" } }]), /circular/);
});

test("one batch can add a subtree in either order, and deleting its frame deletes descendants", () => {
  const original = screen();
  const revised = applyDesignOperations(original, [
    { op: "insert", node: { id: "child", parentId: "new-frame", type: "text", width: 60, height: 20 } },
    { op: "insert", node: { id: "new-frame", type: "frame", parentId: "frame", width: 100, height: 80 } },
  ]);
  assert.equal(revised.nodes.length, 5);
  assert.deepEqual(applyDesignOperations(revised, [{ op: "delete", id: "frame" }]).nodes, []);
});

test("vertical and horizontal auto-layout share exact selection bounds", () => {
  const original = screen();
  assert.deepEqual(designLayout(original).get("title"), { x: 30, y: 40, width: 100, height: 20 });
  assert.deepEqual(designLayout(original).get("button"), { x: 30, y: 68, width: 80, height: 40 });
  const centered = applyDesignOperations(original, [{ op: "update", id: "frame", patch: { layout: "horizontal", justify: "space-between", align: "center" } }]);
  assert.deepEqual(designLayout(centered).get("title"), { x: 30, y: 120, width: 100, height: 20 });
  assert.deepEqual(designLayout(centered).get("button"), { x: 230, y: 110, width: 80, height: 40 });
});

test("hidden frames hide descendants and do not consume auto-layout space", () => {
  const document = applyDesignOperations(screen(), [{ op: "update", id: "title", patch: { hidden: true } }]);
  assert.equal(designLayout(document).has("title"), false);
  assert.equal(designLayout(document).get("button").y, 40);
  const hidden = applyDesignOperations(document, [{ op: "update", id: "frame", patch: { hidden: true } }]);
  assert.equal(designLayout(hidden).size, 0);
});

test("diffs keep ordinary edits small and preserve structural changes", () => {
  const original = screen();
  const after = applyDesignOperations(original, [{ op: "update", id: "title", patch: { text: "Short patch" } }]);
  assert.deepEqual(diffDesignDocuments(original, after), [{ op: "update", id: "title", patch: { text: "Short patch" } }]);
  assert.deepEqual(diffDesignDocuments(after, after), []);
  const inserted = applyDesignOperations(after, [{ op: "insert", index: 1, node: { id: "image", type: "image", width: 20, height: 20 } }]);
  assert.deepEqual(applyDesignOperations(after, diffDesignDocuments(after, inserted)), inserted);
  const reordered = { ...inserted, nodes: [...inserted.nodes].reverse() };
  assert.deepEqual(applyDesignOperations(inserted, diffDesignDocuments(inserted, reordered)), reordered);
  const removed = applyDesignOperations(original, [{ op: "delete", id: "frame" }]);
  assert.deepEqual(applyDesignOperations(original, diffDesignDocuments(original, removed)), removed);
});

test("unknown tokens and style/URL injection are rejected before rendering", () => {
  assert.throws(() => validateDesignDocument({ ...screen(), background: "$missing" }), /does not exist/);
  assert.throws(() => validateDesignDocument({ ...screen(), background: "red;position:fixed" }));
  assert.throws(() => applyDesignOperations(screen(), [{ op: "update", id: "title", patch: { fontFamily: "Arial; background:url(https://example.com)" } }]));
  assert.throws(() => applyDesignOperations(screen(), [{ op: "update", id: "button", patch: { src: "javascript:alert(1)" } }]));
  const document = { ...screen(), tokens: { primary: "#345678" }, background: "$primary" };
  assert.equal(designColor(document, document.background), "#345678");
});

test("preview escapes text and script delimiters while JSON remains editable", () => {
  const document = applyDesignOperations(screen(), [{ op: "update", id: "title", patch: { height: 120, text: '</script><script>alert("x")</script>' } }]);
  const preview = designHtml(document, { interactive: true, selectedId: "title" });
  assert.equal((preview.match(/<script>/g) ?? []).length, 1);
  assert.match(preview, /&lt;\/script&gt;/);
  assert.match(preview, /milagre:design-update/);
  const svg = designSvg(document);
  assert.match(svg, /<svg xmlns=/);
  const svgText = [...svg.matchAll(/<tspan\b[^>]*>(.*?)<\/tspan>/g)].map((match) => match[1]).join("");
  assert.match(svgText, /&lt;script&gt;alert/);
  assert.doesNotMatch(svg, /<(?:script|foreignObject)\b/);
});

test("the CSP-approved controller is stable and design content stays outside executable scripts", () => {
  assert.equal(
    DESIGN_CONTROLLER_SCRIPT,
    buildDesignControllerScript(),
    "run node packages/shared/scripts/generate-design-controller.mjs after changing the controller",
  );
  const first = designHtml(screen(), { interactive: true, selectedId: "title" });
  const changed = applyDesignOperations(screen(), [{ op: "update", id: "title", patch: { text: '</script><script>alert("x")</script>' } }]);
  const second = designHtml(changed, { interactive: true, selectedId: "button" });
  assert.equal(/<script>([\s\S]*?)<\/script>/.exec(first)?.[1], DESIGN_CONTROLLER_SCRIPT);
  assert.equal(/<script>([\s\S]*?)<\/script>/.exec(second)?.[1], DESIGN_CONTROLLER_SCRIPT);
  const data = JSON.parse(/<script type="application\/json" id="design-config">([\s\S]*?)<\/script>/.exec(second)[1]);
  assert.equal(data[0].nodes.find((node) => node.id === "title").text, '</script><script>alert("x")</script>');
  assert.equal(data[1], "button");
  assert.deepEqual(data[2].button, designLayout(changed).get("button"));
});

test("the bundled example is a valid editable document without remote assets", () => {
  const document = validateDesignDocument(createExampleDesign());
  assert.equal(document.width, 390);
  assert.equal(designLayout(document).size, document.nodes.length);
  // The embedded Inter faces are a fixed cost; the markup around them must stay small.
  assert.ok(designHtml(document).length - designFontFaces(document).length < 20000);
});

test("feedback hit testing follows the frontmost layer and respects a clipped frame", () => {
  const document = screen();
  assert.equal(designNodeAt(document, 35, 42)?.id, "title");
  assert.equal(designNodeAt(document, 300, 40)?.id, "frame");
  assert.equal(designNodeAt(document, 0, 0), null);
  const clipped = applyDesignOperations(document, [{ op: "update", id: "title", patch: { width: 600 } }]);
  assert.equal(designNodeAt(clipped, 350, 42), null);
  assert.equal(designNodeAt(clipped, NaN, 42), null);
});

test("feedback on a generated component child names its editable instance", () => {
  const document = validateDesignDocument({
    schemaVersion: 1,
    width: 390,
    height: 844,
    nodes: [
      { id: "card", type: "frame", component: true, width: 100, height: 100 },
      { id: "label", type: "text", parentId: "card", width: 80, height: 40, text: "Card" },
      { id: "copy", type: "frame", componentId: "card", x: 150, y: 0, width: 100, height: 100 },
    ],
  });
  assert.equal(designNodeAt(document, 10, 10)?.id, "label");
  const hit = designNodeAt(document, 160, 10);
  assert.equal(hit?.id, "copy");
  const revised = applyDesignOperations(document, [{ op: "update", id: hit.id, patch: { x: 200 } }]);
  assert.equal(revised.nodes.find((node) => node.id === "copy").x, 200);
});

const PIXEL = "data:image/png;base64,iVBORw0KGgo=";

test("an image with a source paints no placeholder behind its transparent pixels", () => {
  const document = validateDesignDocument({
    schemaVersion: 1,
    width: 390,
    height: 844,
    nodes: [
      { id: "icon", type: "image", width: 24, height: 24, src: PIXEL },
      { id: "empty", type: "image", y: 40, width: 24, height: 24 },
      { id: "tinted", type: "image", y: 80, width: 24, height: 24, src: PIXEL, fill: "#ff0000" },
    ],
  });
  const html = designHtml(document);
  const style = (id) => new RegExp(`data-design-node="${id}"[^>]*style="([^"]*)"`).exec(html)[1];
  assert.match(style("icon"), /background:transparent/);
  assert.match(style("empty"), /background:#d8ded8/);
  assert.match(style("tinted"), /background:#ff0000/);
});

const iconScreen = (icon = {}) => ({
  schemaVersion: 1,
  width: 390,
  height: 844,
  nodes: [{ id: "close", type: "icon", icon: "x", x: 20, y: 20, width: 24, height: 24, fill: "#111111", strokeWidth: 2, ...icon }],
});

test("icon layers name a Lucide icon and reject properties they can't draw", () => {
  assert.equal(validateDesignDocument(iconScreen()).nodes[0].icon, "x");
  assert.throws(
    () => validateDesignDocument(iconScreen({ icon: "chevron-up-down" })),
    /Unknown icon "chevron-up-down" on layer "close"\. Did you mean chevrons-up-down/,
  );
  assert.throws(() => validateDesignDocument(iconScreen({ icon: undefined })), /needs an icon name/);
  for (const extra of [{ stroke: "#000" }, { radius: 4 }, { text: "x" }, { src: "https://example.com/x.png" }]) {
    assert.throws(() => validateDesignDocument(iconScreen(extra)), /Icon layer "close" can't use/, JSON.stringify(extra));
  }
  assert.throws(
    () =>
      validateDesignDocument({ ...iconScreen(), nodes: [...iconScreen().nodes, { id: "inside", parentId: "close", type: "rectangle", width: 4, height: 4 }] }),
    /must be a frame/,
  );
  assert.throws(
    () => validateDesignDocument({ ...iconScreen(), nodes: [{ id: "label", type: "text", width: 10, height: 10, icon: "x" }] }),
    /Only icon layers use "icon"/,
  );
});

test("insert, update and replace all validate icon names", () => {
  const base = validateDesignDocument(iconScreen());
  assert.throws(() => applyDesignOperations(base, [{ op: "update", id: "close", patch: { icon: "crosss" } }]), /Unknown icon "crosss"/);
  assert.throws(
    () => applyDesignOperations(base, [{ op: "insert", node: { id: "n", type: "icon", icon: "nope", width: 24, height: 24 } }]),
    /Unknown icon "nope"/,
  );
  assert.throws(() => applyDesignOperations(base, [{ op: "replace", document: iconScreen({ icon: "nope" }) }]), /Unknown icon "nope"/);
  assert.equal(applyDesignOperations(base, [{ op: "update", id: "close", patch: { icon: "check" } }]).nodes[0].icon, "check");
});

test("icon layers render Lucide geometry with their color and weight", () => {
  const document = validateDesignDocument({ ...iconScreen({ fill: "$ink", strokeWidth: 1.5, width: 32, height: 24 }), tokens: { ink: "#123456" } });
  const html = designHtml(document);
  assert.match(html, /data-design-node="close"[^>]*style="[^"]*background:transparent/);
  assert.match(
    html,
    /<svg viewBox="0 0 24 24" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" fill="none" stroke="#123456" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" color="#123456" aria-hidden="true"><path d="M18 6 6 18"\/><path d="m6 6 12 12"\/><\/svg>/,
  );
  const svg = designSvg(document);
  assert.match(
    svg,
    /<svg x="20" y="20" width="32" height="24" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" fill="none" stroke="#123456" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" color="#123456"><path d="M18 6 6 18"\/>/,
  );
  assert.doesNotMatch(svg, /<clipPath/, "icons need no clip shape");
  assert.match(html, /data-design-node="close"[^>]*style="[^"]*border:0px/, "strokeWidth is a line weight, never a border");
});

test("icon layers default to the ink color and weight 2", () => {
  const document = iconScreen({ fill: undefined, strokeWidth: undefined });
  assert.match(designHtml(document), /stroke="#202720" stroke-width="2"/);
  assert.match(designSvg(document), /stroke="#202720" stroke-width="2"/);
});

test("icons with currentColor dots take the line color", () => {
  assert.match(designIcons.tag, /fill="currentColor"/);
  const document = iconScreen({ icon: "tag", fill: "#ab1234" });
  assert.match(designHtml(document), /color="#ab1234"[^>]*>.*<circle[^>]*fill="currentColor"/);
  assert.match(designSvg(document), /color="#ab1234"><path[^>]*\/>.*<circle[^>]*fill="currentColor"/);
});

test("each layer type's default fill matches what the renderers paint", () => {
  assert.deepEqual(
    [
      { type: "text" },
      { type: "icon" },
      { type: "frame" },
      { type: "image", src: "https://example.com/a.png" },
      { type: "image" },
      { type: "rectangle" },
      { type: "ellipse" },
    ].map(designDefaultFill),
    [DESIGN_INK, DESIGN_INK, "transparent", "transparent", DESIGN_PLACEHOLDER, DESIGN_PLACEHOLDER, DESIGN_PLACEHOLDER],
  );
  assert.deepEqual([DESIGN_INK, DESIGN_PLACEHOLDER], ["#202720", "#d8ded8"]);
  const document = {
    schemaVersion: 1,
    width: 390,
    height: 844,
    nodes: [
      { id: "box", type: "rectangle", x: 0, y: 0, width: 10, height: 10 },
      { id: "label", type: "text", x: 0, y: 20, width: 100, height: 20, text: "Hi" },
      { id: "photo", type: "image", x: 0, y: 50, width: 10, height: 10 },
    ],
  };
  const svg = designSvg(document);
  assert.match(svg, /<rect x="0" y="0" width="10" height="10" rx="0" fill="#d8ded8"\/>/);
  assert.match(svg, /<text fill="#202720"/);
  assert.match(svg, /<rect x="0" y="50" width="10" height="10" rx="0" fill="#d8ded8"\/>/);
});
