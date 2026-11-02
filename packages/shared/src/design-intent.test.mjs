import assert from "node:assert/strict";
import test from "node:test";
import { applyDesignOperations, designDiagnostics, designLayout, validateDesignDocument } from "./design.mjs";

const make = (extra = {}) =>
  validateDesignDocument({
    schemaVersion: 1,
    width: 390,
    height: 844,
    background: "white",
    nodes: [
      { id: "card", type: "frame", width: 300, height: 200, layout: "vertical", gap: 8 },
      { id: "title", parentId: "card", type: "text", width: 280, height: 30, text: "Hi", fill: "black", fontSize: 17 },
      { id: "body", parentId: "card", type: "text", width: 280, height: 30, text: "Human edit", fill: "black" },
    ],
    ...extra,
  });
const textOnly = { mode: "text-only", textIds: ["title"] };
const fit = { mode: "fit-text", textIds: ["title"], layoutIds: ["card"] };
const edit = (text) => ({ op: "update", id: "title", patch: { text } });

test("text-only preserves manual edits and metadata, but reports clipped new text", () => {
  const before = make();
  const after = applyDesignOperations(before, [edit("A long title ".repeat(20))], textOnly);
  assert.deepEqual(after.nodes[2], before.nodes[2]);
  assert.equal(before.nodes[1].text, "Hi");
  assert.deepEqual(designLayout(after), designLayout(before));
  assert.ok(designDiagnostics(after).warnings.some((w) => w.kind === "clipped-text"));
});
test("intent rejects unrelated copy, styles, kit policy, deletion and replacement bypasses", () => {
  const before = make();
  const forbidden = [
    { op: "update", id: "body", patch: { text: "Lost user edit" } },
    { op: "update", id: "title", patch: { fill: "red" } },
    { op: "document", patch: { consistency: { mode: "advisory" } } },
    { op: "delete", id: "body" },
    { op: "replace", document: { ...before, nodes: before.nodes.map((n) => (n.id === "body" ? { ...n, text: "Lost" } : n)) } },
  ];
  for (const operation of forbidden)
    for (const intent of [textOnly, fit])
      assert.throws(
        () => applyDesignOperations(before, [operation], intent),
        (e) => e.code === "DESIGN_INTENT_VIOLATION",
      );
});
test("text-only catches implicit hug resizing and sibling movement", () => {
  const before = make();
  before.nodes[1].heightMode = "hug";
  assert.throws(() => applyDesignOperations(before, [edit("More words ".repeat(10))], textOnly), /Automatic layout/);
});
test("fit-text requires declared layout scope and rejects unresolved clipping atomically", () => {
  const before = make();
  const ops = [edit("More words ".repeat(9)), { op: "update", id: "title", patch: { heightMode: "hug" } }];
  assert.throws(() => applyDesignOperations(before, ops, { mode: "fit-text", textIds: ["title"] }), /Automatic layout/);
  const after = applyDesignOperations(before, ops, fit);
  assert.equal(after.nodes[2].text, "Human edit");
  assert.deepEqual(designDiagnostics(after).warnings, []);
  assert.throws(() => applyDesignOperations(before, [edit("More words ".repeat(9))], fit), /still has layout problems/);
  assert.throws(() => applyDesignOperations(before, [edit("More words ".repeat(99)), ...ops.slice(1)], fit), /layout problems/);
});
test("fit-text blocks new text overlap in free layout and ancestor clipping", () => {
  const before = make();
  delete before.nodes[0].layout;
  before.nodes[2].y = 40;
  assert.throws(
    () => applyDesignOperations(before, [edit("More words ".repeat(9)), { op: "update", id: "title", patch: { heightMode: "hug" } }], fit),
    /overlap/,
  );
  const outer = make();
  outer.nodes[0].x = 350;
  assert.throws(() => applyDesignOperations(outer, [edit("Hello")], { mode: "fit-text", textIds: ["title"] }), /layout problems/);
});
test("unknown targets and layoutIds under text-only reject; legacy batches remain compatible", () => {
  assert.throws(() => applyDesignOperations(make(), [edit("Hi")], { mode: "text-only", textIds: ["missing"] }), /existing text/);
  assert.throws(() => applyDesignOperations(make(), [edit("Hi")], { ...textOnly, layoutIds: ["card"] }), /does not allow/);
  assert.equal(applyDesignOperations(make(), [{ op: "update", id: "title", patch: { fill: "red" } }]).nodes[1].fill, "red");
});

test("diagnostics expose shortage, limiting container and reviewable candidate operations", () => {
  const document = make();
  document.nodes[1].text = "Long words ".repeat(9);
  const problem = designDiagnostics(document).warnings.find((w) => w.kind === "clipped-text");
  assert.equal(problem.blockerId, "title");
  assert.ok(problem.measurements.missingHeight > 0);
  assert.equal(problem.measurements.requiredHeight - problem.measurements.availableHeight, problem.measurements.missingHeight);
  const repaired = applyDesignOperations(document, problem.suggestions[0].operations);
  assert.ok(!designDiagnostics(repaired).warnings.some((w) => w.id === "title" && w.kind === "clipped-text"));
  document.nodes[2].width = 350;
  const overflow = designDiagnostics(document).warnings.find((w) => w.id === "body");
  assert.equal(overflow.blockerId, "card");
  assert.equal(overflow.measurements.right, 50);
  assert.equal(overflow.suggestions[0].operations, undefined);
  assert.match(overflow.suggestions[0].label, /automatic layout/);
});

test("text-only permits declared main text propagation without changing component identity", async () => {
  const { createDesignInstance } = await import("./design.mjs");
  let before = make({
    nodes: [
      { id: "button", type: "frame", component: true, width: 180, height: 50, hidden: true },
      { id: "label", parentId: "button", type: "text", width: 160, height: 30, text: "Start", fill: "black" },
    ],
  });
  before = applyDesignOperations(before, createDesignInstance(before, "button", "start", { x: 20, y: 40 }));
  const after = applyDesignOperations(before, [{ op: "update", id: "label", patch: { text: "Walk" } }], { mode: "text-only", textIds: ["label"] });
  const generated = after.nodes.find((n) => n.componentSourceId === "label");
  assert.equal(generated.text, "Walk");
  assert.deepEqual(designLayout(after), designLayout(before));
  assert.equal(after.nodes.find((n) => n.id === "start").componentId, "button");
});

test("contrast suggestions use resolved palette values and free-layout moves clear edge overflow", () => {
  const before = make({
    background: "white",
    tokens: { ink: "black" },
    nodes: [{ id: "text", type: "text", width: 100, height: 40, x: 350, text: "Unreadable", fill: "white" }],
  });
  const diagnostics = designDiagnostics(before);
  const color = diagnostics.warnings.find((w) => w.kind === "low-contrast");
  assert.equal(color.measurements.minimumRatio, 3);
  const outside = diagnostics.warnings.find((w) => w.kind === "off-canvas");
  assert.equal(outside.blockerId, "$canvas");
  const after = applyDesignOperations(before, [...color.suggestions[0].operations, ...outside.suggestions[0].operations]);
  assert.deepEqual(designDiagnostics(after).warnings, []);
});
