const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { z } = require("zod");

// The comments the user sent on Browser panel pages, one file per Chat. The message names each comment and carries the
// element's details; the host keeps what the agent needs to list them again and resolve them. Each:
// { id, url, title, label, selector, source?, point?, text, createdAt, resolved?: { note, at } }.
const MAX_COMMENTS = 2000;
const COMMENT_ID = /^[a-f0-9]{8}$/;

function createChatPageComments({ directory, validateChat }) {
  const file = (chatId) => path.join(directory, `${createHash("sha256").update(chatId).digest("hex").slice(0, 32)}.json`);
  let queue = Promise.resolve();
  const serial = (work) => {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
  };
  async function chat(chatId) {
    if (typeof chatId !== "string" || !chatId || chatId.length > 8192) throw Error("Name an existing Chat.");
    await validateChat?.(chatId);
    return file(chatId);
  }
  async function read(target) {
    try {
      const saved = JSON.parse(await fs.readFile(target, "utf8"));
      return Array.isArray(saved) ? saved : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  async function write(target, comments) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(comments), { mode: 0o600 });
    await fs.rename(temporary, target);
  }
  const line = (value, max) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
  return {
    /** Records the comments the user is sending, and returns them with their ids for the message to name. */
    add: (request) =>
      serial(async () => {
        const target = await chat(request?.chatId);
        const incoming = Array.isArray(request?.comments) ? request.comments : [];
        if (!incoming.length || incoming.length > 50) throw Error("Send between 1 and 50 comments at once.");
        const added = incoming.map((comment) => {
          const url = typeof comment?.url === "string" ? comment.url.slice(0, 2000) : "";
          if (!/^https?:\/\//i.test(url)) throw Error("A page comment names the web page it is on.");
          const text = typeof comment.text === "string" ? comment.text.trim().slice(0, 4000) : "";
          if (!text) throw Error("A comment needs its text.");
          const element = comment.element ?? {};
          const selector = line(element.selector, 500);
          if (!selector) throw Error("A page comment names its element.");
          const source = line(element.source, 300);
          const fraction = (value) => (typeof value === "number" && value >= 0 && value <= 1 ? Math.round(value * 1000) / 1000 : undefined);
          const point =
            element.point && fraction(element.point.x) !== undefined && fraction(element.point.y) !== undefined
              ? { x: fraction(element.point.x), y: fraction(element.point.y) }
              : null;
          return {
            // The app names the comment in the message it sends first; a retried send names it again and is kept once.
            id: typeof comment.id === "string" && COMMENT_ID.test(comment.id) ? comment.id : randomUUID().replace(/-/g, "").slice(0, 8),
            url,
            title: line(comment.title, 200),
            label: line(element.label, 200) || selector,
            selector,
            ...(source ? { source } : {}),
            ...(point ? { point } : {}),
            text,
            createdAt: Date.now(),
          };
        });
        const kept = await read(target);
        const seen = new Set(kept.map((comment) => comment.id));
        const fresh = added.filter((comment) => !seen.has(comment.id) && seen.add(comment.id));
        await write(target, [...kept, ...fresh].slice(-MAX_COMMENTS));
        return added;
      }),
    list: (request) => serial(async () => read(await chat(request?.chatId))),
    /** Marks a comment resolved, with the agent's note on what it did about it. */
    resolve: (request) =>
      serial(async () => {
        const target = await chat(request?.chatId);
        const note = typeof request?.note === "string" ? request.note.trim().slice(0, 2000) : "";
        if (!note) throw Error("Say how the comment was resolved.");
        const all = await read(target);
        const comment = all.find((item) => item.id === request?.id);
        if (!comment) throw Error(`No page comment ${request?.id} in this Chat. List them with browser_comments.`);
        comment.resolved = { note, at: Date.now() };
        await write(target, all);
        return comment;
      }),
    /** Forgets comments recorded for a message that then didn't go. */
    forget: (request) =>
      serial(async () => {
        const target = await chat(request?.chatId);
        const ids = new Set(Array.isArray(request?.ids) ? request.ids : []);
        const all = await read(target);
        const kept = all.filter((comment) => !ids.has(comment.id));
        if (kept.length !== all.length) await write(target, kept);
      }),
    /** Forgets the comments of a Chat that is gone. */
    removeChat: (chatId) =>
      serial(async () => {
        if (typeof chatId !== "string" || !chatId || chatId.length > 8192) return;
        await fs.rm(file(chatId), { force: true });
      }),
    close: () => queue,
  };
}

/** The agent's tools for the comments the user left on Browser panel pages, bound to its own Chat. */
function pageCommentToolDefinitions(chatId, pageComments) {
  return [
    {
      name: "browser_comments",
      description:
        "List the comments the user left on Browser panel pages in this Chat, the open ones unless you ask for all. Each has an id, the page url and title, the element (label, CSS selector, source location when known) and the user's text. The message that sent them also carries each element's HTML, styles and a screenshot.",
      input: { all: z.boolean().optional() },
      readOnly: true,
      run: async (input) => JSON.stringify((await pageComments.list({ chatId })).filter((comment) => input.all || !comment.resolved)),
    },
    {
      name: "browser_resolve_comment",
      description:
        "Mark one of the user's Browser panel page comments resolved once you have addressed it, with a short note on what you changed. The user sees the pin on the page turn resolved, with your note. The comment's id is in the user's message, or from browser_comments.",
      input: { id: z.string().regex(COMMENT_ID), note: z.string().min(1).max(2000) },
      readOnly: false,
      run: async (input) => {
        const comment = await pageComments.resolve({ chatId, id: input.id, note: input.note });
        return JSON.stringify({ id: comment.id, resolved: comment.resolved });
      },
    },
  ];
}

/**
 * What a tap on the phone's view of a page points at: the element at (x, y), fractions of the page's viewport, read like
 * a pick (selector, label, HTML, styles, component, the point on it), and a PNG of it with a margin, the comment pins
 * hidden. `page` is a DevTools session on the page. Throws when there is nothing to comment on there.
 */
async function commentAtPoint(page, x, y) {
  const { pageDescribeAtScript } = await import("@milagre/shared/page-picker");
  const found = await page.send("Runtime.evaluate", { expression: pageDescribeAtScript(x, y), returnByValue: true });
  const element = pageElement(found.result?.value);
  if (!element) throw new Error("Could not place a comment pin. Reload the page and try again.");
  let shot = null;
  await page.send("Runtime.evaluate", { expression: "window.__milagrePins?.hide(true)" }).catch(() => {});
  try {
    const margin = 12;
    const { box } = element;
    const capture = await page.send("Page.captureScreenshot", {
      format: "png",
      clip: {
        x: Math.max(0, box.x - margin),
        y: Math.max(0, box.y - margin),
        width: Math.max(1, box.width + margin * 2),
        height: Math.max(1, box.height + margin * 2),
        scale: 1,
      },
    });
    shot = typeof capture.data === "string" ? capture.data : null;
  } catch {
    // A comment without its screenshot is still a comment.
  } finally {
    await page.send("Runtime.evaluate", { expression: "window.__milagrePins?.hide(false)" }).catch(() => {});
  }
  return { element, shot };
}

/**
 * What the page said about an element, kept to the shape PageElement describes. The page is any web page and its
 * scripts can replace what the describe script returns, so nothing of it is trusted: strings are clipped, numbers must
 * be numbers, and anything else is dropped. null when it names no element.
 */
function pageElement(value) {
  if (!value || typeof value !== "object") return null;
  const text = (item, max) => (typeof item === "string" ? item.slice(0, max) : undefined);
  const number = (item) => (typeof item === "number" && Number.isFinite(item) ? Math.round(item) : 0);
  const fraction = (item) => (typeof item === "number" && item >= 0 && item <= 1 ? item : 0.5);
  const selector = text(value.selector, 500)?.replace(/\s+/g, " ").trim();
  const tag = text(value.tag, 40)?.replace(/[^a-z0-9-]/gi, "") || "element";
  if (!selector || !value.box || typeof value.box !== "object") return null;
  const box = { x: number(value.box.x), y: number(value.box.y), width: Math.max(0, number(value.box.width)), height: Math.max(0, number(value.box.height)) };
  const viewport = { width: Math.max(1, number(value.viewport?.width)), height: Math.max(1, number(value.viewport?.height)) };
  const styles = Object.fromEntries(
    Object.entries(value.styles && typeof value.styles === "object" ? value.styles : {})
      .filter(([name, style]) => /^[a-z-]{1,40}$/.test(name) && typeof style === "string")
      .slice(0, 24)
      .map(([name, style]) => [name, style.slice(0, 200)]),
  );
  const components = Array.isArray(value.components)
    ? value.components
        .filter((name) => typeof name === "string")
        .slice(0, 4)
        .map((name) => name.slice(0, 80))
    : [];
  const optional = {
    role: text(value.role, 40),
    name: text(value.name, 80),
    text: text(value.text, 200),
    html: text(value.html, 1600),
    source: text(value.source, 300),
  };
  return {
    selector,
    tag,
    label: text(value.label, 200)?.replace(/\s+/g, " ").trim() || tag,
    ...Object.fromEntries(Object.entries(optional).filter(([, item]) => item)),
    styles,
    box,
    viewport,
    ...(components.length ? { components } : {}),
    point: { x: fraction(value.point?.x), y: fraction(value.point?.y) },
  };
}

module.exports = { commentAtPoint, createChatPageComments, pageCommentToolDefinitions };
