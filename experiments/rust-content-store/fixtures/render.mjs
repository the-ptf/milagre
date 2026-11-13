import { designHtml, designLayout, validateDesignDocument, loadDesignFonts, DESIGN_CATALOG_FAMILIES } from "../../../packages/shared/src/design.mjs";
const text = (id, parentId, content, options = {}) => ({
  id,
  type: "text",
  ...(parentId ? { parentId } : {}),
  width: 180,
  height: 50,
  text: content,
  ...options,
});
const frame = (id, parentId, options = {}) => ({ id, type: "frame", ...(parentId ? { parentId } : {}), width: 320, height: 240, ...options });
const documents = [
  {
    name: "free",
    nodes: [
      frame("panel", null, { x: 10, y: 20, stroke: "#000", strokeWidth: 3, radius: 12, fill: "#fff" }),
      text("title", "panel", "Hello Rust renderer", { x: 14, y: 16, fill: "#202720", fontWeight: 600 }),
      { id: "icon", type: "icon", parentId: "panel", width: 24, height: 24, x: 24, y: 80, icon: "heart", fill: "rebeccapurple" },
    ],
  },
  { name: "unicode", nodes: [text("text", null, "Café a\u0301 💚 👩‍💻 日本語 中文\nनमस्ते\tשלום", { width: 73, height: 200, fontSize: 17, heightMode: "hug" })] },
  {
    name: "escapes",
    nodes: [
      text("text", null, '<script>alert("x")</script> & </style>\ud800', { width: 130, height: 140 }),
      {
        id: "image",
        type: "image",
        width: 20,
        height: 20,
        x: 200,
        src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      },
    ],
  },
  {
    name: "catalog",
    nodes: [
      text("heading", null, "An editorial heading", { fontFamily: "Newsreader", fontWeight: 550, widthMode: "hug", heightMode: "hug", fontSize: 28 }),
      text("body", null, "The same measured letters", { fontFamily: "Work Sans", fontWeight: 500, y: 70, fontSize: 18, heightMode: "hug" }),
    ],
  },
  {
    name: "fallbacks",
    nodes: [
      text("serif", null, "Georgia & serif fallback", { fontFamily: "Georgia, serif", heightMode: "hug", width: 93 }),
      text("mono", null, "mono wraps exactly", { fontFamily: "Courier New, monospace", y: 100, width: 99, heightMode: "hug" }),
      text("times", null, "Times New Roman", { fontFamily: "Times New Roman", y: 180, widthMode: "hug", heightMode: "hug" }),
    ],
  },
  { name: "hidden", nodes: [frame("hidden", null, { hidden: true }), text("child", "hidden", "invisible"), text("visible", null, "visible")] },
];
for (const direction of ["horizontal", "vertical", "free"])
  for (const mode of ["fixed", "hug", "fill"])
    for (const align of ["start", "center", "end"]) {
      documents.push({
        name: `layout-${direction}-${mode}-${align}`,
        nodes: [
          frame("root", null, {
            layout: direction,
            widthMode: mode,
            heightMode: mode,
            align,
            justify: align === "end" ? "space-between" : align,
            gap: 7,
            padding: 11,
            minWidth: 80,
            minHeight: 60,
          }),
          text("first", "root", "one two three four five", { width: 89, height: 25, widthMode: "fill", heightMode: "hug", minWidth: 40 }),
          frame("second", "root", {
            layout: "vertical",
            width: 70,
            height: 88,
            widthMode: "fill",
            heightMode: "fill",
            minHeight: 33,
            minWidth: 55,
            padding: 4,
            gap: 2,
          }),
          text("nested", "second", "Nested", { width: 50, height: 20, widthMode: "fill", heightMode: "hug" }),
          { id: "box", type: "ellipse", parentId: "root", width: 19, height: 31, fill: "#f00", stroke: "#000", strokeWidth: 1.5 },
        ],
      });
    }
for (const family of DESIGN_CATALOG_FAMILIES)
  documents.push({
    name: "font-" + family,
    nodes: [text("sample", null, "Aa àç€ — measured wrapping", { fontFamily: family, fontWeight: 650, width: 121, heightMode: "hug", fontSize: 21 })],
  });
documents.push({
  name: "render-byte-budget",
  nodes: Array.from({ length: 8 }, (_, index) => text("huge" + index, null, "W".repeat(20000), { width: 1, height: 16000, fontSize: 1, lineHeight: 0.5 })),
});
documents.push({
  name: "interactive-layer-order",
  options: { interactive: true, selectedId: "child" },
  nodes: [text("child", "parent", "Select this layer"), frame("parent", null), text("last", null, "Later", { y: 300 })],
});
const cases = [];
for (const fixture of documents) {
  const document = validateDesignDocument({ schemaVersion: 1, width: 390, height: 844, background: "#fafafa", nodes: fixture.nodes });
  await loadDesignFonts(document);
  try {
    cases.push({
      name: fixture.name,
      document,
      options: fixture.options,
      html: designHtml(document, fixture.options),
      bounds: Object.fromEntries(designLayout(document)),
    });
  } catch (error) {
    cases.push({ name: fixture.name, document, error: error.message });
  }
}
process.stdout.write(JSON.stringify(cases));
