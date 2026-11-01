import test from "node:test";
import assert from "node:assert/strict";
import { htmlRenderShell, htmlRenderHeight, readHtmlRenderMessage, HTML_RENDER_MESSAGE, HTML_RENDER_MIN_HEIGHT, HTML_RENDER_THEMES } from "./html-render.mjs";

test("HTML replies constrain messages and seal document navigation", () => {
  const message = (data: object) => readHtmlRenderMessage({ channel: HTML_RENDER_MESSAGE, ...data });
  assert.equal(message({ type: "link", url: "file:///etc/passwd" }), null);
  assert.equal(message({ type: "link", url: "javascript:alert(1)" }), null);
  assert.equal(message({ type: "link", url: "https://user:pass@example.com" }), null);
  assert.equal(message({ type: "tool", name: "delete" }), null);
  assert.equal(readHtmlRenderMessage({ type: "size", height: 200 }), null);
  assert.deepEqual(message({ type: "size", height: 1e8 }), { type: "size", height: 2000 });
  assert.deepEqual(message({ type: "link", url: "https://example.com" }), { type: "link", url: "https://example.com/" });
  const shell = htmlRenderShell("<script>parent.evil()</script><h1>Page</h1>");
  assert.match(shell, /sandbox="allow-scripts"/);
  assert.doesNotMatch(shell, /allow-same-origin|allow-top-navigation/);
  assert.match(shell, /frame-src 'none'/);
  assert.ok(!shell.includes("<script>parent.evil()"));
});

test("HTML replies take the reader theme into the first paint and drop unsafe values", () => {
  const shell = htmlRenderShell("<p>x</p>", { ...HTML_RENDER_THEMES.dark, background: "transparent", ink: "red;}body{display:none" });
  assert.match(shell, /color-scheme:dark/);
  const inner = shell.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  // The page applies the initial theme itself, through the same filter as live theme messages.
  assert.match(inner, /theme\(\{"scheme":"dark"/);
  assert.match(inner, /\(value\)=>\{/);
  assert.match(inner, /html,body\{margin:0!important;padding:0!important/);
  assert.match(inner, /:where\(button,input:is/);
  assert.deepEqual(readHtmlRenderMessage({ channel: HTML_RENDER_MESSAGE, type: "size", height: 30 }), { type: "size", height: HTML_RENDER_MIN_HEIGHT + 6 });
  assert.equal(htmlRenderHeight(1), HTML_RENDER_MIN_HEIGHT);
});

test("inline roots stay transparent even when a preview or reader supplies a solid background", () => {
  const shell = htmlRenderShell("<p>x</p>", HTML_RENDER_THEMES.light);
  const document = shell.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  assert.match(shell, /html\{background:transparent;color-scheme:light\}/);
  assert.match(document, /--background:transparent/);
  assert.match(document, /background:transparent!important/);
  assert.doesNotMatch(document, /background:'background'|root.background=theme.background/);
});
