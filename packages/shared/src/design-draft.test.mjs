import assert from "node:assert/strict";
import test from "node:test";
import { createDesignDraft, designChanges, designReplay, parsePartialJson } from "./design-draft.mjs";
import { designLiveParts } from "./design.mjs";

test("parsePartialJson keeps whole members and items, and the container being written", () => {
  assert.deepEqual(parsePartialJson('{"title":"Log'), {});
  assert.deepEqual(parsePartialJson('{"title":"Login","document":{"width":39'), { title: "Login", document: {} });
  assert.deepEqual(parsePartialJson('{"title":"Login","document":{"width":390,"nodes":[{"id":"a","type":"text"},{"id":"b"'), {
    title: "Login",
    document: { width: 390, nodes: [{ id: "a", type: "text" }] },
  });
  assert.deepEqual(parsePartialJson('{"a":[1,2,3],"b":true,"c":null,"d":"x\\"y"}'), { a: [1, 2, 3], b: true, c: null, d: 'x"y' });
  assert.deepEqual(parsePartialJson('{"a":tr'), {});
  assert.deepEqual(parsePartialJson("  "), undefined);
  assert.deepEqual(parsePartialJson('{"a":1,'), { a: 1 });
  assert.deepEqual(parsePartialJson('{"a":"\\u00e9'), {});
  // Not the start of JSON.
  assert.equal(parsePartialJson('{"a" 1}'), undefined);
  assert.equal(parsePartialJson("{a:1}"), undefined);
  assert.equal(parsePartialJson("[1 2]"), undefined);
});

const node = (id, extra = {}) => ({ id, type: "rectangle", x: 10, y: 10, width: 40, height: 40, ...extra });
const json = (value) => JSON.stringify(value);

test("a design_show draft renders the whole layers so far, inside frames that are there", () => {
  const input = json({
    title: "Login",
    group: "Auth",
    document: {
      schemaVersion: 1,
      width: 390,
      height: 844,
      tokens: { brand: "#336699" },
      nodes: [
        node("card", { type: "frame" }),
        node("title", { parentId: "card", type: "text", text: "Hi", fill: "$brand" }),
        node("button", { parentId: "card" }),
      ],
    },
    id: "login",
  });
  const draft = createDesignDraft("design_show");
  // Before the screen's size there is nothing to render.
  assert.equal(draft.read(input.slice(0, input.indexOf('"width"') + 5)).document, null);
  const partial = draft.read(input.slice(0, input.indexOf('{"id":"button"') + 8));
  assert.deepEqual(
    partial.document.nodes.map((item) => item.id),
    ["card", "title"],
  );
  assert.deepEqual(partial.changed, ["card", "title"]);
  assert.equal(partial.title, "Login");
  assert.equal(partial.group, "Auth");
  assert.equal(partial.designId, null);
  const whole = draft.read(input);
  assert.equal(whole.designId, "login");
  assert.deepEqual(whole.changed, ["button"]);
  // Reading the same input again changes nothing.
  assert.deepEqual(draft.read(input).changed, []);
  assert.ok(designLiveParts(whole.document).markup.includes('data-design-node="button"'));
});

test("a design_show draft leaves out layers the document would refuse, and waits for a parent written later", () => {
  const draft = createDesignDraft("design_show");
  const snapshot = draft.read(
    json({
      title: "x",
      document: {
        width: 390,
        height: 844,
        nodes: [
          node("child", { parentId: "later" }),
          node("bad", { width: -4 }),
          node("icon", { type: "icon", icon: "no-such-icon" }),
          node("token", { fill: "$missing" }),
          node("later", { type: "frame" }),
        ],
      },
    }),
  );
  assert.deepEqual(
    snapshot.document.nodes.map((item) => item.id),
    ["child", "token", "later"],
  );
  assert.equal(snapshot.document.nodes[1].fill, undefined);
});

test("a design_apply draft applies the whole operations so far to its base, skipping one it would refuse", () => {
  const base = { schemaVersion: 1, width: 390, height: 844, nodes: [node("a"), node("b")] };
  const input = json({
    id: "login",
    expectedVersion: 2,
    operations: [
      { op: "update", id: "a", patch: { fill: "#ff0000" } },
      { op: "update", id: "missing", patch: { fill: "#ff0000" } },
      { op: "insert", node: node("c") },
      { op: "delete", id: "b" },
    ],
  });
  const draft = createDesignDraft("design_apply");
  assert.equal(draft.read(input, null).document, null, "no base yet");
  const start = draft.read(input.slice(0, 40), base);
  assert.equal(start.designId, "login");
  // The base alone changes nothing: the frame already shows it.
  assert.equal(start.document, base);
  assert.deepEqual(start.changed, []);
  const first = draft.read(input.slice(0, input.indexOf('{"op":"update","id":"missing"')), base);
  assert.equal(first.document.nodes[0].fill, "#ff0000");
  assert.deepEqual(first.changed, ["a"]);
  // Several operations in one read: the changes follow the order the agent made them in, not the document's.
  const reordered = createDesignDraft("design_apply").read(
    json({
      id: "login",
      expectedVersion: 2,
      operations: [
        { op: "update", id: "b", patch: { x: 1 } },
        { op: "update", id: "a", patch: { x: 2 } },
      ],
    }),
    base,
  );
  assert.deepEqual(reordered.changed, ["b", "a"]);
  const done = draft.read(input, base);
  assert.deepEqual(
    done.document.nodes.map((item) => item.id),
    ["a", "c"],
  );
  assert.deepEqual(done.changed, ["c"]);
});

test("designChanges and designReplay play a change back in reading order, ending on the new version", () => {
  const before = { schemaVersion: 1, width: 390, height: 844, nodes: [node("old"), node("keep"), node("edit")] };
  const after = {
    schemaVersion: 1,
    width: 390,
    height: 844,
    nodes: [node("keep"), node("edit", { fill: "#00ff00" }), node("frame", { type: "frame" }), node("inner", { parentId: "frame" })],
  };
  assert.deepEqual(designChanges(before, after), { changed: ["edit", "frame", "inner"], removed: ["old"] });
  const steps = designReplay(before, after);
  assert.deepEqual(
    steps.map((step) => step.changed),
    [["edit"], ["frame"], ["inner"]],
  );
  assert.deepEqual(
    steps[0].document.nodes.map((item) => item.id),
    ["keep", "edit"],
  );
  assert.deepEqual(steps.at(-1).document, after);
  // Many layers are grouped into at most maxSteps steps.
  const many = { ...after, nodes: Array.from({ length: 40 }, (_, index) => node(`n${index}`)) };
  const grouped = designReplay({ ...many, nodes: [] }, many, 10);
  assert.equal(grouped.length, 10);
  assert.equal(grouped.flatMap((step) => step.changed).length, 40);
  assert.deepEqual(designReplay(after, after), []);
});
