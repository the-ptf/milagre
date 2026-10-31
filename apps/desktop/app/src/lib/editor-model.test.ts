import assert from "node:assert/strict";
import test from "node:test";
import type { PromptPart } from "@milagre/shared/prompt-parts";
import type { EditorNode } from "./editor-model.ts";
import {
  caretStep,
  markFiller,
  createEditHistory,
  deleteBackward,
  deleteForward,
  domOffsetToText,
  editorLayout,
  replaceRange,
  textOf,
  textOffsetToDom,
} from "./editor-model.ts";

// A DOM-free stand-in: just the fields the model reads.
type Fake = EditorNode & { childNodes: Fake[]; parentNode: Fake | null; attrs: Record<string, string> };
function el(name: string, attrs: Record<string, string>, ...children: Fake[]): Fake {
  const node: Fake = { nodeType: 1, nodeName: name, nodeValue: null, childNodes: children, parentNode: null, attrs, getAttribute: (key) => attrs[key] ?? null };
  for (const child of children) child.parentNode = node;
  return node;
}
const text = (value: string): Fake => ({ nodeType: 3, nodeName: "#text", nodeValue: value, childNodes: [], parentNode: null, attrs: {} });
const br = () => el("BR", {});
const chip = (source: string) => el("SPAN", { contenteditable: "false", "data-chip": "", "data-text": source }, el("SPAN", {}, text("X")));

test("a chip counts as its source text", () => {
  // "a /x b" with /x as a chip.
  const before = text("a ");
  const skill = chip("/x");
  const after = text(" b");
  const root = el("DIV", {}, before, skill, after, br());
  assert.equal(textOf(root), "a /x b");
  assert.equal(domOffsetToText(root, after, 0), 4, "right after the chip");
  assert.equal(domOffsetToText(root, root, 2), 4, "the gap after the chip");
  assert.equal(domOffsetToText(root, root, 1), 2, "the gap before the chip");
  assert.equal(domOffsetToText(root, skill.childNodes[0].childNodes[0], 0), 4, "inside a chip snaps past it");
  assert.deepEqual(textOffsetToDom(root, 4), { node: after, offset: 0 }, "text offset 4 maps to after the chip, in the text that follows");
  assert.deepEqual(textOffsetToDom(root, 5), { node: after, offset: 1 });
  assert.deepEqual(textOffsetToDom(root, 2), { node: before, offset: 2 }, "the end of text before a chip prefers the text node");
  assert.deepEqual(textOffsetToDom(root, 3), { node: root, offset: 2 }, "a caret can't stand inside a chip");
});

test("line breaks count once and the closing break counts nothing", () => {
  const first = text("one");
  const second = text("two");
  const root = el("DIV", {}, first, br(), second, br());
  assert.equal(textOf(root), "one\ntwo");
  assert.equal(domOffsetToText(root, second, 1), 5);
  assert.equal(domOffsetToText(root, root, 2), 4, "after the break");
  assert.deepEqual(textOffsetToDom(root, 4), { node: second, offset: 0 });
  assert.deepEqual(textOffsetToDom(root, 3), { node: first, offset: 3 });
  assert.equal(domOffsetToText(root, root, 4), 7, "past the closing break is the end");

  // A trailing newline needs a second break so the empty line renders.
  const trailing = el("DIV", {}, text("one"), br(), br());
  assert.equal(textOf(trailing), "one\n");
  assert.deepEqual(textOffsetToDom(trailing, 4), { node: trailing, offset: 2 }, "the empty last line");
  assert.equal(textOf(el("DIV", {}, br())), "");
  assert.deepEqual(textOffsetToDom(el("DIV", {}, br()), 0).offset, 0);
});

test("blocks a browser leaves behind read as lines", () => {
  // What Chrome makes of Enter or a composition in an empty field.
  const root = el("DIV", {}, text("a"), el("DIV", {}, text("b")), el("DIV", {}, br()), el("DIV", {}, text("c")));
  assert.equal(textOf(root), "a\nb\n\nc");
  const last = root.childNodes[3].childNodes[0];
  assert.equal(domOffsetToText(root, last, 1), 6);
  assert.deepEqual(textOffsetToDom(root, 6), { node: last, offset: 1 });
});

test("the layout renders text, breaks and chips, ending in a closing break", () => {
  const parts: PromptPart[] = [
    { kind: "text", text: "use " },
    { kind: "skill", text: "/tldr", name: "tldr" },
    { kind: "text", text: "\n\nnext " },
    { kind: "file", text: '@"src/my app.ts"', path: "src/my app.ts" },
  ];
  // A chip that ends its line is followed by a zero-width filler, so the caret has a place after it.
  assert.deepEqual(editorLayout('use /tldr\n\nnext @"src/my app.ts"', parts), [
    { kind: "text", text: "use " },
    { kind: "chip", part: parts[1] },
    { kind: "filler" },
    { kind: "break" },
    { kind: "break" },
    { kind: "text", text: "next " },
    { kind: "chip", part: parts[3] },
    { kind: "filler" },
    { kind: "break" },
  ]);
  assert.deepEqual(editorLayout("/x\nb", skillParts("/x\nb")), [
    { kind: "chip", part: skillParts("/x\nb")[0] },
    { kind: "filler" },
    { kind: "break" },
    { kind: "text", text: "b" },
    { kind: "break" },
  ]);
  assert.deepEqual(editorLayout("", []), [{ kind: "break" }]);
  // Parts that no longer spell the value are ignored rather than trusted.
  assert.deepEqual(editorLayout("ab", [{ kind: "text", text: "a" }]), [{ kind: "text", text: "ab" }, { kind: "break" }]);
});

const skillParts = (value: string): PromptPart[] => {
  const start = value.indexOf("/x");
  if (start < 0) return [{ kind: "text", text: value }];
  return [
    ...(start ? [{ kind: "text" as const, text: value.slice(0, start) }] : []),
    { kind: "skill", text: "/x", name: "x" },
    ...(start + 2 < value.length ? [{ kind: "text" as const, text: value.slice(start + 2) }] : []),
  ];
};

test("the filler after a chip counts nothing and holds the caret", () => {
  const filler = text("\u200B");
  markFiller(filler);
  const root = el("DIV", {}, text("a "), chip("/x"), filler, br());
  assert.equal(textOf(root), "a /x");
  assert.deepEqual(textOffsetToDom(root, 4), { node: filler, offset: 1 }, "after the chip, past the filler");
  assert.equal(domOffsetToText(root, filler, 0), 4);
  assert.equal(domOffsetToText(root, filler, 1), 4);
  assert.equal(domOffsetToText(root, root, 3), 4, "before the closing break");
  // Text a browser puts into the filler (an IME composition) reads back without it.
  const typed = text("\u200B日本");
  markFiller(typed);
  const composed = el("DIV", {}, chip("/x"), typed, br());
  assert.equal(textOf(composed), "/x日本");
  assert.equal(domOffsetToText(composed, typed, 3), 4);
  assert.deepEqual(textOffsetToDom(composed, 3), { node: typed, offset: 2 });
});

test("a U+200B the user typed is text, not a filler", () => {
  const typed = text("a\u200Bb");
  const root = el("DIV", {}, typed, chip("/x"), br());
  assert.equal(textOf(root), "a\u200Bb/x");
  assert.equal(domOffsetToText(root, typed, 2), 2);
  assert.deepEqual(textOffsetToDom(root, 1), { node: typed, offset: 1 });
  assert.deepEqual(textOffsetToDom(root, 2), { node: typed, offset: 2 });
  // Only the filler's own leading U+200B is skipped; one typed after it stays.
  const filler = text("\u200B\u200Bz");
  markFiller(filler);
  const after = el("DIV", {}, chip("/x"), filler, br());
  assert.equal(textOf(after), "/x\u200Bz");
  assert.deepEqual(textOffsetToDom(after, 3), { node: filler, offset: 2 });
});

test("Backspace and Delete next to a chip remove the whole chip", () => {
  const value = "a /x b";
  assert.deepEqual(deleteBackward(value, skillParts(value), 4, 4), { value: "a  b", caret: 2, chip: true });
  assert.deepEqual(deleteBackward(value, skillParts(value), 5, 5), { value: "a /xb", caret: 4, chip: false });
  assert.deepEqual(deleteForward(value, skillParts(value), 2, 2), { value: "a  b", caret: 2, chip: true });
  assert.deepEqual(deleteForward(value, skillParts(value), 1, 1), { value: "a/x b", caret: 1, chip: false });
  assert.deepEqual(deleteBackward(value, skillParts(value), 0, 0), null, "nothing before the start");
  assert.deepEqual(deleteForward(value, skillParts(value), 6, 6), null, "nothing after the end");
  // A selection that cuts into a chip takes all of it.
  assert.deepEqual(deleteBackward(value, skillParts(value), 1, 3), { value: "a b", caret: 1, chip: true });
  // A surrogate pair goes as one character.
  assert.deepEqual(deleteBackward("a😀", [{ kind: "text", text: "a😀" }], 3, 3), { value: "a", caret: 1, chip: false });
});

test("replacing a range never leaves half a chip", () => {
  const value = "a /x b";
  assert.deepEqual(replaceRange(value, skillParts(value), 3, 3, "y"), { value: "a y b", caret: 3, chip: true });
  assert.deepEqual(replaceRange(value, skillParts(value), 6, 6, "!"), { value: "a /x b!", caret: 7, chip: false });
  assert.deepEqual(replaceRange("", [], 0, 0, "日本"), { value: "日本", caret: 2, chip: false });
});

test("undo coalesces typing within 500 ms and keeps one entry per chip edit", () => {
  let now = 0;
  const history = createEditHistory(() => now);
  history.record({ value: "", caret: 0 }, "type");
  now = 100;
  history.record({ value: "h", caret: 1 }, "type");
  now = 300;
  history.record({ value: "hi", caret: 2 }, "type");
  now = 1000;
  history.record({ value: "hi ", caret: 3 }, "type");
  history.record({ value: "hi x", caret: 4 }, "chip");
  history.record({ value: "hi /x ", caret: 6 }, "chip");
  assert.deepEqual(history.undo({ value: "hi /x y", caret: 7 }), { value: "hi /x ", caret: 6 });
  assert.deepEqual(history.undo({ value: "hi /x ", caret: 6 }), { value: "hi x", caret: 4 });
  assert.deepEqual(history.undo({ value: "hi x", caret: 4 }), { value: "hi ", caret: 3 });
  assert.deepEqual(history.undo({ value: "hi ", caret: 3 }), { value: "", caret: 0 }, "the first burst is one step");
  assert.equal(history.undo({ value: "", caret: 0 }), null);
  assert.deepEqual(history.redo({ value: "", caret: 0 }), { value: "hi ", caret: 3 });
  assert.deepEqual(history.redo({ value: "hi ", caret: 3 }), { value: "hi x", caret: 4 });
  // A new edit drops what could be redone.
  history.record({ value: "hi x", caret: 4 }, "paste");
  assert.equal(history.redo({ value: "hi xz", caret: 5 }), null);
  history.clear();
  assert.equal(history.undo({ value: "", caret: 0 }), null);
});

test("Left and Right step over a chip as one character", () => {
  const value = "a /x b";
  const parts = skillParts(value);
  assert.equal(caretStep(value, parts, 4, -1), 2, "from after the chip to before it");
  assert.equal(caretStep(value, parts, 2, 1), 4);
  assert.equal(caretStep(value, parts, 5, -1), 4);
  assert.equal(caretStep(value, parts, 0, -1), 0);
  assert.equal(caretStep(value, parts, 6, 1), 6);
  assert.equal(caretStep("😀", [{ kind: "text", text: "😀" }], 2, -1), 0);
});

test("the dictation tail is laid out as pieces of its own, and its span counts as plain text", () => {
  const parts: PromptPart[] = [{ kind: "text", text: "check this and that" }];
  assert.deepEqual(editorLayout("check this and that", parts, { start: 11, end: 19 }), [
    { kind: "text", text: "check this " },
    { kind: "text", text: "and that", provisional: true },
    { kind: "break" },
  ]);
  assert.deepEqual(editorLayout("check this and that", parts, null), [{ kind: "text", text: "check this and that" }, { kind: "break" }]);

  // What the editor renders for that layout: the tail in an inline span. The draft's offsets must not move.
  const before = text("check this ");
  const inner = text("and that");
  const tail = el("SPAN", { "data-provisional": "" }, inner);
  const root = el("DIV", {}, before, tail, br());
  assert.equal(textOf(root), "check this and that", "the span adds no character");
  assert.equal(domOffsetToText(root, inner, 4), 15, "a caret inside the tail is an ordinary text offset");
  assert.deepEqual(textOffsetToDom(root, 15), { node: inner, offset: 4 });
  assert.deepEqual(textOffsetToDom(root, 19), { node: inner, offset: 8 }, "the end of the take is the end of the draft");
  assert.deepEqual(
    replaceRange("check this and that", parts, 11, 19, ""),
    { value: "check this ", caret: 11, chip: false },
    "discarding the tail is a plain range edit",
  );
});

test("the tail never cuts a chip, and a take beside one keeps the chip whole", () => {
  const parts: PromptPart[] = [
    { kind: "text", text: "run " },
    { kind: "skill", text: "/undo" },
    { kind: "text", text: " then this" },
  ];
  assert.deepEqual(editorLayout("run /undo then this", parts, { start: 2, end: 15 }), [
    { kind: "text", text: "ru" },
    { kind: "text", text: "n ", provisional: true },
    { kind: "chip", part: parts[1] },
    { kind: "text", text: " then ", provisional: true },
    { kind: "text", text: "this" },
    { kind: "break" },
  ]);
});
