import assert from "node:assert/strict";
import test from "node:test";
import { headingLayer, newChatLook } from "./new-chat-look.ts";

test('heading reads "Just chat" when the Chats home is picked', () => {
  assert.deepEqual(newChatLook("chats"), { heading: "Just chat", tray: "chats", trayLabel: "Yapping around", placeholder: "Ask anything" });
});

test("a Project's new Chat keeps its heading, chips and placeholder", () => {
  assert.deepEqual(newChatLook(undefined), { heading: "Start building in", tray: "project" });
});

test("heading wrapper is raised only while its picker is open", () => {
  assert.equal(headingLayer(true), "z-30");
  assert.equal(headingLayer(false), "");
});

test("a heading that went away holds no layer even if its picker was last reported open", () => {
  assert.equal(headingLayer(true, false), "");
});
