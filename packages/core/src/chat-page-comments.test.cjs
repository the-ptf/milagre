const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { commentAtPoint, createChatPageComments, pageCommentToolDefinitions } = require("./chat-page-comments.cjs");
const { runTool } = require("./linked-tools.cjs");

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "page-comments-"));
  const store = createChatPageComments({
    directory,
    validateChat: async (chatId) => {
      if (!chatId.startsWith("/p#")) throw Error("Open an existing Chat before commenting on a page.");
    },
  });
  return { directory, store };
}

const comment = (extra = {}) => ({
  url: "http://localhost:5173/checkout",
  title: "Checkout",
  text: "  Make this full width on mobile.  ",
  element: { selector: "main > button.pay", label: '<PayButton> button "Pay now"', source: "src/Checkout.tsx:88", html: "<button>secret</button>" },
  ...extra,
});

test("a sent comment is kept with what the agent needs, under the id the message named, once", async () => {
  const { store } = await fixture();
  const [added] = await store.add({ chatId: "/p#1", comments: [comment({ id: "a1b2c3d4" })] });
  assert.equal(added.id, "a1b2c3d4");
  assert.equal(added.text, "Make this full width on mobile.");
  assert.equal(added.selector, "main > button.pay");
  assert.equal(added.source, "src/Checkout.tsx:88");
  assert.equal(added.html, undefined, "the HTML travels in the message, not the store");
  // A retried send names the same id again.
  await store.add({ chatId: "/p#1", comments: [comment({ id: "a1b2c3d4" })] });
  assert.equal((await store.list({ chatId: "/p#1" })).length, 1);
  assert.deepEqual(await store.list({ chatId: "/p#2" }), []);
});

test("comments must name a web page, an element and some text, and a Chat that exists", async () => {
  const { store } = await fixture();
  await assert.rejects(store.add({ chatId: "/p#1", comments: [comment({ url: "file:///etc/passwd" })] }), /web page/);
  await assert.rejects(store.add({ chatId: "/p#1", comments: [comment({ text: "  " })] }), /needs its text/);
  await assert.rejects(store.add({ chatId: "/p#1", comments: [comment({ element: {} })] }), /names its element/);
  await assert.rejects(store.add({ chatId: "/p#1", comments: [] }), /between 1 and 50/);
  await assert.rejects(store.add({ chatId: "elsewhere", comments: [comment()] }), /existing Chat/);
});

test("the agent lists open comments of its own Chat and resolves one with a note", async () => {
  const { store } = await fixture();
  await store.add({ chatId: "/p#1", comments: [comment({ id: "a1b2c3d4" }), comment({ id: "e5f6a7b8", text: "Tax on its own line" })] });
  await store.add({ chatId: "/p#2", comments: [comment({ id: "0a0b0c0d" })] });
  const tools = pageCommentToolDefinitions("/p#1", store);
  const list = tools.find((tool) => tool.name === "browser_comments");
  const resolve = tools.find((tool) => tool.name === "browser_resolve_comment");
  assert.deepEqual(
    JSON.parse((await runTool(list, {})).text).map((item) => item.id),
    ["a1b2c3d4", "e5f6a7b8"],
  );
  const result = JSON.parse((await runTool(resolve, { id: "e5f6a7b8", note: "Added a Tax row." })).text);
  assert.equal(result.resolved.note, "Added a Tax row.");
  assert.deepEqual(
    JSON.parse((await runTool(list, {})).text).map((item) => item.id),
    ["a1b2c3d4"],
  );
  assert.equal(JSON.parse((await runTool(list, { all: true })).text).length, 2);
  // Another Chat's comment is out of reach.
  const denied = await runTool(resolve, { id: "0a0b0c0d", note: "x" });
  assert.equal(denied.isError, true);
  assert.match(denied.text, /No page comment 0a0b0c0d/);
});

test("a Chat that is gone takes its comments with it", async () => {
  const { store } = await fixture();
  await store.add({ chatId: "/p#1", comments: [comment()] });
  await store.removeChat("/p#1");
  assert.deepEqual(await store.list({ chatId: "/p#1" }), []);
});

test("a tap on the phone names the element at that point, with its screenshot taken without the pins", async () => {
  const sent = [];
  const element = {
    selector: "button.pay",
    tag: "button",
    label: 'button "Pay now"',
    box: { x: 5, y: 100, width: 120, height: 40 },
    viewport: { width: 390, height: 700 },
  };
  const page = {
    send: async (method, params) => {
      sent.push([method, method === "Runtime.evaluate" ? params.expression.slice(0, 40) : params]);
      if (method === "Page.captureScreenshot") return { data: "iVBOR" };
      if (method === "Runtime.evaluate" && params.expression.includes("elementFromPoint")) return { result: { value: element } };
      return {};
    },
  };
  const result = await commentAtPoint(page, 0.2, 0.15);
  assert.deepEqual(result, { element: { ...element, styles: {}, point: { x: 0.5, y: 0.5 } }, shot: "iVBOR" });
  assert.match(sent[0][1], /^\(\(\) => \{/);
  assert.deepEqual(sent[1], ["Runtime.evaluate", "window.__milagrePins?.hide(true)"]);
  // The crop keeps a margin and never starts off the page.
  assert.deepEqual(sent[2][1].clip, { x: 0, y: 88, width: 144, height: 64, scale: 1 });
  assert.deepEqual(sent[3], ["Runtime.evaluate", "window.__milagrePins?.hide(false)"]);
  const empty = { send: async () => ({ result: { value: null } }) };
  await assert.rejects(commentAtPoint(empty, 0.5, 0.5), /Could not place a comment pin/);
});

test("what the page says about the tapped element is kept to its shape: a page's scripts can answer anything", async () => {
  const hostile = {
    selector: "button\n.pay",
    tag: "<img onerror=x>",
    label: { toString: () => "boom" },
    html: ["not", "text"],
    styles: { color: "red", "bad name": "x", width: 5 },
    box: { x: "5", y: Number.NaN, width: 1e3, height: -4 },
    viewport: null,
    components: ["Pay", 7],
    point: { x: 3, y: 0.25 },
  };
  const page = { send: async (method) => (method === "Runtime.evaluate" ? { result: { value: hostile } } : {}) };
  const { element } = await commentAtPoint(page, 0.5, 0.5);
  assert.deepEqual(element, {
    selector: "button .pay",
    tag: "imgonerrorx",
    label: "imgonerrorx",
    styles: { color: "red" },
    box: { x: 0, y: 0, width: 1000, height: 0 },
    viewport: { width: 1, height: 1 },
    components: ["Pay"],
    point: { x: 0.5, y: 0.25 },
  });
  // The message built from it reads back as a card.
  const { pageCommentsMessage, parsePageComments } = await import("@milagre/shared/page-comments");
  const body = pageCommentsMessage([{ id: "a1b2c3d4", url: "http://localhost:5173/", title: "Home", text: "Odd", element }]);
  assert.equal(parsePageComments(body)?.[0].label, "imgonerrorx");
});
