import test from "node:test";
import assert from "node:assert/strict";
import { validateDesignDocument, applyDesignOperations, designWarnings, validateDesignConsistency, rebaseDesignOnKit } from "./design.mjs";
const kit = {
  id: "project",
  version: 1,
  title: "App",
  colors: { ink: "#123456" },
  textStyles: { body: { fontSize: 17, fontWeight: 500 } },
  spacing: { md: 16 },
  radii: { card: 12 },
};
const document = {
  schemaVersion: 1,
  width: 390,
  height: 844,
  kit,
  background: "$ink",
  nodes: [
    { id: "card", type: "frame", width: 300, height: 200, bindings: { padding: "md", radius: "card" } },
    { id: "text", parentId: "card", type: "text", width: 250, height: 40, text: "Hello", textStyle: "body", fill: "$ink" },
  ],
};
test("pinned kit resolves styles and bindings identically before every render", () => {
  const doc = validateDesignDocument(document);
  assert.equal(doc.nodes[0].padding, 16);
  assert.equal(doc.nodes[0].radius, 12);
  assert.equal(doc.nodes[1].fontSize, 17);
  assert.equal(doc.tokens.ink, "#123456");
  assert.equal(document.nodes[0].padding, undefined);
  const after = applyDesignOperations(doc, [
    { op: "document", patch: { kit: { ...kit, version: 2, spacing: { md: 20 }, textStyles: { body: { fontSize: 22 } } } } },
  ]);
  assert.equal(after.nodes[0].padding, 20);
  assert.equal(after.nodes[1].fontSize, 22);
  assert.equal(doc.kit.version, 1);
  assert.throws(() => validateDesignDocument({ ...document, kit: undefined }), /needs a design kit/);
  assert.throws(() => validateDesignDocument({ ...document, nodes: [{ ...document.nodes[1], parentId: undefined, textStyle: "missing" }] }), /does not exist/);
});
test("deliberate token overrides remain visible as drift", () => {
  const doc = validateDesignDocument({ ...document, tokens: { ink: "#654321" } });
  assert.ok(designWarnings(doc).some((w) => w.kind === "kit-drift"));
  const detached = applyDesignOperations(doc, [
    { op: "unset", id: "text", fields: ["textStyle"] },
    { op: "update", id: "text", patch: { fontSize: 31 } },
  ]);
  assert.equal(detached.nodes[1].fontSize, 31);
  assert.ok(designWarnings(detached).some((w) => w.id === "text" && w.kind === "kit-drift"));
});

test("local property edits detach only the binding they override and survive save and migration", () => {
  const edited = applyDesignOperations(document, [
    { op: "update", id: "text", patch: { text: "Edited copy" } },
    { op: "update", id: "card", patch: { padding: 23 } },
  ]);
  assert.equal(edited.nodes[1].textStyle, "body");
  assert.deepEqual(edited.nodes[0].bindings, { radius: "card" });
  assert.equal(edited.nodes[0].padding, 23);
  const resized = applyDesignOperations(edited, [{ op: "update", id: "text", patch: { fontSize: 31 } }]);
  assert.equal(resized.nodes[1].textStyle, undefined);
  assert.equal(resized.nodes[1].fontWeight, 500);
  const migrated = applyDesignOperations(validateDesignDocument(resized), [
    { op: "document", patch: { kit: { ...kit, version: 2, textStyles: { body: { fontSize: 40 } }, spacing: { md: 24 }, radii: { card: 18 } } } },
  ]);
  assert.equal(migrated.nodes[0].padding, 23);
  assert.equal(migrated.nodes[0].radius, 18);
  assert.equal(migrated.nodes[1].fontSize, 31);
  const rebound = applyDesignOperations(migrated, [{ op: "update", id: "text", patch: { fontSize: 31, textStyle: "body" } }]);
  assert.equal(rebound.nodes[1].fontSize, 40);
});

test("kit checks use equivalent colors and skip hidden subtrees", () => {
  const doc = validateDesignDocument({
    ...document,
    kit: { ...kit, colors: { ink: "#ffffff" } },
    tokens: { ink: "white" },
    nodes: [
      { id: "hidden", type: "frame", width: 100, height: 100, hidden: true },
      { id: "copy", type: "text", parentId: "hidden", width: 100, height: 30, text: "Hidden", fontSize: 99, fill: "red" },
    ],
  });
  assert.equal(designWarnings(doc).filter((w) => w.kind === "kit-drift").length, 0);
  const drift = validateDesignDocument({ ...document, nodes: [{ id: "card", type: "frame", width: 100, height: 100, padding: 19, radius: 7, fill: "red" }] });
  assert.equal(designWarnings(drift).filter((w) => w.kind === "kit-drift").length, 3);
});

test("extra tokens and document backgrounds cannot hide palette drift", () => {
  const doc = validateDesignDocument({
    ...document,
    background: "$card",
    tokens: { card: "white" },
    nodes: [{ id: "card", type: "frame", width: 100, height: 100, fill: "$card" }],
  });
  const warnings = designWarnings(doc).filter((w) => w.kind === "kit-drift");
  assert.deepEqual(
    warnings.map((w) => w.id),
    ["$document", "card"],
  );
});

test("strict mode enforces effective values, including implicit fonts, paint and instance overrides", () => {
  const strict = validateDesignDocument({ ...document, consistency: { mode: "strict" } });
  assert.equal(validateDesignConsistency(strict), strict);
  for (const patch of [{ fill: "red" }, { fontSize: 22 }, { fontFamily: "Georgia, serif" }, { lineHeight: 2 }]) {
    const changed = applyDesignOperations(strict, [{ op: "update", id: "text", patch }]);
    assert.throws(() => validateDesignConsistency(changed), { code: "DESIGN_KIT_DRIFT" });
  }
  const implicit = validateDesignDocument({
    ...strict,
    nodes: [{ id: "text", type: "text", width: 200, height: 50, text: "Hello", fontSize: 17, fontWeight: 500 }],
  });
  assert.ok(designWarnings(implicit).some((w) => w.field === "fill"));
  const instance = validateDesignDocument({
    ...strict,
    nodes: [
      { id: "main", type: "frame", width: 100, height: 50, hidden: true, component: true, componentProperties: { color: { nodeId: "label", field: "fill" } } },
      { id: "label", parentId: "main", type: "text", width: 100, height: 50, text: "Label", textStyle: "body", fill: "$ink" },
      { id: "instance", type: "frame", width: 100, height: 50, componentId: "main", componentValues: { color: "red" } },
    ],
  });
  assert.throws(() => validateDesignConsistency(instance), { code: "DESIGN_KIT_DRIFT" });
  assert.throws(() => validateDesignConsistency({ ...strict, kit: undefined }), /requires a pinned/);
  assert.throws(() => validateDesignConsistency({ ...strict, kit: { ...kit, spacing: {} } }), /at least one spacing/);
});

test("a declared exception applies only to its exact effective value and keeps its reason visible", () => {
  const strict = validateDesignDocument({
    ...document,
    consistency: { mode: "strict" },
    tokens: { extra: "red" },
    nodes: [{ id: "card", type: "frame", width: 100, height: 100, fill: "$extra" }],
  });
  const exception = { nodeId: "card", field: "fill", value: "red", reason: "User chose this warning color" };
  const excepted = { ...strict, consistency: { mode: "strict", exceptions: [exception] } };
  validateDesignConsistency(excepted);
  assert.ok(designWarnings(excepted).some((w) => w.kind === "kit-exception" && w.message.includes(exception.reason)));
  const changed = { ...excepted, tokens: { ...excepted.tokens, extra: "blue" } };
  assert.throws(() => validateDesignConsistency(changed), { code: "DESIGN_KIT_DRIFT" });
  const unrelated = { ...excepted, nodes: [...excepted.nodes, { id: "other", type: "frame", width: 50, height: 50, fill: "red" }] };
  assert.throws(() => validateDesignConsistency(unrelated), { code: "DESIGN_KIT_DRIFT" });
});

test("a screen follows a newer kit version unless frozen, keeping its own tokens and changed components", () => {
  const button = [
    { id: "button", type: "frame", component: true, width: 120, height: 44, fill: "$ink", bindings: { radius: "card" } },
    { id: "button-label", parentId: "button", type: "text", width: 100, height: 24, text: "Go", textStyle: "body" },
  ];
  const v1 = { ...kit, colors: { ink: "#123456", paper: "#ffffff" }, components: { button } };
  const screen = validateDesignDocument({
    ...document,
    kit: v1,
    tokens: { brand: "#ff0000", paper: "#eeeeee" },
    nodes: [
      ...document.nodes,
      { ...button[0], x: 10, y: 300 },
      button[1],
      { id: "cta", type: "frame", componentId: "button", x: 10, y: 400, width: 120, height: 44 },
    ],
  });
  const v2 = {
    ...v1,
    version: 2,
    colors: { ink: "#000000", paper: "#ffffff" },
    radii: { card: 20 },
    textStyles: { body: { fontSize: 19 } },
    components: { button: [{ ...button[0], height: 52 }, button[1]] },
  };
  const { document: live, local } = rebaseDesignOnKit(screen, v2);
  assert.deepEqual(local, []);
  assert.equal(live.kit.version, 2);
  assert.equal(live.tokens.ink, "#000000");
  assert.equal(live.tokens.brand, "#ff0000");
  assert.equal(live.tokens.paper, "#eeeeee");
  assert.equal(live.nodes.find((n) => n.id === "card").radius, 20);
  assert.equal(live.nodes.find((n) => n.id === "text").fontSize, 19);
  const main = live.nodes.find((n) => n.id === "button");
  assert.deepEqual([main.x, main.y, main.height], [10, 300, 52]);
  assert.equal(live.nodes.find((n) => n.id === "cta").height, 52);
  assert.equal(rebaseDesignOnKit(validateDesignDocument({ ...screen, kitFrozen: true }), v2).document.kit.version, 1);
  assert.equal(rebaseDesignOnKit(live, v2).document, live);

  const changed = applyDesignOperations(screen, [{ op: "update", id: "button-label", patch: { text: "Buy" } }]);
  const kept = rebaseDesignOnKit(changed, v2);
  assert.deepEqual(kept.local, ["button"]);
  assert.equal(kept.document.nodes.find((n) => n.id === "button-label").text, "Buy");
  assert.equal(kept.document.nodes.find((n) => n.id === "button").height, 44);
  assert.throws(() => rebaseDesignOnKit(screen, { ...v2, textStyles: {} }), /does not exist/);
});

test("a kit component copy with a moved child stays local, and a template listing a child first keeps the screen's placement on its root", () => {
  const button = [
    { id: "button-label", parentId: "button", type: "text", x: 8, y: 8, width: 100, height: 24, text: "Go", textStyle: "body" },
    { id: "button", type: "frame", component: true, width: 120, height: 44, fill: "$ink" },
  ];
  const v1 = { ...kit, components: { button } };
  const v2 = { ...v1, version: 2, components: { button: [button[0], { ...button[1], height: 52 }] } };
  const screen = validateDesignDocument({ ...document, kit: v1, nodes: [{ ...button[1], x: 10, y: 300 }, button[0]] });
  const followed = rebaseDesignOnKit(screen, v2).document.nodes.find((n) => n.id === "button");
  assert.deepEqual([followed.x, followed.y, followed.height, followed.parentId], [10, 300, 52, undefined]);
  const moved = applyDesignOperations(screen, [{ op: "update", id: "button-label", patch: { x: 20 } }]);
  const kept = rebaseDesignOnKit(moved, v2);
  assert.deepEqual(kept.local, ["button"]);
  assert.equal(kept.document.nodes.find((n) => n.id === "button-label").x, 20);
});

test("a kit component copy whose layers were reordered stays local", () => {
  const card = [
    { id: "card", type: "frame", component: true, width: 200, height: 100, fill: "$ink" },
    { id: "card-title", parentId: "card", type: "text", width: 180, height: 24, text: "Title", textStyle: "body" },
    { id: "card-body", parentId: "card", type: "text", width: 180, height: 24, text: "Body", textStyle: "body" },
  ];
  const v1 = { ...kit, components: { card } };
  const v2 = { ...v1, version: 2, components: { card: [{ ...card[0], height: 120 }, card[1], card[2]] } };
  const screen = validateDesignDocument({ ...document, kit: v1, nodes: [card[0], card[2], card[1]] });
  const kept = rebaseDesignOnKit(screen, v2);
  assert.deepEqual(kept.local, ["card"]);
  assert.deepEqual(
    kept.document.nodes.map((n) => n.id),
    ["card", "card-body", "card-title"],
  );
  assert.deepEqual(rebaseDesignOnKit(validateDesignDocument({ ...document, kit: v1, nodes: card }), v2).local, []);
});

test("the design system board draws every token and component of a kit as one valid layer design", async () => {
  const { designSystemBoard, designHtml } = await import("./design.mjs");
  const full = {
    ...kit,
    version: 3,
    colors: { ink: "#123456", accent: { light: "#16a34a", dark: "#3cbb72" }, paper: "#ffffff", line: "#e0e1e3", danger: "#c62935" },
    textStyles: { title: { fontSize: 28, fontWeight: 700 }, body: { fontSize: 17, fontWeight: 500 } },
    spacing: { sm: 8, md: 16 },
    radii: { card: 12, pill: 999 },
    components: {
      button: [
        { id: "button", type: "frame", component: true, width: 140, height: 44, fill: "$accent", bindings: { radius: "card" } },
        { id: "label", parentId: "button", type: "text", x: 16, y: 10, width: 108, height: 24, text: "Place order", textStyle: "body", fill: "$paper" },
      ],
      chip: [{ id: "chip", type: "frame", component: true, width: 90, height: 28, fill: "$line", bindings: { radius: "pill" } }],
    },
  };
  const board = validateDesignDocument(designSystemBoard(full, { subtitle: "Version 3 · 12 screens follow it" }));
  const ids = new Set(board.nodes.map((node) => node.id));
  for (const id of [
    "color-accent",
    "color-danger",
    "type-title-sample",
    "spacing-md",
    "radius-pill",
    "component-button-button",
    "component-button-label",
    "component-chip-chip",
  ])
    assert.ok(ids.has(id), id);
  assert.equal(board.nodes.find((node) => node.id === "component-button-label").parentId, "component-button-button");
  assert.equal(board.nodes.find((node) => node.id === "type-title-sample").fontSize, 28);
  assert.ok(board.height > 400);
  assert.match(designHtml(board), /Place order/);
  assert.equal(
    validateDesignDocument(designSystemBoard({ ...kit, components: undefined })).nodes.some((node) => node.id.startsWith("component-")),
    false,
  );
});
