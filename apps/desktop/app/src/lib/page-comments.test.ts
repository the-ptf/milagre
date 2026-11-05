import assert from "node:assert/strict";
import test from "node:test";
import {
  addPendingComment,
  pageComments,
  pagePins,
  setCommenting,
  openPageComment,
  editPageComment,
  removePendingComments,
  completePendingComments,
  setSentComments,
  setShowResolved,
} from "./page-comments.ts";

const element = {
  selector: "button.pay",
  tag: "button",
  label: 'button "Pay now"',
  box: { x: 0, y: 0, width: 80, height: 24 },
  viewport: { width: 400, height: 600 },
};
const URL = "http://localhost:5173/checkout";

test("comments retain numbered pins when sent", () => {
  addPendingComment("/p#1", { id: "aaaaaaaa", url: URL, title: "Checkout", element, text: "Bigger", shot: null });
  addPendingComment("/p#1", { id: "bbbbbbbb", url: `${URL}?step=2`, title: "Checkout", element, text: "Green", shot: null });
  setSentComments("/p#1", [
    { id: "cccccccc", url: URL, title: "Checkout", label: "h1", selector: "h1", text: "Sentence case", createdAt: 1 },
    { id: "dddddddd", url: URL, title: "Checkout", label: "p", selector: "p", text: "Shorter", createdAt: 2, resolved: { note: "Cut it", at: 3 } },
  ]);
  assert.deepEqual(
    pagePins(pageComments("/p#1"), URL).map((pin) => [pin.state, pin.n]),
    [
      ["open", 1],
      ["pending", 1],
      ["pending", 2],
    ],
  );
  setShowResolved("/p#1", true);
  assert.equal(pagePins(pageComments("/p#1"), URL).filter((pin) => pin.state === "resolved").length, 1);
  setShowResolved("/p#1", false);
  assert.equal(pagePins(pageComments("/p#1"), URL).length, 3);
});

test("closing comment mode keeps written drafts, drops empty pins and allows editing before sending", () => {
  setCommenting("/p#2", true);
  addPendingComment("/p#2", { id: "draft", url: URL, title: "Checkout", element, text: "", shot: null });
  openPageComment("/p#2", "draft");
  editPageComment("/p#2", "draft", "Half written");
  setCommenting("/p#2", false);
  assert.equal(pageComments("/p#2").open, null);
  assert.equal(pageComments("/p#2").pending[0].text, "Half written");
  openPageComment("/p#2", "draft");
  editPageComment("/p#2", "draft", "Finished");
  openPageComment("/p#2", null);
  assert.equal(pageComments("/p#2").pending[0].text, "Finished");
  addPendingComment("/p#2", { id: "empty", url: URL, title: "Checkout", element, text: "", shot: null });
  openPageComment("/p#2", "empty");
  openPageComment("/p#2", null);
  assert.equal(pageComments("/p#2").pending.length, 1);
  removePendingComments("/p#2", new Set(["draft"]));
  assert.deepEqual(pageComments("/p#2").pending, []);
});

test("successful sends retire their snapshot, preserve newer edits under a fresh id, and leave other drafts alone", () => {
  const chat = "/p#send-edit";
  const pin = (id: string, text: string) => ({ id, url: URL, title: "Checkout", element, text, shot: null });
  addPendingComment(chat, pin("unchanged", "Original"));
  addPendingComment(chat, pin("edited", "Before send"));
  addPendingComment(chat, pin("deleted", "Remove me"));
  const batch = pageComments(chat).pending;
  editPageComment(chat, "edited", "Typed during send");
  removePendingComments(chat, new Set(["deleted"]));
  addPendingComment(chat, pin("later", "Created during send"));
  completePendingComments(chat, batch);
  const pending = pageComments(chat).pending;
  assert.equal(pending.length, 2);
  assert.equal(pending[0].text, "Typed during send");
  assert.notEqual(pending[0].id, "edited", "a later send must not reuse the delivered comment's identity");
  assert.match(pending[0].id, /^[a-f0-9]{8}$/);
  assert.equal(pending[1].id, "later");
  assert.equal(batch[1].text, "Before send", "the sent snapshot remains unchanged");
  completePendingComments(chat, [pending[0]]);
  assert.deepEqual(
    pageComments(chat).pending.map((pin) => pin.id),
    ["later"],
  );
});
