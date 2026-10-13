import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDesignOperations,
  createDesignInstance,
  detachDesignInstance,
  designInstanceRoot,
  diffDesignDocuments,
  validateDesignDocument,
} from "./design.mjs";

const scene = () =>
  validateDesignDocument({
    schemaVersion: 1,
    width: 390,
    height: 844,
    nodes: [
      { id: "button", type: "frame", name: "Button", width: 180, height: 44, component: true, fill: "#123456", layout: "horizontal" },
      { id: "label", type: "text", parentId: "button", width: 100, height: 24, text: "Continue" },
    ],
  });
const withInstance = () => applyDesignOperations(scene(), createDesignInstance(scene(), "button", "copy", { x: 20, y: 100 }));

test("linked instances propagate main edits, preserving their position and descendant ids", () => {
  const before = withInstance();
  const child = before.nodes.find((node) => node.componentSourceId === "label");
  assert.equal(designInstanceRoot(before, child.id).id, "copy");
  const after = applyDesignOperations(before, [{ op: "update", id: "label", patch: { text: "Get started" } }]);
  assert.equal(after.nodes.find((node) => node.id === child.id).text, "Get started");
  assert.equal(after.nodes.find((node) => node.id === "copy").y, 100);
  assert.deepEqual(diffDesignDocuments(before, after), [{ op: "update", id: "label", patch: { text: "Get started" } }]);
  assert.deepEqual(applyDesignOperations(before, diffDesignDocuments(before, after)), after);
});

test("detach makes an independent frame and allows edits without changing the main component", () => {
  const before = withInstance();
  const child = before.nodes.find((node) => node.componentSourceId === "label");
  assert.throws(() => applyDesignOperations(before, [{ op: "update", id: child.id, patch: { text: "Local" } }]), /detach/);
  const detached = applyDesignOperations(before, detachDesignInstance(before, "copy"));
  assert.equal(designInstanceRoot(detached, child.id), null);
  const after = applyDesignOperations(detached, [{ op: "update", id: child.id, patch: { text: "Local" } }]);
  assert.equal(after.nodes.find((node) => node.id === "label").text, "Continue");
  assert.equal(after.nodes.find((node) => node.id === child.id).text, "Local");
});

test("main insertions and deletions update instances and deleting a used main component is actionable", () => {
  const before = withInstance();
  const after = applyDesignOperations(before, [
    { op: "insert", node: { id: "icon", type: "ellipse", parentId: "button", width: 12, height: 12 } },
    { op: "delete", id: "label" },
  ]);
  assert.equal(after.nodes.filter((node) => node.componentSourceId === "icon").length, 1);
  assert.equal(
    after.nodes.some((node) => node.componentSourceId === "label"),
    false,
  );
  assert.throws(() => applyDesignOperations(after, [{ op: "delete", id: "button" }]), /Detach its instances/);
  assert.equal(applyDesignOperations(after, [{ op: "delete", id: "copy" }]).nodes.length, 2);
});

test("nested main components and instance subtrees are rejected atomically", () => {
  const before = withInstance();
  assert.throws(() => applyDesignOperations(before, [{ op: "update", id: "copy", patch: { parentId: "button" } }]), /Nested/);
  assert.throws(() => applyDesignOperations(before, [{ op: "update", id: "label", patch: { component: true } }]), /must be a frame/);
  assert.throws(
    () => applyDesignOperations(before, [{ op: "insert", node: { id: "extra", parentId: "copy", type: "text", width: 20, height: 20 } }]),
    /detach/,
  );
  assert.equal(before.nodes.length, 4);
});

test("moving an ordinary layer into an instance is rejected without dropping it", () => {
  const before = applyDesignOperations(withInstance(), [{ op: "insert", node: { id: "note", type: "rectangle", width: 20, height: 20 } }]);
  assert.throws(() => applyDesignOperations(before, [{ op: "update", id: "note", patch: { parentId: "copy" } }]), /detach/i);
  assert.ok(before.nodes.some((node) => node.id === "note" && !node.parentId));
});

test("documents and replacements cannot discard hand-written instance children", () => {
  const before = withInstance();
  const invalid = { ...before, nodes: [...before.nodes, { id: "note", type: "rectangle", parentId: "copy", width: 20, height: 20 }] };
  assert.throws(() => validateDesignDocument(invalid), /detach/i);
  assert.throws(() => applyDesignOperations(before, [{ op: "replace", document: invalid }]), /detach/i);
  assert.equal(invalid.nodes.at(-1).id, "note");
});

test("turning a populated frame into an instance cannot discard its children", () => {
  const before = applyDesignOperations(scene(), [
    { op: "insert", node: { id: "ordinary", type: "frame", width: 50, height: 50 } },
    { op: "insert", node: { id: "note", type: "rectangle", parentId: "ordinary", width: 20, height: 20 } },
  ]);
  assert.throws(() => applyDesignOperations(before, [{ op: "update", id: "ordinary", patch: { componentId: "button" } }]), /detach/i);
  assert.equal(before.nodes.find((node) => node.id === "note").parentId, "ordinary");
});

test("forged and duplicate component source references are rejected rather than discarded", () => {
  const before = withInstance();
  for (const componentSourceId of ["missing", "button", "label"]) {
    const invalid = {
      ...before,
      nodes: [...before.nodes, { id: "forged", type: "text", parentId: "copy", componentSourceId, width: 20, height: 20, text: "Keep me" }],
    };
    assert.throws(() => validateDesignDocument(invalid), /source/i);
    assert.throws(() => applyDesignOperations(before, [{ op: "replace", document: invalid }]), /source/i);
  }
});

test("moving a main component child outside it retires only its previously generated copies", () => {
  const before = withInstance();
  const after = applyDesignOperations(before, [
    { op: "insert", node: { id: "outside", type: "frame", width: 300, height: 100 } },
    { op: "update", id: "label", patch: { parentId: "outside" } },
  ]);
  assert.equal(after.nodes.find((node) => node.id === "label").parentId, "outside");
  assert.equal(
    after.nodes.some((node) => node.componentSourceId === "label"),
    false,
  );
  assert.equal(before.nodes.filter((node) => node.componentSourceId === "label").length, 1);
});

test("replacement references cannot inherit validity from the previous document", () => {
  const before = withInstance();
  const missingSource = { ...before, nodes: before.nodes.filter((node) => node.id !== "label") };
  assert.throws(() => applyDesignOperations(before, [{ op: "replace", document: missingSource }]), /source/i);
  const otherMain = {
    ...before,
    nodes: [
      ...before.nodes.map((node) => (node.componentSourceId ? { ...node, componentSourceId: "other-label" } : node)),
      { id: "other-main", type: "frame", component: true, width: 180, height: 44 },
      { id: "other-label", type: "text", parentId: "other-main", width: 100, height: 24, text: "Other" },
    ],
  };
  assert.throws(() => applyDesignOperations(before, [{ op: "replace", document: otherMain }]), /source/i);
  const duplicated = {
    ...before,
    nodes: [...before.nodes, { ...before.nodes.find((node) => node.componentSourceId), id: "duplicate" }],
  };
  assert.throws(
    () =>
      applyDesignOperations(before, [
        { op: "replace", document: duplicated },
        { op: "delete", id: "label" },
      ]),
    /source/i,
  );
});

test("valid replacement references still follow later main edits in the same batch", () => {
  const before = withInstance();
  const after = applyDesignOperations(before, [
    { op: "replace", document: before },
    { op: "delete", id: "label" },
  ]);
  assert.deepEqual(
    after.nodes.map((node) => node.id),
    ["button", "copy"],
  );
  const invalidRoot = { ...before, nodes: before.nodes.map((node) => (node.id === "copy" ? { ...node, componentSourceId: "label" } : node)) };
  assert.throws(() => validateDesignDocument(invalidRoot), /source/i);
});
