const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { browserPageToolDefinitions } = require("./chat-browser-tools.cjs");
const { runTool } = require("./linked-tools.cjs");

const TARGET = { id: `panel-${"a".repeat(24)}:${"A".repeat(32)}`, title: "Checkout", url: "http://localhost:5173/", source: "panel" };

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

function fixture({ roots = [], files, listError, listErrorOnCall } = {}) {
  const session = fakeSession();
  const state = {};
  const opened = [];
  const closed = [];
  const closedAll = [];
  const suspendedTabs = [];
  const targets = [];
  let listCalls = 0;
  const browsers = {
    devtools: async ({ chatId, page }) => {
      assert.equal(chatId, "/p#1", "tools act for their own Chat only");
      if (page && page !== TARGET.id) throw new Error("That page is not in this Chat.");
      return { target: TARGET, session, state, ...(files ? { files } : {}) };
    },
    list: async () => {
      listCalls++;
      if (listError || listCalls === listErrorOnCall) return { targets: [], error: listError ?? "Could not list browsers on this computer." };
      return { targets };
    },
  };
  const tools = Object.fromEntries(
    browserPageToolDefinitions(
      "/p#1",
      browsers,
      {
        openInPanel: (chatId, url) => (opened.push([chatId, url]), targets.push({ ...TARGET, url })),
        closePage: async (chatId, id) => {
          closed.push([chatId, id]);
          const index = targets.findIndex((target) => target.id === id);
          if (index >= 0) targets.splice(index, 1);
        },
        closeAll: async (chatId) => {
          closedAll.push(chatId);
          for (let index = targets.length - 1; index >= 0; index--) if (targets[index].source === "panel") targets.splice(index, 1);
          suspendedTabs.splice(0);
        },
      },
      { roots: async () => roots, chooserWaitMs: 100 },
    ).map((tool) => [tool.name, tool]),
  );
  return { session, state, tools, opened, closed, closedAll, suspendedTabs, targets, run: (name, input = {}) => runTool(tools[name], input) };
}

test("browser_close resolves the full target id and closes only pages owned by this Chat", async () => {
  const f = fixture();
  f.targets.push({ ...TARGET });
  const second = { ...TARGET, id: `panel-${"b".repeat(24)}:${"B".repeat(32)}` };
  f.targets.push(second, { ...TARGET, id: `panel-${"c".repeat(24)}:${"C".repeat(32)}`, source: "attached" });
  assert.match((await f.run("browser_close", { page: TARGET.id })).text, /"closed":true/);
  assert.deepEqual(f.closed, [["/p#1", TARGET.id]]);
  assert.equal(
    f.targets.some((target) => target.id === TARGET.id),
    false,
  );
  assert.deepEqual(JSON.parse((await f.run("browser_close", { page: TARGET.id })).text), { closed: false, page: TARGET.id });
});

test("browser_close all clears suspended renderer tabs and leaves non-panel targets alone", async () => {
  const f = fixture();
  f.targets.push({ ...TARGET }, { ...TARGET, id: `panel-${"b".repeat(24)}:${"B".repeat(32)}` });
  f.targets.push({ ...TARGET, id: `panel-${"c".repeat(24)}:${"C".repeat(32)}`, source: "attached" });
  f.suspendedTabs.push("old-renderer-tab");
  assert.deepEqual(JSON.parse((await f.run("browser_close", { all: true })).text), { closed: true });
  assert.deepEqual(f.closedAll, ["/p#1"]);
  assert.deepEqual(f.suspendedTabs, []);
  assert.deepEqual(
    f.targets.map((target) => target.source),
    ["attached"],
  );
});

test("browser_close propagates listing errors before and after dispatch", async () => {
  const initial = fixture({ listError: "discovery failed" });
  initial.targets.push({ ...TARGET });
  const first = await initial.run("browser_close", { page: TARGET.id });
  assert.equal(first.isError, true);
  assert.match(first.text, /discovery failed/);
  assert.deepEqual(initial.closed, []);

  const single = fixture({ listErrorOnCall: 2 });
  single.targets.push({ ...TARGET });
  const afterDispatch = await single.run("browser_close", { page: TARGET.id });
  assert.equal(afterDispatch.isError, true);
  assert.match(afterDispatch.text, /Could not list browsers/);
  assert.deepEqual(single.closed, [["/p#1", TARGET.id]]);

  const all = fixture({ listErrorOnCall: 2 });
  all.targets.push({ ...TARGET });
  const afterCloseAll = await all.run("browser_close", { all: true });
  assert.equal(afterCloseAll.isError, true);
  assert.deepEqual(all.closedAll, ["/p#1"]);
});

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

function uploadFolder(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "browser-upload-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, "clip.mp4"), Buffer.alloc(3 * 1024 * 1024));
  fs.writeFileSync(path.join(worktree, "cover.png"), "png");
  fs.writeFileSync(path.join(root, "secret.txt"), "key");
  fs.symlinkSync(path.join(root, "secret.txt"), path.join(worktree, "link.txt"));
  return { root, worktree };
}

test("upload sets files straight on a file input, only from the Chat's folders", async (t) => {
  const { root, worktree } = uploadFolder(t);
  const f = fixture({ roots: [worktree, path.join(root, "missing-downloads")] });
  f.session.send = (
    (send) => async (method, params) =>
      method === "Runtime.callFunctionOn" && params.functionDeclaration.includes('type === "file"')
        ? (f.session.sent.push([method, params]), { result: { value: { multiple: false } } })
        : send(method, params)
  )(f.session.send);
  await f.run("browser_snapshot");
  const done = await f.run("browser_upload", { ref: "@e2", paths: [path.join(worktree, "clip.mp4")] });
  assert.equal(done.isError, false, done.text);
  assert.match(done.text, /Attached clip\.mp4 \(3\.0 MB\)/);
  assert.deepEqual(f.session.sent.find(([method]) => method === "DOM.setFileInputFiles")[1], { files: [path.join(worktree, "clip.mp4")], backendNodeId: 11 });
  // A field that takes one file refuses two.
  const two = await f.run("browser_upload", { ref: "@e2", paths: [path.join(worktree, "clip.mp4"), path.join(worktree, "cover.png")] });
  assert.match(two.text, /takes one file/);
  // Nothing past the Chat's folders, a symlink out of them included, and only absolute paths.
  for (const [file, reason] of [
    [path.join(root, "secret.txt"), /outside this Chat's Worktrees/],
    [path.join(worktree, "link.txt"), /outside this Chat's Worktrees/],
    ["clip.mp4", /not an absolute path/],
    [path.join(worktree, "gone.mp4"), /doesn't exist/],
    [worktree, /not a file/],
  ]) {
    const refused = await f.run("browser_upload", { ref: "@e2", paths: [file] });
    assert.equal(refused.isError, true, file);
    assert.match(refused.text, reason, file);
  }
  assert.equal(f.session.sent.filter(([method]) => method === "DOM.setFileInputFiles").length, 1, "refused uploads set nothing");
  assert.match((await f.run("browser_upload", { paths: [path.join(worktree, "clip.mp4")] })).text, /a ref or a selector/);
});

test("upload clicks a button with the file picker caught, and sets the files on the input that opened it", async (t) => {
  const { worktree } = uploadFolder(t);
  // A paired desktop's page reads copies put on that desktop.
  const f = fixture({ roots: [worktree], files: async (paths) => paths.map((file) => `/desktop/tmp/${path.basename(file)}`) });
  const send = f.session.send;
  f.session.send = async (method, params) => {
    const result = await send(method, params);
    if (method === "Runtime.callFunctionOn") return { result: { value: null } };
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased")
      setTimeout(() => f.session.emit("Page.fileChooserOpened", { frameId: "main", mode: "selectMultiple", backendNodeId: 77 }), 5);
    return result;
  };
  await f.run("browser_snapshot");
  const done = await f.run("browser_upload", { ref: "@e3", paths: [path.join(worktree, "clip.mp4"), path.join(worktree, "cover.png")] });
  assert.equal(done.isError, false, done.text);
  const order = f.session.sent
    .map(([method, params]) => (method === "Input.dispatchMouseEvent" ? params.type : method))
    .filter((name) => !name.startsWith("Accessibility") && !name.endsWith("enable") && name !== "Runtime.evaluate");
  assert.deepEqual(order.slice(order.indexOf("Page.setInterceptFileChooserDialog")), [
    "Page.setInterceptFileChooserDialog",
    "DOM.scrollIntoViewIfNeeded",
    "DOM.getBoxModel",
    "mouseMoved",
    "mousePressed",
    "mouseReleased",
    "DOM.setFileInputFiles",
    "Page.setInterceptFileChooserDialog",
  ]);
  const intercept = f.session.sent.filter(([method]) => method === "Page.setInterceptFileChooserDialog").map(([, params]) => params.enabled);
  assert.deepEqual(intercept, [true, false], "the picker is caught only for this click");
  assert.deepEqual(f.session.sent.find(([method]) => method === "DOM.setFileInputFiles")[1], {
    files: ["/desktop/tmp/clip.mp4", "/desktop/tmp/cover.png"],
    backendNodeId: 77,
  });
});

test("a click that opens no picker says so, and stops catching pickers", async (t) => {
  const { worktree } = uploadFolder(t);
  const f = fixture({ roots: [worktree] });
  const send = f.session.send;
  f.session.send = async (method, params) =>
    method === "Runtime.callFunctionOn" ? (await send(method, params), { result: { value: null } }) : send(method, params);
  await f.run("browser_snapshot");
  const missed = await f.run("browser_upload", { ref: "@e1", paths: [path.join(worktree, "cover.png")] });
  assert.equal(missed.isError, true);
  assert.match(missed.text, /opened no file picker/);
  assert.deepEqual(
    f.session.sent.filter(([method]) => method === "Page.setInterceptFileChooserDialog").map(([, params]) => params.enabled),
    [true, false],
  );
});
