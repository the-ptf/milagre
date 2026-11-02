import test from "node:test";
import assert from "node:assert/strict";
import { validateDesignDocument, applyDesignOperations, designWarnings, validateDesignConsistency } from "./design.mjs";
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
