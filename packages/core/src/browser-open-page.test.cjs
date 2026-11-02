const test = require("node:test");
const assert = require("node:assert/strict");
const { openBrowserPage } = require("./browser-open-page.cjs");

test("opening a phone link asks its Chat's desktop panel and returns only its panel page", async () => {
  const calls = [];
  const page = { id: "panel-page", source: "panel", url: "http://localhost:5173/" };
  const browsers = {
    list: async (request) => {
      calls.push(request);
      return { targets: [{ ...page, id: "agent-page", source: "agent" }, page] };
    },
  };
  const result = await openBrowserPage(browsers, (...args) => calls.push(args), { chatId: "/project#1", url: "http://localhost:5173" });
  assert.equal(result, page);
  assert.deepEqual(calls, [["/project#1", "http://localhost:5173/"], { chatId: "/project#1" }]);
});

test("unavailable desktop reports a retryable error instead of opening another browser", async () => {
  await assert.rejects(
    openBrowserPage({ list: async () => ({ targets: [] }) }, () => {}, { chatId: "chat", url: "https://example.com" }, 0),
    /Open Milagre on your computer and retry/,
  );
});

test("page requests reject non-web URLs and missing Chats before asking the desktop", async () => {
  const unexpected = () => assert.fail("must not ask the desktop");
  for (const url of ["file:///tmp/private", "javascript:alert(1)", "mailto:me@example.com", "https://"]) {
    await assert.rejects(openBrowserPage({}, unexpected, { chatId: "chat", url }));
  }
  await assert.rejects(openBrowserPage({}, unexpected, { chatId: "", url: "https://example.com" }));
});
