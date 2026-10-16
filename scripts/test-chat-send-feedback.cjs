// The real App, with worktree creation and message persistence held at the IPC boundary.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = require("./fixtures/chat-send-feedback.cjs");

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-chat-send-feedback-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1100, height: 760, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  const consoleErrors = [];
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") {
      consoleErrors.push(event.message);
      console.error(event.message);
    }
  });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function waitFor(source, tries = 200) {
    for (let i = 0; i < tries; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  async function screenshot(name) {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    await delay(400);
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  const prompt = 'textarea[aria-label="Prompt"]';
  const type = (value) =>
    evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(prompt)});
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  async function clickText(text) {
    const expr = `[...document.querySelectorAll('button')].find(el => el.textContent.includes(${JSON.stringify(text)}))`;
    await waitFor(`!!(${expr})`);
    await evaluate(`(${expr}).click()`);
  }
  async function newChat(isolation) {
    await evaluate(`document.querySelector('[aria-label="New chat"]').click()`);
    await waitFor(`!!document.querySelector('[data-new-chat-pickers]')`);
    const current = await evaluate(`document.querySelector('[data-new-chat-pickers]').textContent`);
    if (!current.includes(isolation)) {
      await clickText(isolation === "Local" ? "New worktree" : "Local");
      await clickText(isolation);
    }
  }
  async function send(body) {
    await type(body);
    await waitFor(
      `(document.querySelector('[aria-label="Send"]') && !document.querySelector('[aria-label="Send"]').disabled) || !!document.querySelector('[aria-label="Stop agent"]')`,
    );
    await evaluate(`document.querySelector(${JSON.stringify(prompt)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  }
  const acknowledged = `(document.querySelector('[aria-label="Send"]') && !document.querySelector('[aria-label="Send"]').disabled) || !!document.querySelector('[aria-label="Stop agent"]')`;
  const transcript = `document.querySelector('[aria-label="Conversation"]')`;
  async function immediate(body) {
    await waitFor(`${transcript}?.textContent.includes(${JSON.stringify(body)})`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(prompt)}).value`), "", "submitted draft clears before sending completes");
    assert.equal(await evaluate(`!!document.querySelector('[data-new-chat-pickers]')`), false, "first message opens the conversation layout");
    assert.equal(
      await evaluate(`!!document.querySelector('[role="status"][aria-label^="Working with"]')`),
      true,
      "working feedback appears before the backend completes",
    );
    assert.equal(
      await evaluate(`document.querySelector('[aria-label="Send"]')?.disabled || !!document.querySelector('[aria-label="Stop agent"]')`),
      true,
      "preparation disables Send or keeps the live turn stoppable",
    );
  }
  const occurrences = (body) => evaluate(`(${transcript}?.textContent.match(new RegExp(${JSON.stringify(body)}, 'g')) ?? []).length`);
  try {
    // A chat on an agent that can't steer: its held queue sits above the composer, each message with Send now and Remove.
    await window.loadURL(process.argv[2] + "?queue=1");
    // The first page of the run waits on Vite's cold transforms.
    await waitFor(`[...document.querySelectorAll('aside [data-row]')].some(row => row.textContent.includes('Previous chat'))`, 1200);
    await evaluate(`[...document.querySelectorAll('aside [data-row]')].find(row => row.textContent.includes('Previous chat')).click()`);
    await waitFor(`!!document.querySelector('[data-queued-messages]')`);
    assert.equal(
      await evaluate(`document.querySelector('[data-queued-messages]').textContent.includes('Queued · on hold since the last turn stopped')`),
      true,
      "the queue says Stop held it",
    );
    assert.equal(await evaluate(`document.querySelectorAll('[data-queued-message]').length`), 2);
    assert.equal(await evaluate(`document.querySelector('[data-queued-message="q2"]').textContent.includes('1 file')`), true);
    await waitFor(`${transcript}?.textContent.includes('Previous chat')`);
    assert.equal(await occurrences("Then add tests for the checkout page"), 0, "a queued message is not in the transcript");
    await screenshot("queued-held");
    await evaluate(`document.querySelector('[data-queued-send="q1"]').click()`);
    await waitFor("window.calls.queueSent?.length === 1");
    assert.deepEqual(await evaluate("window.calls.queueSent"), [["/fixture#2", "q1"]]);
    await evaluate(`document.querySelector('[data-queued-remove="q2"]').click()`);
    await waitFor(`document.querySelectorAll('[data-queued-message]').length === 1`);
    assert.deepEqual(await evaluate("window.calls.queueRemoved"), [["/fixture#2", "q2"]]);
    await window.loadURL(process.argv[2]);
    await waitFor(`!!document.querySelector('[aria-label="New chat"]')`);
    await newChat("New worktree");
    await type("Add a checkout page");
    await screenshot("before-send");
    await evaluate(`document.querySelector('[aria-label="Send"]').click()`);
    await waitFor("window.calls.created === 1");
    await immediate("Add a checkout page");
    assert.equal(
      await evaluate(`document.querySelector('aside').textContent.includes('Add a checkout page')`),
      true,
      "the sidebar lists the new Chat before setup",
    );
    assert.equal(await evaluate("window.calls.sent.length"), 0, "feedback does not wait for worktree setup");
    await screenshot("preparing-worktree");
    await evaluate(`[...document.querySelectorAll('aside [data-row]')].find(row => row.textContent.includes('Previous chat')).click()`);
    await waitFor(`${transcript}?.textContent.includes('Previous chat')`);
    await evaluate(`[...document.querySelectorAll('aside [data-row]')].find(row => row.textContent.includes('Add a checkout page')).click()`);
    await waitFor(`${transcript}?.textContent.includes('Add a checkout page')`);
    await type("Next draft");
    await evaluate(`document.querySelector(${JSON.stringify(prompt)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    assert.equal(await evaluate("window.calls.created"), 1);
    await evaluate("window.finishCreate()");
    await waitFor("window.calls.sent.length === 1");
    assert.equal(await occurrences("Add a checkout page"), 1);
    await evaluate(`(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['notes'], 'next.txt', { type: 'text/plain' }));
      document.querySelector(${JSON.stringify(prompt)}).dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    })()`);
    await waitFor(`document.body.textContent.includes('next.txt')`);
    await evaluate("window.saveSend()");
    await delay(100);
    assert.equal(await occurrences("Add a checkout page"), 1, "state arriving before acknowledgement does not duplicate the message");
    assert.equal(
      await evaluate(`[...document.querySelectorAll('aside [data-row]')].filter(row => row.textContent.includes('Add a checkout page')).length`),
      1,
      "canonical input replaces the sidebar preview before acknowledgement",
    );
    await evaluate("window.ackSend()");
    await waitFor(`(${transcript}?.textContent.includes('Add a checkout page')) && (${acknowledged})`);
    assert.equal(await occurrences("Add a checkout page"), 1);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(prompt)}).value`), "Next draft", "acknowledgement keeps text typed during setup");
    assert.equal(await evaluate(`document.body.textContent.includes('next.txt')`), true, "acknowledgement keeps attachments added for the next message");
    await screenshot("sent");

    await newChat("Local");
    await send("Check the local project");
    await waitFor("window.calls.sent.length === 2");
    await immediate("Check the local project");
    assert.equal(await evaluate("window.calls.created"), 1, "Local still uses the selected worktree");
    await evaluate(`window.firstSendTranscript = ${transcript}`);
    await evaluate("window.saveSend(); window.ackSend()");
    await waitFor(acknowledged);
    assert.equal(await occurrences("Check the local project"), 1);
    assert.equal(await evaluate(`window.firstSendTranscript === ${transcript}`), true, "saving a first message keeps the transcript mounted");

    await newChat("New worktree");
    await evaluate(`(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0))], 'note.png', { type: 'image/png' }));
      document.querySelector(${JSON.stringify(prompt)}).dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    })()`);
    await waitFor(`document.body.textContent.includes('note.png')`);
    await send("Keep this draft");
    await immediate("Keep this draft");
    await type("A follow-up note");
    await evaluate("window.failCreate()");
    await waitFor(`document.querySelector('[role="alert"]')?.textContent.includes('Setup failed')`);
    assert.equal(
      await evaluate(`document.querySelector(${JSON.stringify(prompt)}).value`),
      "Keep this draft\n\nA follow-up note",
      "failed setup keeps both the submitted message and text typed while preparing",
    );
    assert.equal(await evaluate(`document.body.textContent.includes('note.png')`), true, "failed setup restores attachments");
    await screenshot("setup-failed");
    await send("Keep this draft");
    await evaluate("window.finishCreate()");
    await waitFor("window.calls.sent.length === 3");
    assert.equal(await evaluate("window.calls.sent[2].images[0].name"), "note.png");
    assert.deepEqual(await evaluate("window.calls.sent[2].files"), ["/fixture/note.png"]);
    await evaluate("window.failSend()");
    await waitFor(`document.querySelector('[role="alert"]')?.textContent.includes('Disk full')`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(prompt)}).value`), "Keep this draft");
    const created = await evaluate("window.calls.created");
    await send("Keep this draft");
    await waitFor("window.calls.sent.length === 4");
    assert.equal(await evaluate("window.calls.created"), created, "retry after persistence failure reuses the prepared worktree");
    await evaluate("window.saveSend(); window.ackSend()");
    await waitFor(acknowledged);

    await newChat("New worktree");
    await send("Continue in the background");
    await immediate("Continue in the background");
    await evaluate(`document.querySelector('[aria-label="New chat"]').click()`);
    await waitFor(`!!document.querySelector('[data-new-chat-pickers]')`);
    await type("A different draft");
    await evaluate("window.finishCreate()");
    await waitFor("window.calls.sent.length === 5");
    await evaluate("window.saveSend(); window.ackSend()");
    await waitFor(
      `document.querySelector('[data-new-chat-pickers]') && (document.querySelector('[aria-label="Send"]') && !document.querySelector('[aria-label="Send"]').disabled)`,
    );
    assert.equal(
      await evaluate(`document.querySelector(${JSON.stringify(prompt)}).value`),
      "A different draft",
      "background completion keeps the selected chat and its draft",
    );
    assert.equal(await evaluate(`${transcript}?.textContent.includes('Continue in the background') ?? false`), false);
    await newChat("New worktree");
    await evaluate(`(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['notes'], 'recovery.txt', { type: 'text/plain' }));
      document.querySelector(${JSON.stringify(prompt)}).dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    })()`);
    await waitFor(`document.body.textContent.includes('recovery.txt')`);
    await send("Recover after leaving");
    await evaluate("window.finishCreate()");
    await waitFor("window.calls.sent.length === 6");
    await evaluate(`document.querySelector('[aria-label="New chat"]').click()`);
    await waitFor(`!!document.querySelector('[data-new-chat-pickers]')`);
    await type("Keep the current draft");
    await evaluate("window.failSend()");
    await waitFor(`(document.querySelector('[aria-label="Send"]') && !document.querySelector('[aria-label="Send"]').disabled)`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(prompt)}).value`), "Keep the current draft");
    const recoverable = await evaluate(
      `[...document.querySelectorAll('aside [data-row]')].find(row => row.textContent.includes('Recover after leaving')) != null`,
    );
    assert.equal(recoverable, true, "background failure keeps the submission recoverable in the sidebar");
    await screenshot("background-failed");
    await send("Another background send");
    await evaluate("window.finishCreate()");
    await waitFor("window.calls.sent.length === 7");
    await evaluate(`[...document.querySelectorAll('aside [data-row]')].find(row => row.textContent.includes('Recover after leaving')).click()`);
    await waitFor(
      `document.querySelector(${JSON.stringify(prompt)}).value.includes('Recover after leaving') && document.body.textContent.includes('recovery.txt')`,
    );
    await screenshot("background-failed-restored");
    await evaluate("window.saveSend(); window.ackSend()");
    await waitFor(acknowledged);
    const beforeRecovery = await evaluate("window.calls.created");
    await send("Recover after leaving");
    await waitFor("window.calls.sent.length === 8");
    assert.equal(await evaluate("window.calls.created"), beforeRecovery, "background failure restores its prepared Worktree for retry");
    await evaluate("window.saveSend(); window.ackSend()");
    await waitFor(acknowledged);

    // Follow-ups must render while persistence is held, just like first messages.
    await evaluate(`[...document.querySelectorAll('aside [data-row]')].find(row => row.textContent.includes('Previous chat')).click()`);
    await waitFor(`${transcript}?.textContent.includes('Previous chat')`);
    await evaluate(`[...document.querySelectorAll('button')].filter(el => el.textContent === 'Dismiss').forEach(el => el.click())`);
    await type("A follow-up message");
    await screenshot("follow-up-before-send");
    await evaluate(`document.querySelector('[aria-label="Send"]').click()`);
    await waitFor("window.calls.sent.length === 9");
    await immediate("A follow-up message");
    assert.equal(await occurrences("Previous chat"), 1, "previous messages stay visible");
    assert.equal(await evaluate("window.calls.sent[8].sessionId"), 2, "follow-up targets the existing Chat");
    assert.equal(
      await evaluate(`document.querySelector('aside').textContent.includes('A follow-up message')`),
      false,
      "follow-up keeps the original Chat title",
    );
    await evaluate(
      `window.followUpArticle = [...document.querySelectorAll('[data-slot="message"]')].find(el => el.textContent.includes('A follow-up message'))`,
    );
    assert.equal(await evaluate(`getComputedStyle(window.followUpArticle).animationName`), "none", "sent input is visible without a fade-in delay");
    await screenshot("follow-up-pending");
    await type("Draft typed while sending");
    await evaluate(`document.querySelector(${JSON.stringify(prompt)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    assert.equal(await evaluate("window.calls.sent.length"), 9, "duplicate follow-up submits are blocked");
    await evaluate(`(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['notes'], 'follow-up.txt', { type: 'text/plain' }));
      document.querySelector(${JSON.stringify(prompt)}).dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    })()`);
    await waitFor(`document.body.textContent.includes('follow-up.txt')`);
    await evaluate("window.saveSend()");
    await delay(100);
    assert.equal(await occurrences("A follow-up message"), 1, "saved follow-up replaces the preview before acknowledgement");
    assert.equal(
      await evaluate(
        `window.followUpArticle === [...document.querySelectorAll('[data-slot="message"]')].find(el => el.textContent.includes('A follow-up message'))`,
      ),
      true,
      "acknowledgement reuses the preview element",
    );
    await evaluate("window.ackSend()");
    await waitFor(acknowledged);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(prompt)}).value`), "Draft typed while sending");
    assert.equal(await evaluate(`document.body.textContent.includes('follow-up.txt')`), true, "acknowledgement keeps the next attachments");

    await evaluate(`window.emitAgent(2, { type: 'text-delta', text: 'Reply still streaming' })`);
    await waitFor(`${transcript}?.textContent.includes('Reply still streaming')`);
    await send("A steering message");
    await waitFor("window.calls.sent.length === 10");
    await immediate("A steering message");
    assert.equal(
      await evaluate(`(() => {
      const articles = [...document.querySelectorAll('[data-slot="message"]')];
      return articles.findIndex(el => el.textContent.includes('Reply still streaming')) < articles.findIndex(el => el.textContent.includes('A steering message'));
    })()`),
      true,
      "pending steering input follows the live reply",
    );
    await screenshot("steering-pending");
    await type("Note typed during a failed send");
    await evaluate("window.failSend()");
    await waitFor(`document.querySelector('[role="alert"]')?.textContent.includes('Disk full')`);
    assert.equal(await occurrences("A steering message"), 0, "failure removes the unsaved preview");
    assert.equal(await occurrences("Reply still streaming"), 1, "failure keeps the live reply");
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(prompt)}).value`), "A steering message\n\nNote typed during a failed send");
    assert.equal(await evaluate(`document.body.textContent.includes('follow-up.txt')`), true, "failure restores submitted attachments");
    await screenshot("follow-up-failed");

    await send("Retry the follow-up");
    await waitFor("window.calls.sent.length === 11");
    await evaluate(`document.querySelector('[aria-label="New chat"]').click()`);
    await waitFor(`!!document.querySelector('[data-new-chat-pickers]')`);
    await type("Keep this other draft");
    await evaluate("window.failSend()");
    await waitFor(`document.querySelector('[aria-label="Send"]') && !document.querySelector('[aria-label="Send"]').disabled`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(prompt)}).value`), "Keep this other draft");
    await evaluate(`[...document.querySelectorAll('aside [data-row]')].find(row => row.textContent.includes('Previous chat')).click()`);
    await waitFor(`document.querySelector(${JSON.stringify(prompt)}).value.includes('Retry the follow-up')`);
    assert.equal(
      await evaluate(`document.body.textContent.includes('follow-up.txt')`),
      true,
      "background failure recovers follow-up attachments in its original Chat",
    );
    await send("Recovered follow-up");
    await waitFor("window.calls.sent.length === 12");
    assert.equal(await evaluate("window.calls.sent[11].sessionId"), 2);
    await evaluate("window.saveSend(); window.ackSend()");
    await waitFor(acknowledged);
    assert.equal(await occurrences("Recovered follow-up"), 1);

    const rows = (body) =>
      evaluate(`[...document.querySelectorAll('aside [data-row]')].filter(row => row.textContent.includes(${JSON.stringify(body)})).length`);
    await newChat("Local");
    await send("Reply before state");
    await waitFor("window.calls.sent.length === 13");
    await evaluate("window.holdState = true; window.saveSend(); window.ackSend()");
    await delay(150);
    assert.equal(await rows("Reply before state"), 1, "the new Chat stays listed while its saved state is on the way");
    assert.equal(await occurrences("Reply before state"), 1, "the message stays on screen while its saved state is on the way");
    await evaluate("window.releaseState()");
    await delay(100);
    assert.equal(await rows("Reply before state"), 1);
    assert.equal(await occurrences("Reply before state"), 1, "the saved message replaces the preview");
    // A Chat summary can arrive before its first message page, including before the send acknowledgement.
    await window.loadURL(process.argv[2] + "?lean=1");
    await waitFor(`!!document.querySelector('[aria-label="New chat"]')`);
    await newChat("Local");
    await send("Keep the first message visible");
    await immediate("Keep the first message visible");
    await evaluate(`window.firstSendTranscript = ${transcript}; window.holdPages = true; window.saveSend()`);
    await waitFor("typeof window.releasePages === 'function'");
    assert.equal(await occurrences("Keep the first message visible"), 1, "summary arrival keeps the input while its page loads");
    await evaluate("window.ackSend()");
    await delay(100);
    assert.equal(await occurrences("Keep the first message visible"), 1, "acknowledgement keeps the input while its page loads");
    assert.equal(await evaluate(`window.firstSendTranscript === ${transcript}`), true);
    await screenshot("first-message-loading");
    await evaluate("window.releasePages()");
    await delay(100);
    assert.equal(await occurrences("Keep the first message visible"), 1);
    assert.equal(await evaluate(`window.firstSendTranscript === ${transcript}`), true);
    await evaluate(`[...document.querySelectorAll('aside [data-row]')].find(row => row.textContent.includes('Previous chat')).click()`);
    await waitFor(`${transcript}?.textContent.includes('Previous chat')`);
    assert.equal(await occurrences("Keep the first message visible"), 0, "another Chat must not inherit the retained transcript");

    // A host that keeps messages by Chat: the newest turns come as a page, and Show earlier reads the next one.
    await window.loadURL(process.argv[2] + "?long=1&lean=1");
    await waitFor(`document.querySelectorAll('[data-slot="message"]').length === 40`);
    assert.equal(await evaluate("window.calls.pages"), 1, "the open Chat reads one page");
    await delay(400);
    assert.equal(await evaluate(`[...document.querySelectorAll("button")].some((button) => button.textContent === "Show earlier messages (260)")`), true);
    await evaluate(
      `(() => { const viewport = document.querySelector('[aria-label="Conversation"]'); viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1000 })); viewport.scrollTop = 0; window.historyAnchor = document.querySelector('[data-slot="message"]'); window.historyTop = window.historyAnchor.getBoundingClientRect().top; viewport.dispatchEvent(new Event('scroll')); viewport.dispatchEvent(new Event('scroll')); })()`,
    );
    await waitFor(`document.querySelectorAll('[data-slot="message"]').length === 80`);
    assert.equal(await evaluate("window.calls.pages"), 2, "scrolling up reads one page from the host");
    assert.equal(await evaluate("window.historyAnchor.isConnected"), true, "the read page keeps mounted messages");
    await delay(150);
    assert.ok(
      await evaluate("Math.abs(window.historyAnchor.getBoundingClientRect().top - window.historyTop) < 16"),
      "automatic history preserves the reading position",
    );
    await screenshot("lean-history");
    for (const busy of [false, true]) {
      await window.loadURL(process.argv[2] + "?long=1");
      await waitFor(`!!document.querySelector('[data-slot="message"]')`);
      assert.equal(await evaluate(`document.querySelectorAll('[data-slot="message"]').length`), 40, "long chats initially mount only the newest page");
      await delay(400);
      await evaluate(
        `(() => { const viewport = document.querySelector('[aria-label="Conversation"]'); viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1000 })); viewport.scrollTop = 0; window.historyAnchor = document.querySelector('[data-slot="message"]'); window.historyTop = window.historyAnchor.getBoundingClientRect().top; viewport.dispatchEvent(new Event('scroll')); })()`,
      );
      await waitFor(`document.querySelectorAll('[data-slot="message"]').length === 80`);
      assert.equal(await evaluate("window.historyAnchor.isConnected"), true, "prepending history retains mounted messages");
      await delay(100);
      const anchorShift = await evaluate("Math.abs(window.historyAnchor.getBoundingClientRect().top - window.historyTop)");
      assert.ok(anchorShift < 16, `prepending history preserves the reading position (moved ${anchorShift}px)`);
      if (busy) {
        await evaluate(`window.emitAgent(2, { type: 'turn-started' }); window.emitAgent(2, { type: 'text-delta', text: 'Ongoing work' })`);
        await waitFor(`document.querySelector('[data-streaming]')?.textContent.includes('Ongoing work')`);
        await evaluate(`window.renderedMessageIds = []; window.emitAgent(2, { type: 'text-delta', text: ' continues' })`);
        await waitFor(`document.querySelector('[data-streaming]')?.textContent.includes('continues')`);
        assert.equal(await evaluate("window.renderedMessageIds.filter(id => id > 0).length"), 0, "streaming leaves the loaded saved message cards memoized");
      }
      await evaluate(`window.emitAgent(99, { type: 'turn-started' }); window.emitAgent(99, { type: 'text-delta', text: 'Other chat' })`);
      // The open chat's own streamed text schedules a trailing 250 ms rail refresh; let it land before counting.
      let railStableSince = Date.now();
      let railSeen = await evaluate("window.railItemsRendered");
      while (Date.now() - railStableSince < 500) {
        await delay(50);
        const now = await evaluate("window.railItemsRendered");
        if (now !== railSeen) {
          railSeen = now;
          railStableSince = Date.now();
        }
      }
      await evaluate("window.transcriptRenders = 0; window.railItemsRendered = 0");
      for (let update = 0; update < 5; update++) {
        await evaluate(`window.emitAgent(99, { type: 'text-delta', text: ' background output' })`);
        await delay(50);
      }
      assert.equal(await evaluate("window.transcriptRenders"), 0, "another running chat does not rebuild the open transcript");
      assert.equal(await evaluate("window.railItemsRendered"), 0, "another running chat does not rebuild the message navigation");
      await evaluate("window.renderedMessageIds = []");
      await send("Follow-up in a long chat");
      await immediate("Follow-up in a long chat");
      assert.equal(await evaluate("window.calls.sent.length"), 1, "long-chat preview appears with persistence still pending");
      assert.equal(
        await evaluate("window.renderedMessageIds.filter(id => id > 0).length"),
        0,
        `sending in a long ${busy ? "working" : "idle"} chat leaves saved cards memoized`,
      );
      await screenshot(busy ? "long-chat-working-follow-up" : "long-chat-idle-follow-up");
      await evaluate("window.saveSend(); window.ackSend()");
      await waitFor(acknowledged);
      assert.equal(await occurrences("Follow-up in a long chat"), 1, "long-chat acknowledgement replaces the preview");
      await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))`);
      await waitFor(`!!document.querySelector('[aria-label="Find in chat"]')`);
      await waitFor(`document.querySelectorAll('[data-slot="message"]:not([data-streaming])').length === 301`);
      await evaluate(`(() => {
        const input = document.querySelector('[aria-label="Find in chat"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Previous chat 0');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await waitFor(`document.body.textContent.includes('1 of 1')`);
      await screenshot("long-chat-search-history");
    }

    assert.deepEqual(consoleErrors, []);
    console.log(
      "PASS: immediate first messages and follow-ups, steering, acknowledgement without remounting, next drafts, attachment recovery, retries, background navigation and memoized long-chat history during sends and streaming",
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    await screenshot("failure").catch(() => {});
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
        name: "chat-send-feedback-fixture",
        enforce: "pre",
        transform(code, id) {
          if (id.split("?")[0].endsWith("/motion/PreviewRail.tsx")) {
            assert.ok(code.includes("const scale = highlighted"));
            return code.replace("const scale = highlighted", "window.railItemsRendered++; const scale = highlighted");
          }
          if (id.split("?")[0].endsWith("/components/ChatComposer.tsx")) {
            // Count real saved-card renders without changing production components or timing assertions.
            assert.ok(code.includes("const linked = linkedContext(message);"));
            assert.ok(code.includes("const transcript = messages.slice(start);"));
            return code
              .replace("const linked = linkedContext(message);", "window.renderedMessageIds.push(message.id); const linked = linkedContext(message);")
              .replace("const transcript = messages.slice(start);", "window.transcriptRenders++; const transcript = messages.slice(start);");
          }
        },
        resolveId(id) {
          if (id === "/__chat_send_feedback_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__chat_send_feedback_fixture.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url.split("?")[0] !== "/__chat_send_feedback__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__chat_send_feedback_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__chat_send_feedback__`], { env, stdio: "inherit" });
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
