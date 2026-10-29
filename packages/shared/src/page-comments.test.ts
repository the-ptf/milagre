import assert from "node:assert/strict";
import test from "node:test";
import { pageCommentsMessage, pageKey, parsePageComments, type PageComment } from "./page-comments.ts";

const element = (label: string, extra: Partial<PageComment["element"]> = {}): PageComment["element"] => ({
  selector: "main > form > button.pay",
  tag: "button",
  label,
  box: { x: 24.4, y: 414, width: 120, height: 40 },
  viewport: { width: 570, height: 670 },
  ...extra,
});

test("the message names each comment, its element and its page, and reads back as a card", () => {
  const body = pageCommentsMessage([
    {
      id: "a1b2c3d4",
      url: "http://localhost:5173/checkout",
      title: 'Checkout "Acme"',
      text: "Make this full width on mobile,\nand use the brand green.",
      element: element('<PayButton> button "Pay now"', {
        source: "src/Checkout.tsx:88",
        styles: { display: "inline-flex", width: "auto" },
        html: '<button class="pay">\n  Pay now\n</button>',
      }),
    },
    { id: "e5f6a7b8", url: "http://localhost:5173/checkout", title: "Checkout", text: "Sentence case.", element: element("h1") },
    { id: "0a0b0c0d", url: "http://localhost:5173/", title: "Home", text: "Hero too tall", element: element("section.hero") },
  ]);
  assert.match(body, /^2 comments on the page "Checkout 'Acme'" \(http:\/\/localhost:5173\/checkout\):/);
  assert.match(
    body,
    /1\. \(comment a1b2c3d4\) <PayButton> button "Pay now" \(src\/Checkout\.tsx:88\)\n {3}Comment: Make this full width on mobile,\n {5}and use the brand green\.\n {3}Selector: main > form > button\.pay\n {3}Box: 120×40 at 24,414 in a 570×670 viewport\n {3}Styles: display: inline-flex; width: auto\n {3}HTML: <button class="pay"> Pay now <\/button>/,
  );
  assert.match(body, /A comment on the page "Home" \(http:\/\/localhost:5173\/\):\n\n3\. \(comment 0a0b0c0d\) section\.hero/);
  assert.match(body, /attached, in order\. Once you have addressed a comment, resolve it with browser_resolve_comment and its comment id\.$/);
  assert.deepEqual(parsePageComments(body), [
    {
      id: "a1b2c3d4",
      number: 1,
      url: "http://localhost:5173/checkout",
      title: "Checkout 'Acme'",
      label: '<PayButton> button "Pay now"',
      text: "Make this full width on mobile,\nand use the brand green.",
    },
    { id: "e5f6a7b8", number: 2, url: "http://localhost:5173/checkout", title: "Checkout 'Acme'", label: "h1", text: "Sentence case." },
    { id: "0a0b0c0d", number: 3, url: "http://localhost:5173/", title: "Home", label: "section.hero", text: "Hero too tall" },
  ]);
});

test("a message the user typed stays text, even one that mentions the tool", () => {
  assert.equal(parsePageComments("Please resolve it with browser_resolve_comment"), null);
  assert.equal(parsePageComments("hello\n\nOnce you have addressed a comment, resolve it with browser_resolve_comment and its comment id."), null);
});

test("pins match a page whatever its query and hash", () => {
  assert.equal(pageKey("http://localhost:5173/checkout?step=2#pay"), "http://localhost:5173/checkout");
  assert.equal(pageKey("nope"), "nope");
});
