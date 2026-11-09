const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const capture = Boolean(process.env.MILAGRE_SCREENSHOT_DIR);
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QuestionCard } from "/src/components/agents/QuestionCard";
import { AnswerCard } from "/src/components/agents/AnswerCard";
import { answeredQuestions } from "@milagre/shared/agent-runs";
import "/src/styles.css";
const option = (label, description) => ({ label, description });
let request = { requestId: "q-1", questions: [
  { id: "review", header: "Review", question: "How should the review step work?", options: [option("Brief in composer", "Nothing runs until you press Send."), option("Review card", "Edit, Send and Cancel in a card.")], multiSelect: false, allowOther: true, secret: false },
  { id: "parts", header: "Parts", question: "Which parts should the brief cover?", options: [option("Goal"), option("Files"), option("Open questions")], multiSelect: true, allowOther: true, secret: false },
  { id: "placement", header: "Placement", question: "Where does the handover row go?", options: [option("Top of the picker"), option("Bottom of the picker")], multiSelect: false, allowOther: true, secret: false },
] };
function Fixture() {
  const [sent, setSent] = useState(undefined);
  window.sent = () => sent;
  const answered = sent ? answeredQuestions(request, sent) : null;
  // Once sent, the chat shows the answers as a card, as the user's message.
  return <div style={{ width: 620, padding: 12 }}>
    {answered ? <div style={{ display: "flex", justifyContent: "flex-end", paddingLeft: 48 }}><AnswerCard answered={answered} /></div>
      : <QuestionCard request={request} waiting={0} answering={sent === undefined ? null : sent ? "answered" : "dismissed"} onAnswer={setSent} />}
  </div>;
}
document.documentElement.classList.add("dark");
document.body.style.cssText = "margin:0;background:#202123";
const root = createRoot(document.getElementById("root"));
root.render(<Fixture />);
window.secret = (remaining = 300000) => {
  request = { requestId: "milagre-secret-test", secretRequest: { description: "A test token for deployment.", expiresAt: Date.now() + remaining }, questions: [{ id: "secret", header: "Secret", question: "Service token", options: [], multiSelect: false, allowOther: true, secret: true }] };
  root.render(<Fixture key={Math.random()} />);
};
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const win = new BrowserWindow({
    width: 660,
    height: 640,
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(20);
    }
    throw Error(`Timed out: ${source}`);
  }
  async function shot(name) {
    if (!capture) return;
    // Let the card's entrance and the tab swap settle.
    await delay(600);
    const fs = require("node:fs/promises");
    await fs.mkdir(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  }
  try {
    await win.loadURL(process.argv[2]);
    await waitFor("!!window.sent");
    const activeTab = 'document.querySelector("[role=tab][aria-selected=true]").textContent';
    const option = (label) =>
      `[...document.querySelectorAll("[role=radio],[role=checkbox]")].find((node) => node.textContent.includes(${JSON.stringify(label)}))`;
    const primary = '[...document.querySelectorAll("button")].find((node) => /^(Next|Send answers?)$/.test(node.textContent.trim()))';
    assert.equal(await evaluate(activeTab), "Review");
    await shot("1-first-question");
    // A single-choice pick moves on to the next question without Next.
    await evaluate(`${option("Brief in composer")}.click()`);
    await waitFor(`${JSON.stringify("Parts")} === ${activeTab}.trim()`);
    assert.equal(await evaluate("document.activeElement.getAttribute('role')"), "checkbox");
    await shot("2-moved-on-after-pick");
    // A multi-select question still waits for Next.
    await evaluate(`${option("Goal")}.click()`);
    await delay(100);
    assert.equal((await evaluate(activeTab)).trim(), "Parts");
    await evaluate(`${primary}.click()`);
    await waitFor(`${JSON.stringify("Placement")} === ${activeTab}.trim()`);
    // The last question stays put after a pick, so the answers get a look before Send.
    await evaluate(`${option("Top of the picker")}.click()`);
    await delay(100);
    assert.equal((await evaluate(activeTab)).trim(), "Placement");
    assert.equal(await evaluate("window.sent()"), undefined);
    assert.equal(await evaluate(`${primary}.textContent.trim()`), "Send answers");
    await shot("3-last-question-waits-for-send");
    // Going back and changing an earlier pick moves on again.
    await evaluate('document.querySelector("[role=tab]").click()');
    await waitFor(`${JSON.stringify("Review")} === ${activeTab}.trim()`);
    await evaluate(`${option("Review card")}.click()`);
    await waitFor(`${JSON.stringify("Parts")} === ${activeTab}.trim()`);
    await evaluate('document.querySelectorAll("[role=tab]")[2].click()');
    await waitFor(`${JSON.stringify("Placement")} === ${activeTab}.trim()`);
    await evaluate(`${primary}.click()`);
    await waitFor("window.sent() !== undefined");
    assert.deepEqual(await evaluate("window.sent()"), {
      review: ["Review card"],
      parts: ["Goal"],
      placement: ["Top of the picker"],
    });
    // The answers show as a card: each question with what was answered.
    await waitFor('!!document.querySelector("[data-slot=answer-card]")');
    const rows = await evaluate(
      '[...document.querySelectorAll("[data-slot=answer-card-row]")].map((row) => [...row.children].map((part) => part.textContent))',
    );
    assert.deepEqual(rows, [
      ["How should the review step work?", "Review card"],
      ["Which parts should the brief cover?", "Goal"],
      ["Where does the handover row go?", "Top of the picker"],
    ]);
    assert.match(await evaluate('document.querySelector("[data-slot=answer-card]").textContent'), /Answered 3 questions/);
    await shot("4-answer-card");
    await evaluate("window.secret()");
    await waitFor('!!document.querySelector("input[type=password]")');
    assert.equal(await evaluate('document.querySelector("button[type=submit]").disabled'), true);
    await evaluate(`(() => {
      const input = document.querySelector('input[type=password]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '  disposable-test-token  ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor('!document.querySelector("button[type=submit]").disabled');
    assert.match(await evaluate("document.body.textContent"), /Save securely/);
    assert.ok(!(await evaluate("document.body.textContent")).includes("disposable-test-token"));
    assert.match(await evaluate("document.querySelector('[role=timer]').textContent"), /[45]:\d{2} left to enter/);
    await evaluate(`document.querySelector('[aria-label="Show secret"]').click()`);
    assert.equal(await evaluate("document.querySelector('input').type"), "text");
    await evaluate(`document.querySelector('[aria-label="Hide secret"]').click()`);
    assert.equal(await evaluate("document.querySelector('input').type"), "password");
    await shot("5-secret-masked");
    await evaluate('document.querySelector("button[type=submit]").click()');
    await waitFor("window.sent() !== undefined");
    assert.deepEqual(await evaluate("window.sent()"), {
      secret: ["  disposable-test-token  "],
    });
    await evaluate("window.secret()");
    await waitFor('!!document.querySelector("input[type=password]")');
    assert.equal(await evaluate('document.querySelector("input").value'), "");
    await evaluate('[...document.querySelectorAll("button")].find(b => b.textContent === "Decline").click()');
    await waitFor("window.sent() === null");
    // The last minute reads in the attention tone.
    await evaluate("window.secret(45000)");
    await waitFor("document.querySelector('[role=timer]')?.className.includes('text-orange-ink')");
    await shot("6-secret-last-minute");
    await evaluate('[...document.querySelectorAll("button")].find(b => b.textContent === "Decline").click()');
    await waitFor("window.sent() === null");
    await evaluate("window.secret(1100)");
    await waitFor('!!document.querySelector("input[type=password]")');
    await evaluate(`(() => {
      const input = document.querySelector('input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'expires-unsent');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor("document.querySelector('[role=timer]').textContent.includes('Request expired')");
    assert.equal(await evaluate("document.querySelector('input').value"), "");
    assert.equal(await evaluate("document.querySelector('button[type=submit]').disabled"), true);
    assert.equal(await evaluate("window.sent()"), undefined);
    await shot("7-secret-expired");
    console.log("Question card checks passed.");
    app.exit(0);
  } catch (error) {
    console.error(error);
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
        name: "question-fixture",
        resolveId(id) {
          if (id === "/__question_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__question_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__question__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__question_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__question__`], { env, stdio: "inherit" });
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
