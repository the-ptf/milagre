import test from "node:test";
import assert from "node:assert/strict";
import { draftSelection, editShownPrompt, shownPrompt, shownSelection } from "./prompt-mentions.mjs";
import { promptParts } from "./prompt-parts.mjs";

const titles: Record<number, string> = { 42: "Fix login", 7: "Ship\nit" };
const shown = (draft: string) => shownPrompt(promptParts(draft, { skills: [], files: () => false, chats: (id) => id in titles }), (id) => titles[id]);

test("a chat mention shows its title, not its id", () => {
  assert.equal(shown("ask @chat:42 about it").text, "ask @Fix login about it");
  assert.equal(shown("@chat:7.").text, "@Ship it.");
  assert.equal(shown("@chat:99 stays").text, "@chat:99 stays");
});

test("selections map between the draft and the shown text", () => {
  const { spans } = shown("ask @chat:42 now");
  assert.deepEqual(shownSelection(spans, { start: 13, end: 16 }), { start: 15, end: 18 });
  assert.deepEqual(draftSelection(spans, { start: 15, end: 18 }), { start: 13, end: 16 });
  assert.deepEqual(draftSelection(spans, { start: 8, end: 8 }), { start: 12, end: 12 });
  assert.deepEqual(draftSelection(spans, { start: 8, end: 15 }), { start: 4, end: 13 });
});

test("typing around a chat mention keeps the mention in the draft", () => {
  const draft = "ask @chat:42 now";
  const view = shown(draft);
  assert.deepEqual(editShownPrompt(draft, view, "ask @Fix login right now", { start: 15, end: 15 }), {
    value: "ask @chat:42 right now",
    caret: null,
  });
  assert.deepEqual(editShownPrompt(draft, view, "please ask @Fix login now", { start: 0, end: 0 }), {
    value: "please ask @chat:42 now",
    caret: null,
  });
});

test("deleting into a chat mention removes all of it", () => {
  const draft = "ask @chat:42 now";
  const view = shown(draft);
  assert.deepEqual(editShownPrompt(draft, view, "ask @Fix logi now", { start: 14, end: 14 }), { value: "ask  now", caret: 4 });
});

test("typing inside a chat mention lands after it", () => {
  const draft = "ask @chat:42 now";
  const view = shown(draft);
  assert.deepEqual(editShownPrompt(draft, view, "ask @Fixx login now", { start: 8, end: 8 }), { value: "ask @chat:42 x now", caret: 14 });
});

test("text typed against a chat mention gets a space so the mention survives", () => {
  const draft = "@chat:42";
  const view = shown(draft);
  assert.deepEqual(editShownPrompt(draft, view, "@Fix logins", { start: 10, end: 10 }), { value: "@chat:42 s", caret: 10 });
  assert.deepEqual(editShownPrompt(draft, view, "@Fix login.", { start: 10, end: 10 }), { value: "@chat:42.", caret: null });
  assert.deepEqual(editShownPrompt(draft, view, "x@Fix login", { start: 0, end: 0 }), { value: "x @chat:42", caret: 2 });
});

test("a draft without chat mentions passes edits through", () => {
  assert.deepEqual(editShownPrompt("hi", shown("hi"), "hi!", { start: 2, end: 2 }), { value: "hi!", caret: null });
});
