import assert from "node:assert/strict";
import test from "node:test";
import { createDraftStore, draftKey } from "./draft-store.ts";

test("each key keeps its own draft", () => {
  const store = createDraftStore(draftKey("/p", 1));
  store.set("one");
  store.select(draftKey("/p", 2));
  assert.equal(store.get(), "");
  store.set("two");
  store.select(draftKey("/p", null));
  store.set("new");
  store.select(draftKey("/p", 1));
  assert.equal(store.get(), "one");
  store.select(draftKey("/p", null));
  assert.equal(store.get(), "new");
  store.select(draftKey("/other", null));
  assert.equal(store.get(), "");
});

test("selecting another draft notifies subscribers", () => {
  const store = createDraftStore("a");
  let calls = 0;
  store.subscribe(() => calls++);
  store.select("a");
  store.set("");
  assert.equal(calls, 0);
  store.select("b");
  store.set("text");
  assert.equal(calls, 2);
});

test("the same path on this Mac and on a paired computer keeps two drafts", () => {
  const remote = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7|/p";
  const store = createDraftStore(draftKey("/p", 1));
  store.set("here");
  store.select(draftKey(remote, 1));
  assert.equal(store.get(), "");
  store.set("there");
  store.select(draftKey("/p", 1));
  assert.equal(store.get(), "here");
  store.select(draftKey(remote, 1));
  assert.equal(store.get(), "there");
});

test("take hands over another key's draft and clears it there", () => {
  const store = createDraftStore(draftKey("/home", null));
  store.select(draftKey("/p", null));
  store.set("w");
  store.select(draftKey("/home", null));
  let calls = 0;
  store.subscribe(() => calls++);
  assert.equal(store.take(draftKey("/p", null)), "w");
  // Not the selected draft: nobody re-renders for it.
  assert.equal(calls, 0);
  assert.equal(store.take(draftKey("/p", null)), "");
  store.select(draftKey("/p", null));
  assert.equal(store.get(), "");
  store.set("x");
  assert.equal(store.take(draftKey("/p", null)), "x");
  assert.equal(store.get(), "");
  assert.equal(calls, 3);
});

test("quotes stay beside the typed text per Chat and go out as blockquotes before it", () => {
  const store = createDraftStore(draftKey("/p", 1));
  const quotes = [
    { id: "a", text: "first", source: "Claude reply" },
    { id: "b", text: "two\nlines", source: "Your message" },
  ];
  store.setQuotes(quotes);
  store.setText("Why?");
  assert.equal(store.text(), "Why?");
  assert.equal(store.quotes(), quotes);
  assert.equal(store.get(), "> first\n\n> two\n> lines\n\nWhy?");
  store.select(draftKey("/p", 2));
  assert.deepEqual(store.quotes(), []);
  assert.equal(store.get(), "");
  store.select(draftKey("/p", 1));
  assert.equal(store.quotes(), quotes);
  // Typing never turns a `>` the user wrote into a chip.
  store.setQuotes([]);
  store.setText("> typed");
  assert.deepEqual(store.quotes(), []);
  assert.equal(store.text(), "> typed");
});

test("a whole message set back (a failed send, a Project switch) turns its quotes into chips with their sources", () => {
  const store = createDraftStore("a");
  store.setQuotes([{ id: "q", text: "kept", source: "Codex reply" }]);
  store.setText("question");
  const sent = store.get();
  store.set("");
  assert.deepEqual([store.text(), store.quotes()], ["", []]);
  store.set([sent, "typed meanwhile"].join("\n\n"));
  assert.equal(store.text(), "question\n\ntyped meanwhile");
  assert.deepEqual(
    store.quotes().map(({ text, source }) => ({ text, source })),
    [{ text: "kept", source: "Codex reply" }],
  );
  // Setting the same message again keeps the chips as they are.
  const chips = store.quotes();
  store.set(store.get());
  assert.equal(store.quotes(), chips);
  store.set("> unknown\n\nrest");
  assert.deepEqual(
    store.quotes().map(({ text, source }) => ({ text, source })),
    [{ text: "unknown", source: undefined }],
  );
});

test("take hands over the quotes with the text", () => {
  const store = createDraftStore(draftKey("/p", null));
  store.setQuotes([{ id: "q", text: "passage" }]);
  store.select(draftKey("/home", null));
  assert.equal(store.take(draftKey("/p", null)), "> passage");
  store.select(draftKey("/p", null));
  assert.deepEqual(store.quotes(), []);
});
