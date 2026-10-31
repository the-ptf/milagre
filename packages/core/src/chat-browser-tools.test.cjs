const test = require("node:test");
const assert = require("node:assert/strict");
const { browserPageToolDefinitions } = require("./chat-browser-tools.cjs");
const { runTool } = require("./linked-tools.cjs");

const TARGET = { id: `panel-abc123abc123:${"A".repeat(32)}`, title: "Checkout", url: "http://localhost:5173/", source: "panel" };

function fakeSession() {
  const sent = [];
  const listeners = new Set();
  const replies = {
    "Accessibility.getFullAXTree": () => ({
      nodes: [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Checkout" }, childIds: ["2", "3", "4"], backendDOMNodeId: 1 },
        { nodeId: "2", parentId: "1", role: { value: "heading" }, name: { value: "Checkout" }, backendDOMNodeId: 10 },
        { nodeId: "3", parentId: "1", role: { value: "generic" }, name: { value: "" }, childIds: ["5"] },
        { nodeId: "4", parentId: "1", role: { value: "button" }, name: { value: 'Pay "now"' }, backendDOMNodeId: 12 },
        { nodeId: "5", parentId: "3", role: { value: "textbox" }, name: { value: "Card number" }, value: { value: "4242" }, backendDOMNodeId: 11 },
      ],
    }),
    "Runtime.evaluate": (params) =>
      params.expression.startsWith("JSON.stringify([document.title")
        ? { result: { value: JSON.stringify(["Checkout", "http://localhost:5173/"]) } }
        : params.expression.includes("innerText.includes")
          ? { result: { value: true } }
          : { result: { value: params.expression === "1 + 1" ? 2 : undefined } },
    "DOM.getBoxModel": () => ({ model: { content: [10, 20, 110, 20, 110, 60, 10, 60], border: [8, 18, 112, 18, 112, 62, 8, 62] } }),
    "DOM.resolveNode": () => ({ object: { objectId: "obj-1" } }),
    "Runtime.callFunctionOn": () => ({ result: { value: "Visa" } }),
    "Page.captureScreenshot": () => ({ data: "iVBORw0KGgo=" }),
    "Page.navigate": () => ({}),
  };
  return {
    sent,
    closed: false,
    emit: (method, params) => listeners.forEach((listener) => listener(method, params)),
    on: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    send: async (method, params = {}) => {
      sent.push([method, params]);
      return replies[method]?.(params) ?? {};
    },
    close() {},
  };
}

function fixture() {
  const session = fakeSession();
  const state = {};
  const opened = [];
  const targets = [];
  const browsers = {
    devtools: async ({ chatId, page }) => {
      assert.equal(chatId, "/p#1", "tools act for their own Chat only");
      if (page && page !== TARGET.id) throw new Error("That page is not in this Chat.");
      return { target: TARGET, session, state };
    },
    list: async () => ({ targets }),
  };
  const tools = Object.fromEntries(
    browserPageToolDefinitions("/p#1", browsers, { openInPanel: (chatId, url) => (opened.push([chatId, url]), targets.push({ ...TARGET, url })) }).map(
      (tool) => [tool.name, tool],
    ),
  );
  return { session, state, tools, opened, run: (name, input = {}) => runTool(tools[name], input) };
}

test("a snapshot names the elements a person sees, with refs the other tools take", async () => {
  const f = fixture();
  const { text, isError } = await f.run("browser_snapshot");
  assert.equal(isError, false);
  assert.equal(
    text,
    [
      "Page: Checkout (http://localhost:5173/)",
      '- heading "Checkout" [ref=@e1]',
      '- textbox "Card number" value="4242" [ref=@e2]',
      "- button \"Pay 'now'\" [ref=@e3]",
    ].join("\n"),
  );
  // The first use turns on what the tools listen to.
  assert.ok(["Page.enable", "Runtime.enable", "DOM.enable"].every((method) => f.session.sent.some(([sent]) => sent === method)));
});

test("click presses the middle of the element; an unknown ref asks for a new snapshot", async () => {
  const f = fixture();
  await f.run("browser_snapshot");
  await f.run("browser_click", { ref: "@e3" });
  const mouse = f.session.sent.filter(([method]) => method === "Input.dispatchMouseEvent").map(([, params]) => [params.type, params.x, params.y]);
  assert.deepEqual(mouse, [
    ["mouseMoved", 60, 40],
    ["mousePressed", 60, 40],
    ["mouseReleased", 60, 40],
  ]);
  const stale = await f.run("browser_click", { ref: "@e99" });
  assert.equal(stale.isError, true);
  assert.match(stale.text, /take a new browser_snapshot/);
  // A navigation makes every ref stale.
  f.session.emit("Page.frameNavigated", { frame: { id: "main" } });
  assert.match((await f.run("browser_click", { ref: "@e3" })).text, /take a new browser_snapshot/);
});

test("fill clears through the native setter, then types; select picks an option by text", async () => {
  const f = fixture();
  await f.run("browser_snapshot");
  await f.run("browser_fill", { ref: "e2", text: "4000 0566" });
  const call = f.session.sent.find(([method]) => method === "Runtime.callFunctionOn")[1];
  assert.match(call.functionDeclaration, /getOwnPropertyDescriptor\(Object.getPrototypeOf\(this\), "value"\)/);
  assert.deepEqual(f.session.sent.at(-1), ["Input.insertText", { text: "4000 0566" }]);
  const selected = await f.run("browser_select", { ref: "@e2", option: "Visa" });
  assert.match(selected.text, /Selected Visa/);
});

test("a screenshot leaves the comment pins out and comes back as an image", async () => {
  const f = fixture();
  const result = await runTool(f.tools.browser_screenshot, {});
  const methods = f.session.sent.map(([method, params]) => (method === "Runtime.evaluate" ? params.expression : method));
  const capture = methods.indexOf("Page.captureScreenshot");
  assert.equal(methods[capture - 1], "window.__milagrePins?.hide(true)");
  assert.equal(methods[capture + 1], "window.__milagrePins?.hide(false)");
  assert.deepEqual(result.images, [{ base64: "iVBORw0KGgo=", mime: "image/png" }]);
});

test("console keeps the page's messages and errors once the tools have touched it", async () => {
  const f = fixture();
  await f.run("browser_console");
  f.session.emit("Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "Payment failed" }] });
  f.session.emit("Runtime.exceptionThrown", { exceptionDetails: { exception: { description: "TypeError: x is undefined" } } });
  const { text } = await f.run("browser_console");
  assert.match(text, /\[error\] Payment failed\n\[exception\] TypeError: x is undefined/);
});

test("open asks the Chat's Browser panel for the page and returns it once it is there; only web pages", async () => {
  const f = fixture();
  const opened = JSON.parse((await f.run("browser_open", { url: "http://localhost:5173/checkout" })).text);
  assert.deepEqual(f.opened, [["/p#1", "http://localhost:5173/checkout"]]);
  assert.equal(opened.page, TARGET.id);
  assert.equal((await f.run("browser_open", { url: "file:///etc/passwd" })).isError, true);
  assert.equal((await f.run("browser_navigate", { url: "javascript:alert(1)" })).isError, true);
});

test("evaluate returns JSON, wait sees text, press sends named keys and refuses unknown ones", async () => {
  const f = fixture();
  assert.equal((await f.run("browser_evaluate", { expression: "1 + 1" })).text, "2");
  assert.equal((await f.run("browser_wait", { text: "Thanks for your order" })).isError, false);
  await f.run("browser_press", { key: "Enter" });
  const keys = f.session.sent
    .filter(([method]) => method === "Input.dispatchKeyEvent")
    .map(([, params]) => [params.type, params.key, params.windowsVirtualKeyCode]);
  assert.deepEqual(keys, [
    ["keyDown", "Enter", 13],
    ["keyUp", "Enter", 13],
  ]);
  assert.equal((await f.run("browser_press", { key: "Hyper" })).isError, true);
  // ⌘ and Ctrl shortcuts would reach Milagre's window as the user's own keys.
  for (const modifier of ["Meta", "Control"]) assert.equal((await f.run("browser_press", { key: "w", modifiers: [modifier] })).isError, true, modifier);
  assert.equal(f.session.sent.filter(([method]) => method === "Input.dispatchKeyEvent").length, 2);
  // Another Chat's page is out of reach.
  assert.equal((await f.run("browser_snapshot", { page: "other:page" })).isError, true);
});
