const { z } = require("zod");

// The agent's tools for driving the Chat's browser pages: its Browser panel pages (the page the user sees and comments
// on) and browsers attached to the Chat. Each acts on one page over DevTools (browsers.devtools), bound to the
// calling Chat; `page` names a target from browser_list and defaults to the Chat's newest Browser panel page.
// A snapshot gives each element a ref (@e12) that click, fill and the others take; refs go stale when the page navigates.

const page = z.string().max(200).optional().describe("A page id from browser_list. Defaults to this Chat's newest Browser panel page.");
const ref = z
  .string()
  .regex(/^@?e\d{1,6}$/)
  .describe("An element ref from the last browser_snapshot, like @e12.");
const MAX_SNAPSHOT_LINES = 600;
const MAX_TEXT = 20_000;
const CONSOLE_KEPT = 200;
// Roles that only group others: shown only when they carry a name.
const STRUCTURE = new Set(["generic", "none", "presentation", "LineBreak", "InlineTextBox", "StaticText", "paragraph", "group", "Section"]);
const KEYS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Space: { code: "Space", keyCode: 32, text: " ", key: " " },
};

const clip = (text, max = MAX_TEXT) => (text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text);

/** Sets up what the tools remember about a session the first time they use it: refs, console messages, navigation. */
async function prepare(session, state) {
  if (state.ready) return;
  state.ready = true;
  state.refs = new Map();
  state.console = [];
  session.on((method, params) => {
    if (method === "Page.frameNavigated" && !params.frame?.parentId) state.refs = new Map();
    if (method === "Runtime.consoleAPICalled") {
      const text = (params.args ?? []).map((arg) => (arg.value !== undefined ? String(arg.value) : (arg.description ?? arg.type))).join(" ");
      state.console.push(`[${params.type}] ${text.slice(0, 2000)}`);
    }
    if (method === "Runtime.exceptionThrown")
      state.console.push(`[exception] ${String(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "").slice(0, 2000)}`);
    if (method === "Log.entryAdded") state.console.push(`[${params.entry?.level ?? "log"}] ${String(params.entry?.text ?? "").slice(0, 2000)}`);
    if (state.console.length > CONSOLE_KEPT) state.console.splice(0, state.console.length - CONSOLE_KEPT);
  });
  await Promise.all([session.send("Page.enable"), session.send("Runtime.enable"), session.send("DOM.enable"), session.send("Log.enable").catch(() => {})]);
}

/** The Accessibility tree as indented lines, each element that can be acted on or named with a fresh ref. */
async function snapshot(session, state) {
  const { nodes = [] } = await session.send("Accessibility.getFullAXTree", {}, 20000);
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  state.refs = new Map();
  let next = 0;
  const lines = [];
  const value = (field) => (field && field.value !== undefined ? String(field.value) : "");
  const walk = (node, depth) => {
    if (!node || lines.length >= MAX_SNAPSHOT_LINES) return;
    const role = value(node.role);
    const name = value(node.name).replace(/\s+/g, " ").trim().slice(0, 120);
    const shown = !node.ignored && role && (!STRUCTURE.has(role) || name) && role !== "RootWebArea";
    let childDepth = depth;
    if (shown) {
      let line = `${"  ".repeat(depth)}- ${role}${name ? ` "${name.replace(/"/g, "'")}"` : ""}`;
      const current = value(node.value);
      if (current) line += ` value="${current.slice(0, 80).replace(/"/g, "'")}"`;
      for (const property of node.properties ?? []) {
        if (["checked", "selected", "expanded", "disabled", "focused", "required"].includes(property.name) && property.value?.value)
          line += ` [${property.name}]`;
      }
      if (node.backendDOMNodeId) {
        const id = `e${++next}`;
        state.refs.set(id, node.backendDOMNodeId);
        line += ` [ref=@${id}]`;
      }
      lines.push(line);
      childDepth = depth + 1;
    }
    for (const child of node.childIds ?? []) walk(byId.get(child), childDepth);
  };
  walk(nodes.find((node) => !node.parentId) ?? nodes[0], 0);
  const { result } = await session.send("Runtime.evaluate", { expression: "JSON.stringify([document.title, location.href])", returnByValue: true });
  const [title, url] = JSON.parse(result?.value ?? '["",""]');
  return `Page: ${title} (${url})\n${lines.join("\n")}${lines.length >= MAX_SNAPSHOT_LINES ? "\n… (more elements; act on what is shown or scroll)" : ""}`;
}

function backendNode(state, value) {
  const id = String(value).replace(/^@/, "");
  const node = state.refs?.get(id);
  if (!node) throw new Error(`No element ${value}: take a new browser_snapshot (refs go stale when the page changes).`);
  return node;
}

/** The middle of an element on screen, scrolled into view first. */
async function center(session, backendNodeId) {
  await session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
  const { model } = await session.send("DOM.getBoxModel", { backendNodeId });
  const quad = model?.content ?? model?.border;
  if (!quad) throw new Error("That element has no box on the page (hidden or detached).");
  const xs = [quad[0], quad[2], quad[4], quad[6]],
    ys = [quad[1], quad[3], quad[5], quad[7]];
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

async function onElement(session, backendNodeId, fn, args = []) {
  const { object } = await session.send("DOM.resolveNode", { backendNodeId });
  const { result, exceptionDetails } = await session.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: fn,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(String(exceptionDetails.exception?.description ?? exceptionDetails.text ?? "The page threw."));
  return result?.value;
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} chatId
 * @param {{ devtools(request: { chatId: string; page?: string }): Promise<{ target: { id: string; title: string; url: string }; session: any; state: any }>; list(request: { chatId: string }): Promise<{ targets: { id: string; url: string; source: string }[] }> }} browsers
 * @param {{ openInPanel(chatId: string, url: string): void }} panel
 */
function browserPageToolDefinitions(chatId, browsers, panel) {
  const on = async (input) => {
    const found = await browsers.devtools({ chatId, page: input.page });
    await prepare(found.session, found.state);
    return found;
  };
  const done = (target, extra = "") => JSON.stringify({ page: target.id, ...(extra ? { note: extra } : {}) });
  return [
    {
      name: "browser_open",
      description:
        "Open a web page in this Chat's Browser panel, the in-app browser the user sees beside the Chat (their dev server, a doc). Use it to show the user a page or to test the Chat's own app; prefer it over a separate headless browser for that. Returns the page id once it has loaded.",
      input: {
        url: z.string().url().max(2000),
        wait: z.number().int().min(0).max(30000).optional().describe("How long to wait for the page to appear, in ms (default 10000)."),
      },
      readOnly: false,
      run: async (input) => {
        if (!/^https?:\/\//i.test(input.url)) throw new Error("Only http and https pages open in the Browser panel.");
        panel.openInPanel(chatId, input.url);
        const until = Date.now() + (input.wait ?? 10000);
        const want = input.url.replace(/\/$/, "");
        while (Date.now() < until) {
          const { targets } = await browsers.list({ chatId });
          const target = targets.find((item) => item.source === "panel" && item.url.replace(/\/$/, "") === want) ?? null;
          if (target) return JSON.stringify({ page: target.id, url: target.url });
          await settle(400);
        }
        return JSON.stringify({
          note: "The Browser panel was asked to open the page but hasn't reported it. Milagre may not be open on this computer; check browser_list.",
        });
      },
    },
    {
      name: "browser_snapshot",
      description:
        "Read a page of this Chat as an accessibility tree: each element's role, name and state, with a ref (@e12) to pass to browser_click, browser_fill and the others. Take a new one after the page changes.",
      input: { page },
      readOnly: true,
      run: async (input) => {
        const { session, state } = await on(input);
        return clip(await snapshot(session, state), 60_000);
      },
    },
    {
      name: "browser_click",
      description: "Click an element of the page by its ref from browser_snapshot, as a person would with the mouse.",
      input: { page, ref, double: z.boolean().optional() },
      readOnly: false,
      run: async (input) => {
        const { target, session, state } = await on(input);
        const { x, y } = await center(session, backendNode(state, input.ref));
        const clickCount = input.double ? 2 : 1;
        await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount });
        await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount });
        await settle();
        return done(target);
      },
    },
    {
      name: "browser_hover",
      description: "Move the mouse over an element by its ref, for menus and tooltips that open on hover.",
      input: { page, ref },
      readOnly: false,
      run: async (input) => {
        const { target, session, state } = await on(input);
        const { x, y } = await center(session, backendNode(state, input.ref));
        await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        return done(target);
      },
    },
    {
      name: "browser_fill",
      description: "Replace the text of an input or text area by its ref with `text`, firing the input events a framework listens for.",
      input: { page, ref, text: z.string().max(20000) },
      readOnly: false,
      run: async (input) => {
        const { target, session, state } = await on(input);
        const node = backendNode(state, input.ref);
        await session.send("DOM.focus", { backendNodeId: node }).catch(() => {});
        // Clear through the native setter, so React and other frameworks see the change.
        await onElement(
          session,
          node,
          `function () {
            this.focus();
            if ("value" in this) {
              const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), "value")?.set;
              if (setter) setter.call(this, ""); else this.value = "";
              this.dispatchEvent(new Event("input", { bubbles: true }));
            } else if (this.isContentEditable) this.textContent = "";
          }`,
        );
        if (input.text) await session.send("Input.insertText", { text: input.text });
        return done(target);
      },
    },
    {
      name: "browser_select",
      description: "Choose an option of a <select> by its ref, by the option's value or its visible text.",
      input: { page, ref, option: z.string().max(500) },
      readOnly: false,
      run: async (input) => {
        const { target, session, state } = await on(input);
        const chosen = await onElement(
          session,
          backendNode(state, input.ref),
          `function (wanted) {
            if (!(this instanceof HTMLSelectElement)) throw new Error("That element is not a select.");
            const option = [...this.options].find((item) => item.value === wanted || item.text.trim() === wanted);
            if (!option) throw new Error("No option " + wanted + ". Options: " + [...this.options].map((item) => item.text.trim()).join(", "));
            this.value = option.value;
            this.dispatchEvent(new Event("input", { bubbles: true }));
            this.dispatchEvent(new Event("change", { bubbles: true }));
            return option.text.trim();
          }`,
          [input.option],
        );
        return done(target, `Selected ${chosen}`);
      },
    },
    {
      name: "browser_type",
      description: "Type text into whatever has the keyboard focus on the page (after browser_click on a field).",
      input: { page, text: z.string().max(20000) },
      readOnly: false,
      run: async (input) => {
        const { target, session } = await on(input);
        await session.send("Input.insertText", { text: input.text });
        return done(target);
      },
    },
    {
      name: "browser_press",
      description: `Press a key on the page: ${Object.keys(KEYS).join(", ")}, or a single character, optionally with Shift or Alt. Command and Control shortcuts aren't sent: use browser_fill to replace a field's text.`,
      // A key pressed on a Browser panel page reaches Milagre's window like the user's own, so ⌘ and Ctrl combinations
      // (the app's shortcuts: close the panel, switch Chats) are never pressed for the agent.
      input: {
        page,
        key: z.string().min(1).max(20),
        modifiers: z
          .array(z.enum(["Alt", "Shift"]))
          .max(2)
          .optional(),
      },
      readOnly: false,
      run: async (input) => {
        const { target, session } = await on(input);
        const named = KEYS[input.key];
        if (!named && input.key.length !== 1) throw new Error(`Unknown key ${input.key}. Use one of ${Object.keys(KEYS).join(", ")} or one character.`);
        const bits = { Alt: 1, Shift: 8 };
        const modifiers = (input.modifiers ?? []).reduce((sum, name) => sum | bits[name], 0);
        const key = named?.key ?? input.key;
        const event = named
          ? { key, code: named.code, windowsVirtualKeyCode: named.keyCode, modifiers, ...(named.text && !modifiers ? { text: named.text } : {}) }
          : {
              key,
              code: `Key${input.key.toUpperCase()}`,
              windowsVirtualKeyCode: input.key.toUpperCase().charCodeAt(0),
              modifiers,
              ...(modifiers & ~8 ? {} : { text: input.key }),
            };
        await session.send("Input.dispatchKeyEvent", { type: event.text ? "keyDown" : "rawKeyDown", ...event });
        await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...event, text: undefined });
        await settle();
        return done(target);
      },
    },
    {
      name: "browser_scroll",
      description: "Scroll the page by `y` pixels (negative scrolls up), or bring an element by its ref into view.",
      input: { page, y: z.number().int().min(-20000).max(20000).optional(), ref: ref.optional() },
      readOnly: false,
      run: async (input) => {
        const { target, session, state } = await on(input);
        if (input.ref) await session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: backendNode(state, input.ref) });
        else await session.send("Runtime.evaluate", { expression: `window.scrollBy({ top: ${Number(input.y ?? 600)}, behavior: "instant" })` });
        return done(target);
      },
    },
    {
      name: "browser_navigate",
      description: "Load a URL in a page of this Chat, or go back, forward or reload it.",
      input: { page, url: z.string().url().max(2000).optional(), action: z.enum(["back", "forward", "reload"]).optional() },
      readOnly: false,
      run: async (input) => {
        const { target, session } = await on(input);
        if (input.url) {
          if (!/^https?:\/\//i.test(input.url)) throw new Error("Only http and https pages.");
          const result = await session.send("Page.navigate", { url: input.url }, 30000);
          if (result.errorText) throw new Error(`The page didn't load: ${result.errorText}`);
        } else if (input.action === "reload") await session.send("Page.reload", {});
        else if (input.action) await session.send("Runtime.evaluate", { expression: input.action === "back" ? "history.back()" : "history.forward()" });
        else throw new Error("Pass a url or an action.");
        await settle(500);
        return done(target);
      },
    },
    {
      name: "browser_wait",
      description: "Wait until the page shows `text`, or until the page has finished loading when no text is given. Up to `timeoutMs` (default 10000).",
      input: { page, text: z.string().max(500).optional(), timeoutMs: z.number().int().min(100).max(60000).optional() },
      readOnly: true,
      run: async (input) => {
        const { target, session } = await on(input);
        const until = Date.now() + (input.timeoutMs ?? 10000);
        const check = input.text
          ? `document.body ? document.body.innerText.includes(${JSON.stringify(input.text)}) : false`
          : `document.readyState === "complete"`;
        while (Date.now() < until) {
          const { result } = await session.send("Runtime.evaluate", { expression: check, returnByValue: true });
          if (result?.value === true) return done(target);
          await settle(250);
        }
        throw new Error(input.text ? `"${input.text}" didn't appear in time.` : "The page didn't finish loading in time.");
      },
    },
    {
      name: "browser_screenshot",
      description: "A screenshot of a page of this Chat, or of one element by its ref. The user's comment pins are left out.",
      input: { page, ref: ref.optional(), fullPage: z.boolean().optional() },
      readOnly: true,
      run: async (input) => {
        const { target, session, state } = await on(input);
        let area;
        if (input.ref) {
          const backendNodeId = backendNode(state, input.ref);
          await session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
          const { model } = await session.send("DOM.getBoxModel", { backendNodeId });
          const quad = model.border;
          const xs = [quad[0], quad[2], quad[4], quad[6]],
            ys = [quad[1], quad[3], quad[5], quad[7]];
          area = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), scale: 1 };
        }
        await session.send("Runtime.evaluate", { expression: "window.__milagrePins?.hide(true)" }).catch(() => {});
        try {
          const shot = await session.send(
            "Page.captureScreenshot",
            { format: "png", ...(area ? { clip: area } : {}), ...(input.fullPage && !area ? { captureBeyondViewport: true } : {}) },
            30000,
          );
          return { text: done(target), images: [{ base64: shot.data, mime: "image/png" }] };
        } finally {
          await session.send("Runtime.evaluate", { expression: "window.__milagrePins?.hide(false)" }).catch(() => {});
        }
      },
    },
    {
      name: "browser_console",
      description: "The page's recent console messages and uncaught errors, newest last, since the tools first touched the page.",
      input: { page, clear: z.boolean().optional() },
      readOnly: true,
      run: async (input) => {
        const { target, state } = await on(input);
        const lines = state.console.slice(-100);
        if (input.clear) state.console.length = 0;
        return clip(`Page: ${target.url}\n${lines.length ? lines.join("\n") : "(no messages)"}`);
      },
    },
    {
      name: "browser_evaluate",
      description:
        "Run JavaScript on the page in the Browser panel to read or check something there, and get the result back. A promise is waited for; the result comes back as JSON.",
      input: { page, expression: z.string().min(1).max(20000) },
      readOnly: false,
      run: async (input) => {
        const { session } = await on(input);
        const { result, exceptionDetails } = await session.send(
          "Runtime.evaluate",
          { expression: input.expression, returnByValue: true, awaitPromise: true },
          30000,
        );
        if (exceptionDetails) throw new Error(String(exceptionDetails.exception?.description ?? exceptionDetails.text ?? "The expression threw."));
        return clip(result?.value === undefined ? String(result?.description ?? "undefined") : JSON.stringify(result.value, null, 2));
      },
    },
  ];
}

module.exports = { browserPageToolDefinitions };
