const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createChatPageComments, pageCommentToolDefinitions } = require("./chat-page-comments.cjs");
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
