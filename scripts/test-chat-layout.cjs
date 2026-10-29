// Run with node scripts/test-chat-layout.cjs. Uses the app's existing Vite and
// Electron dependencies to check browser geometry without an extra test runner.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React, { Activity, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { PersistenceNotices } from "/src/components/PersistenceNotice";
import { ChatComposer } from "/src/components/ChatComposer";
import { MessageScroller } from "/src/components/agents/message-scroller";
import { Markdown, StreamingMarkdown } from "/src/components/markdown/Markdown";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import "/src/styles.css";
window.milagre = Object.freeze({ listEditors: async () => [], retrySave: () => new Promise(resolve => { window.finishSave = resolve; }) });
const noop = () => {};
function Fixture() {
  const [saveScopes, setSaveScopes] = useState([]);
  window.setSaveScopes = setSaveScopes;
  const [disconnected, setDisconnected] = useState(false);
  window.setDisconnected = setDisconnected;
  const [imageChat, setImageChat] = useState(false);
  const [imageHeight, setImageHeight] = useState(320);
  window.showImageChat = setImageChat;
  window.resizeLastImage = setImageHeight;
  const [count, setCount] = useState(50);
  const [sessionId, setSessionId] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(undefined);
  window.failLoad = () => flushSync(() => { setLoading(false); setLoadError("Read interrupted"); });
  window.setLoading = value => flushSync(() => setLoading(value));
  window.switchChat = (id, count) => flushSync(() => { setSessionId(id); setCount(count); });
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState(MODEL_CATALOG[0]);
  const [fastMode, setFastMode] = useState(false);
  const [ultracode, setUltracode] = useState(false);
  const [prAction, setPrAction] = useState(null);
  const [sending, setSending] = useState(false);
  const [extra, setExtra] = useState([]);
  window.setExtraMessages = setExtra;
  const [markdownExample, setMarkdownExample] = useState(null);
  window.setMarkdownExample = setMarkdownExample;
  if (markdownExample) return <div data-markdown-example><Markdown text={markdownExample} /><StreamingMarkdown text={markdownExample} /></div>;
  window.setPrAction = setPrAction;
  window.setSending = setSending;
  window.resolveClicks ??= 0;
  window.setMessageCount = setCount;
  window.setDraft = setDraft;
  window.setModel = (id) => setModel(MODEL_CATALOG.find((item) => item.id === id));
  const messages = Array.from({ length: count }, (_, index) => ({
    id: sessionId * 1000 + index + 1, session_id: sessionId, context: null, role: "assistant",
    body: "Reply " + (index + 1) + ". PR aberta com sucesso: [#9 — fix: update app icon asset](https://github.com/example/project/pull/9). " + index
      + " The fix is in PR #289: https://github.com/the-ptf/milagre-ade/pull/289. Code: \`https://example.org\`.",
  }));
  if (imageChat) return <MessageScroller className="h-full" contentClassName="p-4">
    {Array.from({ length: 50 }, (_, index) => <article key={index} data-slot="message" data-from="assistant" data-streaming={index === 49 || undefined}>
      <p>Generated image {index + 1}</p>
      <img alt={"Generated image " + (index + 1)} style={{ width: 320 }} src={"data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="' + (index === 49 ? imageHeight : 320) + '"><rect width="100%" height="100%" fill="teal"/></svg>')} />
    </article>)}
  </MessageScroller>;
  return <div style={{ height: "100%", padding: 12 }}>
    <PersistenceNotices scopes={saveScopes}>{disconnected && <div data-save-connection>Reconnecting to your computer</div>}</PersistenceNotices>
    {/* Exercise the fully expanded history, as when Find is open; paging has its own regression. */}
    <ChatComposer findOpen loadError={loadError} onRetryLoad={() => { setLoadError(undefined); setLoading(false); setCount(100); }} loading={loading} agentChatId={"/fixture#" + sessionId} scrollKey={sessionId} messages={[...messages, ...extra]}
      imageDraft={{ images: [], files: [], removeFile: noop, attachFiles: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
      projectPath="/fixture" draft={draft} onDraftChange={setDraft} onSend={noop} isSending={sending} sendBlocked={false}
      pullRequestAction={prAction ? { ...prAction, onRun: () => window.resolveClicks++ } : undefined}
      models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={model} onModelChange={noop}
      capability={capabilityFor(model, null)} onEffortChange={noop} ultracode={ultracode} onUltracodeChange={setUltracode}
      fastMode={fastMode} onFastModeChange={setFastMode} permissionMode="auto" onPermissionModeChange={noop}
      onRecommendationSelect={noop} worktrees={[{ id: 1, name: "main", path: "/fixture" }]} onWorktreeChange={noop}
      isolation="worktree" onIsolationChange={noop} branches={["main"]} baseBranch="main" onBaseBranchChange={noop} newChatError={null}
      linearActive onStartFromIssue={noop} />
  </div>;
}
document.documentElement.classList.add("dark");
function Workspace() {
  const [shown, setShown] = useState(true);
  window.showWorkspace = value => flushSync(() => setShown(value));
  return <Activity mode={shown ? "visible" : "hidden"}><Fixture /></Activity>;
}
createRoot(document.getElementById("root")).render(<Workspace />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  // A fresh profile, so a zoom level saved for 127.0.0.1 in the shared Electron profile can't change the layout.
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-chat-layout-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 800, height: 600, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  const consoleErrors = [];
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") {
      consoleErrors.push(event.message);
      console.error(event.message);
    }
  });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  // Browser resize, scroll events and Motion projection finish on frames, not on a fixed wall-clock delay.
  const settleGeometry = (source) =>
    evaluate(`new Promise((resolve, reject) => {
      let previous, stable = 0;
      const deadline = performance.now() + 10000;
      const sample = () => {
        try {
          const current = JSON.stringify(${source});
          stable = current === previous ? stable + 1 : 0;
          previous = current;
          if (stable >= 4) resolve();
          else if (performance.now() >= deadline) reject(new Error('Layout did not settle: ' + current));
          else requestAnimationFrame(sample);
        } catch (error) { reject(error); }
      };
      requestAnimationFrame(sample);
    })`);
  try {
    await window.loadURL(process.argv[2]);
    await waitFor('document.querySelectorAll("[data-slot=preview-rail-item]").length > 0');
    await evaluate('window.setMessageCount(0); window.setDraft("verify")');
    await waitFor('!!document.querySelector("[data-new-chat-pickers]")');
    const focusLabel = `(() => {
      const element = document.activeElement;
      return element.getAttribute('aria-label') || (element.querySelector('[data-model-name]') ? 'Model' : element.textContent.trim());
    })()`;
    const expectedFocus = ["New worktree", "main", "Linear issue", "Prompt", "Add attachments and sources", "Model", "Agent permissions", "Dictate", "Send"];
    const tab = async (backwards = false) => {
      const modifiers = backwards ? ["shift"] : [];
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab", modifiers });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab", modifiers });
      await delay(25);
      return evaluate(focusLabel);
    };
    await evaluate('document.querySelector("[data-new-chat-pickers] button").focus()');
    const forward = [await evaluate(focusLabel)];
    for (let i = 1; i < expectedFocus.length; i++) forward.push(await tab());
    assert.deepEqual(forward, expectedFocus, "New Chat tabs through setup, prompt, add, model, permissions, dictate and send in order");
    const backward = [await evaluate(focusLabel)];
    for (let i = 1; i < expectedFocus.length; i++) backward.push(await tab(true));
    assert.deepEqual(backward, expectedFocus.toReversed(), "Shift+Tab reverses the New Chat focus order");
    assert.ok(
      await evaluate(`(() => {
        const prompt = document.querySelector('[data-prompt-editor]').getBoundingClientRect();
        const add = document.querySelector('[aria-label="Add attachments and sources"]').getBoundingClientRect();
        const model = document.querySelector('[data-model-name]').getBoundingClientRect();
        return prompt.bottom <= add.top && add.right <= model.left;
      })()`),
      "The New Chat prompt stays above the toolbar with Add to the left of Model",
    );
    if (process.env.MILAGRE_SCREENSHOT_DIR)
      await window.webContents
        .capturePage()
        .then((image) => require("node:fs").writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "new-chat-focus.png"), image.toPNG()));
    console.log("PASS: New Chat keyboard focus follows setup, prompt and action controls in both directions");
    await evaluate('window.setMessageCount(50); window.setDraft("")');
    await waitFor('document.querySelectorAll("[data-slot=preview-rail-item]").length > 0');
    assert.ok(
      await evaluate(`(() => {
        const links = [...document.querySelectorAll('.markdown a')];
        return links.some(a => a.getAttribute('href') === 'https://github.com/the-ptf/milagre-ade/pull/289'
          && a.textContent === 'https://github.com/the-ptf/milagre-ade/pull/289'
          && getComputedStyle(a).textDecorationLine.includes('underline'))
          && links.some(a => a.getAttribute('href') === 'https://github.com/example/project/pull/9')
          && !links.some(a => a.getAttribute('href') === 'https://example.org');
      })()`),
      "Desktop replies detect bare URLs without trailing punctuation, preserve labeled links and keep code inert",
    );
    await delay(250);
    // Markdown documents inside fences use the same renderer, including while streaming.
    for (const language of ["markdown", "md", "Markdown"]) {
      const example =
        "~~~~" +
        language +
        "\n## Description\n\nA **change** with [a link](https://example.org).\n\n- First\n\n| File | State |\n| --- | --- |\n| Chat | Ready |\n\n```ts\nconst value = 1;\n```\n~~~~";
      await evaluate(`window.setMarkdownExample(${JSON.stringify(example)})`);
      await waitFor(`document.querySelectorAll('[data-markdown-example] h2').length === 2`);
      for (const tag of ["strong", "li", "table", 'a[href="https://example.org"]']) {
        assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify("[data-markdown-example] " + tag)}).length`), 2);
      }
      assert.equal(await evaluate(`document.querySelectorAll('[data-markdown-example] pre').length`), 2, "Only nested TypeScript uses a code block");
    }
    if (process.env.MILAGRE_SCREENSHOT_DIR)
      require("node:fs").writeFileSync(
        path.join(process.env.MILAGRE_SCREENSHOT_DIR, "rendered-markdown.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
    await evaluate(`window.setMarkdownExample("\x60\x60\x60markdown\\nA **live answer")`);
    await waitFor(`document.querySelector('[data-markdown-example] strong')?.textContent === 'live answer'`);
    await evaluate(`window.setMarkdownExample(null)`);
    await waitFor(`!!document.querySelector('[data-prompt-editor]')`);
    console.log("PASS: Markdown fences render headings, lists, links, tables and streamed emphasis; nested code remains code");
    if (process.env.MILAGRE_SCREENSHOT_DIR)
      await window.webContents
        .capturePage()
        .then((image) => require("node:fs").writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "message-rail.png"), image.toPNG()));
    // The rail measures the transcript again once the Markdown example is gone: a slow runner can read it before that.
    await waitFor('document.querySelectorAll("[data-slot=preview-rail-item]").length === 15').catch(() => {});
    assert.equal(await evaluate('document.querySelectorAll("[data-slot=preview-rail-item]").length'), 15, "Long Chats show at most 15 navigation lines");
    const jumpButton = `document.querySelector('button[aria-label="Go to bottom"]')`;
    const distanceFromBottom = `(() => { const v = document.querySelector('[aria-label="Conversation"]'); return v.scrollHeight - v.clientHeight - v.scrollTop; })()`;
    const readEarlier = `(() => {
      const viewport = document.querySelector('[aria-label="Conversation"]');
      viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
      viewport.scrollTo({ top: 0, behavior: 'instant' });
      viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
    })()`;
    await waitFor(`!(${jumpButton})`);
    await delay(250);
    if (process.env.MILAGRE_SCREENSHOT_DIR)
      await window.webContents
        .capturePage()
        .then((image) => require("node:fs").writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "desktop-at-bottom.png"), image.toPNG()));
    await evaluate(readEarlier);
    await waitFor(`!!(${jumpButton})`);
    assert.ok(
      await evaluate(
        `(() => { const button = (${jumpButton}); const rect = button.getBoundingClientRect(); return button.textContent.trim() === '' && rect.width === rect.height && getComputedStyle(button).backdropFilter !== 'none'; })()`,
      ),
      "The jump button is a circular glass icon with an accessible label",
    );
    assert.ok(
      await evaluate(`(${jumpButton}).getBoundingClientRect().bottom < document.querySelector('[data-promptbar]').getBoundingClientRect().top`),
      "Go to bottom sits above the composer",
    );
    assert.ok(
      await evaluate(
        `(() => { const button = (${jumpButton}); const rect = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)); })()`,
      ),
      "The jump button receives clicks through the bottom fade",
    );
    await delay(250);
    if (process.env.MILAGRE_SCREENSHOT_DIR)
      await window.webContents
        .capturePage()
        .then((image) => require("node:fs").writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "desktop-scrolled-up.png"), image.toPNG()));
    await evaluate("window.setMessageCount(55)");
    await waitFor("!!document.querySelector('[aria-label=\"Go to assistant message 55 of 55\"]')");
    assert.ok(await evaluate(`${distanceFromBottom} > 56`), "New messages preserve the position while reading earlier messages");
    await evaluate(`(${jumpButton}).click()`);
    await waitFor(`${distanceFromBottom} <= 1 && !(${jumpButton})`);
    await evaluate("window.setMessageCount(60)");
    await waitFor(`!!document.querySelector('[aria-label="Go to assistant message 60 of 60"]') && ${distanceFromBottom} <= 1 && !(${jumpButton})`);
    await evaluate(readEarlier);
    await waitFor(`!!(${jumpButton})`);
    await evaluate(`document.querySelector('[aria-label="Conversation"]').scrollTo({ top: 1e9, behavior: 'instant' })`);
    await waitFor(`!(${jumpButton})`);
    await evaluate("window.setMessageCount(1)");
    await waitFor('document.querySelectorAll("[data-slot=preview-rail-item]").length === 0');
    assert.equal(await evaluate(`!!(${jumpButton})`), false, "Short chats have no jump button");
    await evaluate("window.setMessageCount(50)");
    await waitFor('document.querySelectorAll("[data-slot=preview-rail-item]").length === 15');
    for (const [id, count] of [
      [2, 200],
      [1, 50],
      [3, 50],
    ]) {
      // Leaving an older chat scrolled up must not disable following in the next.
      await evaluate(`(() => {
        const viewport = document.querySelector('[aria-label="Conversation"]');
        viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
        viewport.scrollTo({ top: 0, behavior: 'instant' });
        viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
      })()`);
      const distance = await evaluate(`(() => {
        window.switchChat(${id}, ${count});
        const viewport = document.querySelector('[aria-label="Conversation"]');
        return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
      })()`);
      assert.ok(distance <= 1, `Chat ${id} must open at the bottom before paint; distance: ${distance}`);
      assert.equal(await evaluate(`!!(${jumpButton})`), false, "A newly opened Chat does not inherit the jump button");
      // Messages measure themselves after the first paint; the opened Chat must not visibly scroll while they do.
      const positions = await evaluate(`new Promise(resolve => {
        const viewport = document.querySelector('[aria-label="Conversation"]');
        const seen = [];
        const started = performance.now();
        const sample = () => {
          seen.push([Math.round(viewport.scrollTop), Math.round(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop)]);
          if (performance.now() - started < 800) requestAnimationFrame(sample); else resolve(seen);
        };
        requestAnimationFrame(sample);
      })`);
      const tops = positions.map(([top]) => top);
      assert.ok(
        Math.max(...tops) - Math.min(...tops) <= 1 && positions.at(-1)[1] <= 1,
        `Chat ${id} must stay at the bottom without scrolling after it opens; positions: ${JSON.stringify(positions.filter((item, index) => !index || item[0] !== positions[index - 1][0]))}`,
      );
    }
    await waitFor('document.querySelectorAll("[data-slot=preview-rail-item]").length === 15');
    // Return to a parked Chat before its message page arrives, then fill it in place.
    await evaluate("window.setLoading(true); window.switchChat(900, 0)");
    await waitFor('document.querySelector(".chat-loading[role=status]")');
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      // Past the mark's delayed fade-in and the legs' intro.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      require("node:fs").writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "chat-loading.png"), (await window.webContents.capturePage()).toPNG());
    }
    await evaluate("window.failLoad()");
    await waitFor('document.querySelector("[role=alert]")?.textContent.includes("Read interrupted")');
    if (process.env.MILAGRE_SCREENSHOT_DIR)
      require("node:fs").writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "chat-load-error.png"), (await window.webContents.capturePage()).toPNG());
    await evaluate('document.querySelector("[role=alert] button").click()');
    await waitFor('document.querySelectorAll("[data-slot=message]").length === 100');
    await evaluate("window.setLoading(true); window.switchChat(901, 80); window.switchChat(900, 0)");
    await evaluate("window.switchChat(900, 100); window.setLoading(false)");
    await waitFor('document.querySelectorAll("[data-slot=message]").length === 100');
    await waitFor(`${distanceFromBottom} <= 1`);
    await evaluate("window.showImageChat(true)");
    await waitFor('document.querySelectorAll("article img").length === 50 && [...document.querySelectorAll("article img")].every(image => image.complete)');
    await waitFor(`${distanceFromBottom} <= 1`);
    await evaluate(readEarlier);
    await waitFor(`!!(${jumpButton})`);
    if (process.env.MILAGRE_SCREENSHOT_DIR)
      await window.webContents
        .capturePage()
        .then((image) => require("node:fs").writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "desktop-50-images-scrolled-up.png"), image.toPNG()));
    await evaluate(`(${jumpButton}).click()`);
    await delay(360);
    await evaluate("window.resizeLastImage(1400)");
    await waitFor('document.querySelector("article:last-child img").naturalHeight === 1400');
    await delay(1200);
    assert.ok(await evaluate(`${distanceFromBottom} <= 1`), "An image-heavy Chat reaches the actual bottom when images resize during a long jump");
    if (process.env.MILAGRE_SCREENSHOT_DIR)
      await window.webContents
        .capturePage()
        .then((image) => require("node:fs").writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "desktop-50-images-at-bottom.png"), image.toPNG()));
    await evaluate("window.resizeLastImage(2000)");
    await waitFor(`${distanceFromBottom} <= 1 && document.querySelector("article:last-child img").naturalHeight === 2000`);
    await evaluate(`document.querySelector('[aria-label="Conversation"]').style.width = 'calc(100% - 1px)'`);
    const imageGeometry = `(() => { const v = document.querySelector('[aria-label="Conversation"]'); return [v.clientWidth, v.clientHeight, v.scrollHeight, v.scrollTop]; })()`;
    await settleGeometry(imageGeometry);
    await evaluate(`document.querySelector('article').scrollIntoView({ block: 'center', behavior: 'instant' })`);
    await waitFor(`${distanceFromBottom} > 1000`);
    await settleGeometry(imageGeometry);
    await evaluate("window.resizeLastImage(2200)");
    await waitFor('document.querySelector("article:last-child img").naturalHeight === 2200');
    await delay(800);
    assert.ok(await evaluate(`${distanceFromBottom} > 1000`), "Find navigation preserves the reading position after an already-settled resize correction");
    await evaluate(readEarlier);
    await waitFor(`!!(${jumpButton})`);
    await evaluate("window.resizeLastImage(2400)");
    await waitFor('document.querySelector("article:last-child img").naturalHeight === 2400');
    await delay(800);
    assert.ok(await evaluate(`${distanceFromBottom} > 1000`), "Image loading preserves the position after scrolling up");
    await evaluate("window.showImageChat(false)");
    await waitFor('!!document.querySelector("[data-promptbar]")');
    const resolveButton = `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Resolve conflicts')`;
    assert.equal(await evaluate(`!!(${resolveButton})`), false);
    await evaluate('window.setPrAction({ label: "Resolve conflicts", tone: "red" })');
    await waitFor(`!!(${resolveButton})`);
    assert.ok(
      await evaluate(`(${resolveButton}).getBoundingClientRect().bottom <= document.querySelector('[data-promptbar]').getBoundingClientRect().top`),
      "Conflict pill sits above the composer",
    );
    await evaluate(`(${resolveButton}).click()`);
    assert.equal(await evaluate("window.resolveClicks"), 1);
    await evaluate("window.setSending(true)");
    await waitFor(`(${resolveButton}).disabled`);
    await evaluate(`(${resolveButton}).click()`);
    assert.equal(await evaluate("window.resolveClicks"), 1, "A running turn disables the conflict action");
    await evaluate("window.setSending(false)");
    await waitFor(`!(${resolveButton}).disabled`);
    await delay(250);
    if (process.env.MILAGRE_SCREENSHOT_DIR)
      await window.webContents
        .capturePage()
        .then((image) => require("node:fs").writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "conflict-pill.png"), image.toPNG()));
    await evaluate(`window.setExtraMessages([{ id: 999999, session_id: 1, role: "user", body: "Fix CI on pull request #77",
      context: { kind: "pr-action", action: "checks-failed", pr: 77, url: "https://github.com/the-ptf/milagre-ade/pull/77" } }])`);
    await waitFor('!!document.querySelector("[data-slot=pr-action][data-action=checks-failed]")');
    assert.ok(await evaluate('document.querySelector("[data-slot=pr-action]").textContent.includes("Fix CI")'));
    assert.equal(await evaluate('document.querySelector("[data-slot=pr-action] a").getAttribute("href")'), "https://github.com/the-ptf/milagre-ade/pull/77");
    assert.equal(
      await evaluate('[...document.querySelectorAll("[data-slot=message] .bg-field")].some((el) => el.textContent.includes("pull request #77"))'),
      false,
      "A PR action renders as a card, not a bubble",
    );
    assert.equal(
      await evaluate('document.querySelector("[data-slot=pr-action]").closest("[data-slot=message]").dataset.linked'),
      undefined,
      "A PR action is the user's own message, not one from a Link",
    );
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      await evaluate('document.querySelector("[data-slot=pr-action]").scrollIntoView({ block: "center" })');
      await delay(250);
      const shot = await window.webContents.capturePage();
      require("node:fs").mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
      require("node:fs").writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "desktop-card.png"), shot.toPNG());
    }
    // A Chat started from a Linear issue shows the issue as a card, with the typed note under it.
    const issueUrl = "https://linear.app/arketa/issue/BIZ-709/home-tab-and-analytics";
    await evaluate(`window.setExtraMessages([{ id: 999998, session_id: 1, role: "user",
      body: "Work on Linear issue BIZ-709: Home tab & analytics: formatting, comparison clarity, drill-downs, report links\\n\\n## Items\\n\\n- [ ] Long class names wrap\\n\\n${issueUrl}\\n\\nStart with the Revenue by Class row",
      context: { kind: "linear-issue", key: "BIZ-709", title: "Home tab & analytics: formatting, comparison clarity, drill-downs, report links",
        url: "${issueUrl}", state: { name: "In Progress", type: "started", color: "#f2c94c" }, workspace: "arketa", note: "Start with the Revenue by Class row" } }])`);
    await waitFor('!!document.querySelector("[data-slot=linear-issue][data-key=BIZ-709]")');
    assert.ok(await evaluate('document.querySelector("[data-slot=linear-issue]").textContent.includes("In Progress")'));
    assert.equal(await evaluate('document.querySelector("[data-slot=linear-issue] a").getAttribute("href")'), issueUrl);
    assert.ok(await evaluate('!!document.querySelector("[data-slot=linear-issue] a [data-linear-logo]")'), "the card shows Linear's mark");
    assert.ok(
      await evaluate('document.querySelector("[data-slot=linear-issue] p").textContent === "Start with the Revenue by Class row"'),
      "the typed note sits under the card",
    );
    assert.equal(
      await evaluate('[...document.querySelectorAll("[data-slot=message]")].some((el) => el.textContent.includes("## Items"))'),
      false,
      "the issue renders as a card, not as the prompt text",
    );
    assert.equal(await evaluate('document.querySelector("[data-slot=linear-issue]").closest("[data-slot=message]").dataset.linked'), undefined);
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      await evaluate('document.querySelector("[data-slot=linear-issue]").scrollIntoView({ block: "center" })');
      await delay(250);
      require("node:fs").writeFileSync(
        path.join(process.env.MILAGRE_SCREENSHOT_DIR, "desktop-linear-issue-card.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
    }
    // The rail checks below count every message.
    await evaluate("window.setExtraMessages([])");
    const updateButton = `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Update branch')`;
    await evaluate('window.setPrAction({ label: "Update branch", tone: "orange" })');
    await waitFor(`!!(${updateButton})`);
    assert.ok(await evaluate(`(${updateButton}).className.includes("text-orange-ink")`), "An outdated branch uses the orange pill");
    await evaluate(`(${updateButton}).click()`);
    assert.equal(await evaluate("window.resolveClicks"), 2);
    await delay(250);
    if (process.env.MILAGRE_SCREENSHOT_DIR)
      await window.webContents
        .capturePage()
        .then((image) =>
          require("node:fs").writeFileSync(require("node:path").join(process.env.MILAGRE_SCREENSHOT_DIR, "pill-update-branch.png"), image.toPNG()),
        );
    await evaluate('window.setPrAction({ label: "Address review", tone: "red" })');
    await waitFor(`[...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Address review')`);
    await delay(250);
    if (process.env.MILAGRE_SCREENSHOT_DIR)
      await window.webContents
        .capturePage()
        .then((image) =>
          require("node:fs").writeFileSync(require("node:path").join(process.env.MILAGRE_SCREENSHOT_DIR, "pill-address-review.png"), image.toPNG()),
        );
    await evaluate("window.setPrAction(null)");
    await waitFor(`!document.querySelector('[data-slot="pr-action"]')`);
    const previewGeometry = `['[aria-label="Conversation"]', '[data-slot="preview-rail-card"]', '[data-promptbar]'].map(selector => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect ? [rect.top, rect.bottom, rect.left, rect.right] : null;
    })`;
    for (const [height, count, draft] of [
      [600, 200, ""],
      [360, 50, ""],
      [360, 50, "A multiline prompt\nthat expands the composer"],
      [600, 18, ""],
      [600, 15, ""],
      [600, 14, ""],
    ]) {
      window.setContentSize(800, height);
      await waitFor(`innerWidth === 800 && innerHeight === ${height}`);
      await evaluate(`window.setMessageCount(${count})`);
      await evaluate(`window.setDraft(${JSON.stringify(draft)})`);
      await waitFor(`document.querySelector('[data-prompt-editor]').value === ${JSON.stringify(draft)}`);
      await waitFor(`document.querySelectorAll("[data-slot=preview-rail-item]").length === ${Math.min(count, 15)}`);
      await waitFor(`document.querySelector('[data-slot="preview-rail-item"]')?.getAttribute('aria-label') === 'Go to assistant message 1 of ${count}'`);
      const labels = await evaluate(`[...document.querySelectorAll('[data-slot="preview-rail-item"]')].map(button => button.getAttribute('aria-label'))`);
      assert.equal(labels[0], `Go to assistant message 1 of ${count}`, "The first message stays reachable");
      assert.equal(labels.at(-1), `Go to assistant message ${count} of ${count}`, "The latest message stays reachable");
      await settleGeometry(previewGeometry);
      // Switch directly between ends as well: a still-mounted previous card must not satisfy the next check.
      for (const edge of ["first", "last", "first"]) {
        const target = await evaluate(`(() => {
          const viewport = document.querySelector('[aria-label="Conversation"]').getBoundingClientRect();
          const buttons = [...document.querySelectorAll('[data-slot="preview-rail-item"]')];
          const button = buttons.filter(node => {
            const rect = node.getBoundingClientRect();
            return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
          }).at(${edge === "first" ? 0 : -1});
          if (!button) throw new Error('No visible navigation item');
          button.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
          return button.getAttribute('aria-label');
        })()`);
        const number = target.match(/message (\d+) of/)[1];
        await waitFor(`document.querySelector('[data-slot="preview-rail-title"]')?.textContent.startsWith('Reply ${number}.')`);
        await settleGeometry(previewGeometry);
        const geometry = await evaluate(`(() => {
          const rect = selector => {
            const { top, bottom, left, right } = document.querySelector(selector).getBoundingClientRect();
            return { top, bottom, left, right };
          };
          const rail = document.querySelector('[aria-label="Message navigation"]');
          const rows = [...rail.children].map(node => node.getBoundingClientRect());
          return { viewport: rect('[aria-label="Conversation"]'), preview: rect('[data-slot="preview-rail-card"]'), prompt: rect('[data-promptbar]'), railTop: Math.min(...rows.map(row => row.top)), railBottom: Math.max(...rows.map(row => row.bottom)) };
        })()`);
        console.log(JSON.stringify({ height, count, target, ...geometry }));
        if (process.env.MILAGRE_SCREENSHOT_DIR)
          require("node:fs").writeFileSync(
            path.join(process.env.MILAGRE_SCREENSHOT_DIR, `preview-${height}-${count}-${draft ? "multiline" : "empty"}-${edge}.png`),
            (await window.webContents.capturePage()).toPNG(),
          );
        assert.ok(geometry.preview.bottom <= geometry.prompt.top, "Message preview overlaps the prompt");
        assert.ok(
          geometry.preview.top >= geometry.viewport.top && geometry.preview.bottom <= geometry.viewport.bottom,
          "Message preview escapes the conversation viewport",
        );
        assert.ok(
          geometry.railTop >= geometry.viewport.top && geometry.railBottom <= geometry.viewport.bottom,
          "Navigation items escape the conversation viewport",
        );
      }
      await evaluate(
        `document.querySelector('[aria-label="Message navigation"]').dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body }))`,
      );
      await waitFor('!document.querySelector("[data-slot=preview-rail-card]")');
    }
    await evaluate('window.setModel("claude-opus-5-5")');
    await evaluate('window.setDraft("")');
    // Fast mode lives in the model picker; the composer's trigger shows a bolt while it is on.
    const fast = '[data-model-picker] [aria-label="Fast mode"]';
    const trigger = "[data-promptbar] button[aria-expanded]:not([aria-label])";
    await evaluate(`document.querySelector('${trigger}').click()`);
    await waitFor(`!!document.querySelector('${fast}')`);
    assert.equal(await evaluate(`document.querySelector('${fast}').getAttribute("aria-checked")`), "false");
    assert.equal(await evaluate(`!!document.querySelector('${trigger} [data-fast-mode]')`), false);
    await evaluate(`document.querySelector('${fast}').click()`);
    await waitFor(`document.querySelector('${fast}').getAttribute("aria-checked") === "true"`);
    await waitFor(`!!document.querySelector('${trigger} [data-fast-mode]')`);
    const pickerShot = async (name) => {
      if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
      // Past the picker's 180 ms pop-in.
      await delay(400);
      const image = await window.webContents.capturePage();
      require("node:fs").writeFileSync(require("node:path").join(process.env.MILAGRE_SCREENSHOT_DIR, `${name}.png`), image.toPNG());
    };
    await pickerShot("model-picker-fast");
    // Ultracode turns its row and the composer purple; the Fatality overlay stays off until Settings > Experimental.
    const ultracode = '[data-model-picker] [aria-label="Ultracode"]';
    await evaluate(`document.querySelector('${ultracode}').click()`);
    await waitFor(`document.querySelector('${ultracode}').getAttribute("aria-checked") === "true"`);
    await waitFor(`!!document.querySelector('[data-promptbar] [data-ultracode]')`);
    assert.equal(await evaluate(`!!document.querySelector('[data-ultracode-fatality]')`), false);
    await pickerShot("model-picker-ultracode");
    await evaluate(`document.querySelector('${ultracode}').click()`);
    await waitFor(`!document.querySelector('[data-promptbar] [data-ultracode]')`);
    await evaluate(`document.querySelector('${trigger}').click()`);
    await waitFor(`!document.querySelector('[data-model-picker]')`);
    await evaluate('window.setDraft("short")');
    await waitFor('document.querySelector("[data-prompt-editor]").value === "short"');
    const compactTop = await evaluate('document.querySelector("[data-prompt-editor]").getBoundingClientRect().top');
    await evaluate(`window.setDraft(${JSON.stringify("A longer prompt ".repeat(50))})`);
    await waitFor('document.querySelector("[data-prompt-editor]").getBoundingClientRect().top < ' + compactTop);
    await evaluate('window.setDraft("")');
    await waitFor('document.querySelector("[data-prompt-editor]").getBoundingClientRect().top === ' + compactTop);
    await evaluate('window.setModel("claude-sonnet-5-5")');
    await waitFor(`!document.querySelector('${trigger} [data-fast-mode]')`);
    await evaluate(`document.querySelector('${trigger}').click()`);
    await waitFor(`!!document.querySelector('[data-model-picker]') && !document.querySelector('${fast}')`);
    // Codex models have it too (the priority tier); the toggle keeps its state across models.
    await evaluate('window.setModel("gpt-6.1-sol")');
    await waitFor(`document.querySelector('${fast}')?.getAttribute("aria-checked") === "true"`);
    if (process.env.MILAGRE_SCREENSHOT_DIR)
      await window.webContents
        .capturePage()
        .then((image) => require("node:fs").writeFileSync(require("node:path").join(process.env.MILAGRE_SCREENSHOT_DIR, "codex-fast-mode.png"), image.toPNG()));
    await evaluate('window.setModel("claude-fable-5-1")');
    await waitFor(`!document.querySelector('${fast}')`);
    await evaluate(`document.querySelector('${trigger}').click()`);
    await waitFor(`!document.querySelector('[data-model-picker]')`);
    await evaluate('window.setModel("claude-sonnet-5-5")');
    // A composer narrow enough that the empty prompt's placeholder wraps must not flip between layouts forever.
    window.webContents.setZoomFactor(3);
    await delay(250);
    await evaluate('window.setDraft("x")');
    await evaluate('window.setDraft("")');
    await delay(500);
    window.webContents.setZoomFactor(1);
    await delay(250);
    assert.ok(!consoleErrors.some((message) => message.includes("Maximum update depth")), "A narrow composer with an empty draft settles");
    assert.equal(await evaluate('document.querySelector("[data-prompt-editor]").getBoundingClientRect().top'), compactTop, "The empty prompt is compact again");
    console.log("PASS: long chats open at the bottom before paint and stay there while messages measure, including after reading older messages");
    console.log("PASS: Go to bottom appears while reading earlier messages, hides at the bottom, and resumes following new messages");
    console.log("PASS: PR action pill placement, click action, disabled state, tones, and removal");
    console.log("PASS: fast mode appears for Codex models and the Opus models that have it, the prompt expands on wrapping, and a narrow empty prompt settles");
    console.log("PASS: message previews stay inside the conversation and above the prompt");
    console.log("PASS: navigation stays capped at 15 lines across the full Chat");
    // Project and Link fallback warnings share one stack, even while a connection banner is present.
    await evaluate(`window.setSaveScopes([
      { scope: "/project", name: "Project", failure: { error: "disk full", code: "ENOSPC", saving: false }, offline: false },
      { scope: "milagre-link:11111111-1111-4111-8111-111111111111", name: "Shared Chats", failure: { error: "denied", code: "EACCES", saving: false }, offline: true }
    ]); window.setDisconnected(true);`);
    await waitFor(`document.querySelectorAll('[data-save-failure]').length === 2`);
    assert.ok(
      await evaluate(
        `(() => { const rows = [...document.querySelectorAll('[data-save-connection], [data-save-failure]')].map(e => e.getBoundingClientRect()); return rows[0].bottom <= rows[1].top && rows[1].bottom <= rows[2].top; })()`,
      ),
      "Connection, Project and Link warnings never overlap",
    );
    assert.equal(await evaluate(`document.querySelectorAll('[data-save-failure] [data-notice-dismiss]').length`), 0);
    assert.equal(await evaluate(`document.querySelectorAll('[data-save-failure] button')[1].disabled`), true, "Offline saving is disabled");
    await evaluate(`document.querySelector('[data-save-failure] button').click()`);
    await waitFor(
      `document.querySelector('[data-save-failure] button').disabled && document.querySelector('[data-save-failure]').textContent.includes('Saving...')`,
    );
    await evaluate(`window.finishSave(); window.setSaveScopes([]); window.setDisconnected(false);`);
    await waitFor(`!document.querySelector('[data-save-failure]')`);
    console.log(
      "PASS: simultaneous Project/Link save warnings and disconnection stack without overlap; retry stays pending, offline retry is disabled, and confirmed recovery removes notices",
    );
    // Both short and long Chats must survive the Activity lifecycle used by Project/Link workspaces.
    for (const count of [2, 80, 4, 0, 6]) {
      await evaluate("window.showWorkspace(false)");
      await delay(50);
      await evaluate(`window.switchChat(${10000}+${count}, ${count}); window.setLoading(${count === 0})`);
      await evaluate("window.showWorkspace(true)");
      if (count > 0) {
        await waitFor(`document.querySelectorAll('[data-slot="message"]').length === ${count}`);
        const height = await evaluate(`document.querySelector('[aria-label="Conversation"]').getBoundingClientRect().height`);
        assert.ok(height > 100, "Restoring a workspace must attach its visible transcript");
      } else await waitFor('document.querySelector(".chat-loading[role=status]")');
    }
    console.log("PASS: short and long Chats survive hidden workspace updates and restoration");
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (process.env.MILAGRE_SCREENSHOT_DIR)
      await Promise.race([
        window.webContents
          .capturePage()
          .then((image) => require("node:fs").writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "chat-layout-failure.png"), image.toPNG())),
        delay(2000),
      ]).catch(() => {}); // Diagnostics must never prevent the failed check from exiting.
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "chat-layout-fixture",
        resolveId(id) {
          if (id === "/__chat_layout_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__chat_layout_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__chat_layout__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__chat_layout_fixture.tsx"></script></body></html>',
            );
            response.setHeader("Content-Type", "text/html");
            response.end(html);
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__chat_layout__`], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}

(process.versions.electron ? browserChecks() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
