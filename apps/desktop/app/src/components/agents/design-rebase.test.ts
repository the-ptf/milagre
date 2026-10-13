import assert from "node:assert/strict";
import test from "node:test";
import { createExampleDesign, createDesignInstance, applyDesignOperations, type DesignDocument } from "@milagre/shared/design";
import { rebaseDesign, describeDesignChanges, isDesignVersionConflict } from "./design-rebase.ts";

test("disjoint local and latest fields merge without discarding latest values", () => {
  const base = createExampleDesign();
  const mine = applyDesignOperations(base, [{ op: "update", id: "heading", patch: { text: "My heading" } }]);
  const latest = applyDesignOperations(base, [{ op: "update", id: "heading", patch: { fill: "#ff0000" } }]);
  const result = rebaseDesign(base, mine, latest);
  assert.equal(result.structural, false);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.document!.nodes.find((node) => node.id === "heading")!.text, "My heading");
  assert.equal(result.document!.nodes.find((node) => node.id === "heading")!.fill, "#ff0000");
});

test("overlap needs explicit field choices and preserves unrelated remote edits", () => {
  const base = createExampleDesign();
  const mine = applyDesignOperations(base, [{ op: "update", id: "heading", patch: { text: "Mine" } }]);
  const latest = applyDesignOperations(base, [{ op: "update", id: "heading", patch: { text: "Latest", fill: "#ff0000" } }]);
  const review = rebaseDesign(base, mine, latest);
  assert.deepEqual(
    review.conflicts.map((field) => field.key),
    [JSON.stringify(["node", "heading", "text"])],
  );
  assert.equal(review.document!.nodes.find((node) => node.id === "heading")!.text, "Latest");
  const accepted = rebaseDesign(base, mine, latest, { [JSON.stringify(["node", "heading", "text"])]: "mine" });
  assert.equal(accepted.document!.nodes.find((node) => node.id === "heading")!.text, "Mine");
  assert.equal(accepted.document!.nodes.find((node) => node.id === "heading")!.fill, "#ff0000");
  assert.equal(mine.nodes.find((node) => node.id === "heading")!.fill, base.nodes.find((node) => node.id === "heading")!.fill);
});

test("screen, node and token conflicts cannot share a field choice", () => {
  const base = applyDesignOperations(createExampleDesign(), [{ op: "insert", node: { id: "screen", type: "rectangle", width: 100, height: 100 } }]);
  const mine = applyDesignOperations({ ...base, width: 410, tokens: { ...base.tokens, fill: "#111111" } }, [
    { op: "update", id: "screen", patch: { width: 120 } },
  ]);
  const latest = applyDesignOperations({ ...base, width: 430, tokens: { ...base.tokens, fill: "#222222" } }, [
    { op: "update", id: "screen", patch: { width: 140 } },
  ]);
  const result = rebaseDesign(base, mine, latest, { [JSON.stringify(["screen", "width"])]: "mine" });
  assert.equal(new Set(result.conflicts.map((field) => field.key)).size, 3);
  assert.equal(result.document!.width, 410);
  assert.equal(result.document!.nodes.find((node) => node.id === "screen")!.width, 140);
  assert.equal(result.document!.tokens!.fill, "#222222");
});

test("structural edits are blocked from automatic rebasing and named for review", () => {
  const base = createExampleDesign();
  const latest = applyDesignOperations(base, [{ op: "delete", id: "footer" }]);
  const result = rebaseDesign(base, base, latest);
  assert.equal(result.structural, true);
  assert.equal(result.document, null);
  assert.match(describeDesignChanges(base, latest).join("\n"), /Deleted layer: Footer/);
});

test("linked instance derived fields never create ineffective conflict choices", () => {
  let base = applyDesignOperations(createExampleDesign(), [{ op: "update", id: "note", patch: { component: true } }]);
  base = applyDesignOperations(base, createDesignInstance(base, "note", "note-instance", { x: 24, y: 740 }));
  const mine = applyDesignOperations(base, [
    { op: "update", id: "note", patch: { width: 280 } },
    { op: "update", id: "note-instance", patch: { x: 40, hidden: true } },
  ]);
  const latest = applyDesignOperations(base, [
    { op: "update", id: "note", patch: { width: 300 } },
    { op: "update", id: "note-instance", patch: { y: 760, locked: true } },
  ]);
  const result = rebaseDesign(base, mine, latest);
  assert.deepEqual(
    result.conflicts.map((field) => field.key),
    [JSON.stringify(["node", "note", "width"])],
  );
  const instance = result.document!.nodes.find((node) => node.id === "note-instance")!;
  assert.equal(instance.width, 300);
  assert.equal(instance.x, 40);
  assert.equal(instance.y, 760);
  assert.equal(instance.hidden, true);
  assert.equal(instance.locked, true);
  const chosen = rebaseDesign(base, mine, latest, { [JSON.stringify(["node", "note", "width"])]: "mine" });
  assert.equal(chosen.document!.nodes.find((node) => node.id === "note-instance")!.width, 280);
});

test("invalid combinations report their validation cause without claiming layer structure changed", () => {
  const base: DesignDocument = {
    schemaVersion: 1,
    width: 240,
    height: 240,
    tokens: { accent: "#112233" },
    nodes: [{ id: "rectangle", type: "rectangle", width: 20, height: 20, fill: "#ffffff" }],
  };
  const mine = { ...base, tokens: {} };
  const latest = applyDesignOperations(base, [{ op: "update", id: "rectangle", patch: { fill: "$accent" } }]);
  const result = rebaseDesign(base, mine, latest);
  assert.equal(result.structural, false);
  assert.equal(result.document, null);
  assert.match(result.error, /Color token "\$accent" does not exist/);
});

test("only the exact backend version conflict prefix opens conflict recovery", () => {
  assert.equal(isDesignVersionConflict("Design version conflict: expected version 2, but the latest is 3."), true);
  assert.equal(isDesignVersionConflict("Error invoking remote method 'artifact:apply': Error: Design version conflict: expected version 2"), true);
  assert.equal(isDesignVersionConflict("This version of the host does not support images."), false);
  assert.equal(isDesignVersionConflict("The file changed while exporting."), false);
});
