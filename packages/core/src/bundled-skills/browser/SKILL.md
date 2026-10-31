---
name: browser
description: Drive the Chat's pages in Milagre's Browser panel (open, snapshot, click, fill, screenshot, console), and attach or detach a browser on this computer to the current Milagre Chat so the user can view and control its pages on desktop or phone. Use when showing the user a page, testing the Chat's own web app, driving a browser for web work, or when a browser you started does not show in the Chat.
---

# Chat browsers

## The Browser panel

The user has a browser inside Milagre, docked beside the Chat. Its pages belong to this Chat (`source: "panel"` in
`browser_list`), the user sees them as you act, and they comment on elements there (read those with
`browser_comments`). Prefer it over a separate headless browser when checking the Chat's own app.

1. `browser_open` with a URL opens it in a panel tab and returns the page id once it has loaded.
2. `browser_snapshot` reads the page as an accessibility tree; each element has a ref like `@e12`.
3. Act with `browser_click`, `browser_fill`, `browser_select`, `browser_type`, `browser_press`, `browser_hover`,
   `browser_scroll` and `browser_navigate`, passing refs from the latest snapshot. Refs go stale when the page changes:
   take a new snapshot after navigating or when an action says the ref is unknown.
4. `browser_wait` waits for text or for the page to load; `browser_screenshot` captures the page or one element (the
   user's comment pins are left out); `browser_console` lists recent console messages and errors; `browser_evaluate`
   runs a JavaScript expression.

Every tool takes an optional `page` (an id from `browser_list`) and otherwise acts on the Chat's newest panel page. The
same tools work on the pages of a browser attached to the Chat. Don't fight the user: if they are typing in the page,
wait. These pages exist only while Milagre's desktop app is open on this computer.

## Other browsers

1. Call Milagre's `browser_list`. `targets` are the pages already in this Chat: those of browsers this Chat's agent started (`source: "agent"`) and attached ones (`source: "attached"`). `others` are browsers on this computer that no Chat's agent started, with their id, product and page count.
2. A browser you launch yourself with `--remote-debugging-port` joins the Chat on its own while it stays in your process tree: Milagre reads the OS process table and attributes it to this Chat. Check `browser_list` after launching; if its pages are in `targets`, nothing else is needed.
3. If the browser is under `others`, call `browser_attach` with its id. This happens when the browser left your process tree (a daemon such as agent-browser's, a shell that backgrounded it and exited, `open -a`), or when the user started it. The tool supplies the current Chat identity; do not pass a Chat id.
4. Keep driving the browser with your own automation tools. Attaching makes its pages available in this Chat's Browser panel on desktop and phone; it never starts a capture, navigates or takes control. Keep it attached when finishing work so the user can inspect it.
5. Call `browser_detach` with the browser id when the user asks to remove it or you replace it. Detach closes this Chat's viewers of that browser, preserves other Chats' attachments and leaves the browser running. Browsers attributed by lineage cannot be detached; they leave the Chat when they exit.

A browser appears only if it exposes a loopback DevTools HTTP endpoint. Playwright MCP's default `--remote-debugging-pipe` and browsers without a debugging port never appear; launch with a port (`--remote-debugging-port=0` picks a free one) when the user should be able to watch. A browser another Chat's agent started is never offered; do not attach every browser you discover, and never close another Chat's browser to clean up this one. Attachments live in the host's memory and end when the browser exits or the host restarts.

Viewing never claims control from you: a person who takes control in the viewer shares the page with your DevTools session, so expect the page to change under you while they do.
