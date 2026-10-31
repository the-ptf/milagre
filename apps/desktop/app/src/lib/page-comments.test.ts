import assert from "node:assert/strict";
import test from "node:test";
import { addPendingComment, pageComments, pagePins, setCommenting, setPageDraft, setSentComments } from "./page-comments.ts";

const element = {
  selector: "button.pay",
  tag: "button",
  label: 'button "Pay now"',
  box: { x: 0, y: 0, width: 80, height: 24 },
  viewport: { width: 400, height: 600 },
};
const URL = "http://localhost:5173/checkout";

test("only the comments still to send are numbered on the page, 1 to n like the Send button", () => {
  addPendingComment("/p#1", { id: "aaaaaaaa", url: URL, title: "Checkout", element, text: "Bigger", shot: null });
  addPendingComment("/p#1", { id: "bbbbbbbb", url: `${URL}?step=2`, title: "Checkout", element, text: "Green", shot: null });
  setSentComments("/p#1", [
    { id: "cccccccc", url: URL, title: "Checkout", label: "h1", selector: "h1", text: "Sentence case", createdAt: 1 },
    { id: "dddddddd", url: URL, title: "Checkout", label: "p", selector: "p", text: "Shorter", createdAt: 2, resolved: { note: "Cut it", at: 3 } },
  ]);
  assert.deepEqual(
    pagePins(pageComments("/p#1"), URL).map((pin) => [pin.state, pin.n]),
    [
      ["open", 0],
      ["resolved", 0],
      ["pending", 1],
      ["pending", 2],
    ],
  );
});

test("a comment being written waits on its tab through tab and Chat switches, and goes when comment mode ends", () => {
  setCommenting("/p#2", true);
  setPageDraft("/p#2", "tab-a", { url: URL, element, shot: null, text: "Half writ" });
  setPageDraft("/p#2", "tab-b", { url: URL, element, shot: null, text: "Other" });
  assert.equal(pageComments("/p#2").drafts["tab-a"]?.text, "Half writ");
  setPageDraft("/p#2", "tab-b", null);
  assert.deepEqual(Object.keys(pageComments("/p#2").drafts), ["tab-a"]);
  setCommenting("/p#2", false);
  assert.deepEqual(pageComments("/p#2").drafts, {});
});
