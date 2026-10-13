import assert from "node:assert/strict";
import test from "node:test";
import { applyDesignOperations, designLayout, designTextLayout, validateDesignDocument } from "./design.mjs";

const document = (nodes) => validateDesignDocument({ schemaVersion: 1, width: 390, height: 844, nodes });
const text = { id: "text", type: "text", width: 300, height: 100, fontSize: 20, text: "Make room for a good day." };

test("hug text fits content and line height rather than its stored fixed fallback", () => {
  const bounds = designLayout(document([{ ...text, text: "Hi", widthMode: "hug", heightMode: "hug", lineHeight: 1.5 }])).get("text");
  assert.ok(bounds.width > 10 && bounds.width < 30);
  assert.equal(bounds.height, 30);
  const minimum = designLayout(document([{ ...text, text: "Hi", widthMode: "hug", minWidth: 80 }])).get("text");
  assert.equal(minimum.width, 80);
});

test("a rounded hug width never creates an extra line and grapheme clusters stay intact", () => {
  const node = { ...text, text: "Start a 10-minute walk", fontSize: 14, fontWeight: 700, widthMode: "hug", heightMode: "hug" };
  const box = designLayout(document([node])).get("text");
  assert.deepEqual(designTextLayout(node, box.width).lines, [node.text]);
  assert.equal(box.height, 18.9);
  const emoji = designTextLayout({ ...text, text: "👨‍👩‍👧‍👦🇧🇷", fontSize: 20 }, 20);
  assert.deepEqual(emoji.lines, ["👨‍👩‍👧‍👦", "🇧🇷"]);
});

test("vertical hug frames grow with wrapped fill-width text and keep subsequent content below it", () => {
  const scene = document([
    { id: "frame", type: "frame", width: 160, height: 500, heightMode: "hug", layout: "vertical", padding: 10, gap: 8 },
    { ...text, parentId: "frame", widthMode: "fill", heightMode: "hug" },
    { id: "button", type: "rectangle", parentId: "frame", width: 100, height: 40 },
  ]);
  const bounds = designLayout(scene);
  assert.equal(bounds.get("text").width, 140);
  assert.ok(bounds.get("text").height > 27);
  assert.equal(bounds.get("button").y, bounds.get("text").y + bounds.get("text").height + 8);
  assert.equal(bounds.get("frame").height, bounds.get("text").height + 40 + 8 + 20);
  const changed = applyDesignOperations(scene, [{ op: "update", id: "text", patch: { text: "Hi" } }]);
  assert.ok(designLayout(changed).get("frame").height < bounds.get("frame").height);
});

test("horizontal fills divide remaining space and honor one child's larger minimum", () => {
  const scene = document([
    { id: "frame", type: "frame", width: 300, height: 80, layout: "horizontal", padding: 10, gap: 8 },
    { id: "fixed", parentId: "frame", type: "rectangle", width: 60, height: 20 },
    { id: "a", parentId: "frame", type: "rectangle", width: 10, height: 20, widthMode: "fill", minWidth: 150 },
    { id: "b", parentId: "frame", type: "rectangle", width: 10, height: 20, widthMode: "fill", heightMode: "fill" },
  ]);
  const bounds = designLayout(scene);
  assert.equal(bounds.get("a").width, 150);
  assert.equal(bounds.get("b").width, 54);
  assert.equal(bounds.get("b").height, 60);
  assert.equal(bounds.get("b").x + bounds.get("b").width, 290);
});

test("a fill child inside a hug parent uses its fallback without a circular layout", () => {
  const bounds = designLayout(
    document([
      { id: "frame", type: "frame", width: 200, height: 80, widthMode: "hug", layout: "horizontal", padding: 10 },
      { ...text, parentId: "frame", width: 120, widthMode: "fill", heightMode: "hug" },
    ]),
  );
  assert.equal(bounds.get("frame").width, 140);
  assert.equal(bounds.get("text").width, 120);
});

test("text wrapping preserves explicit lines and long words with no executable markup", () => {
  const layout = designTextLayout({ ...text, text: "A\n\nOlá abcdefghijklmnopqrstuvwxyz", lineHeight: 1.2 }, 60);
  assert.deepEqual(layout.lines.slice(0, 2), ["A", ""]);
  assert.ok(layout.lines.length > 3);
  assert.equal(layout.height, layout.lines.length * 24);
  assert.ok(layout.lines.every((line) => designTextLayout({ ...text, text: line }).width <= 60.001));
});
