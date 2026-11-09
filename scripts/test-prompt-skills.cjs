// Real composer and native textarea editing in Electron. No agent calls.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PromptComposer } from '/src/components/PromptComposer';
import { MODEL_CATALOG, capabilityFor } from '/src/model';
import '/src/styles.css';
const noop = () => {};
window.sent = [];
window.milagre = { listSkills: async root => ({ skills: root === '/other' ? [] : [
  { name: 'tldr', description: 'Rewrite for a skimming reader', scope: 'bundled', provider: 'milagre', path: '/skills/tldr/SKILL.md' },
  ...['milagre','milagre-advisor','milagre-committee','milagre-help'].map(name => ({ name, description: 'Milagre orchestration and help', scope: 'bundled', provider: 'milagre', path: '/skills/' + name + '/SKILL.md' })),
  { name: 'plugin:review-code', description: 'Review code', scope: 'user', provider: 'codex', path: '/skills/review/SKILL.md' },
], warnings: [] }) };
function Fixture() {
  const [draft, setDraft] = useState('');
  const [root, setRoot] = useState('/fixture');
  // A named Link's Chat reads skills through its own scope while its folder stays the Project path.
  const [skillScope, setSkillScope] = useState(undefined);
  window.setSkillScope = setSkillScope;
  const [expanded, setExpanded] = useState(false);
  window.setDraft = setDraft;
  window.setProject = setRoot;
  window.setExpanded = setExpanded;
  const model = MODEL_CATALOG[0];
  return <div style={{ width: '100%', maxWidth: 720, margin: '260px auto' }}>
    <PromptComposer projectPath={root} skillScope={skillScope} draft={draft} onDraftChange={setDraft}
      imageDraft={{ images: [], files: [], loading: false, error: '', onPaste: noop, remove: noop, removeFile: noop }}
      onSend={() => { window.sent.push(draft); setDraft(''); }} sendBlocked={false}
      models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={model} onModelChange={noop}
      capability={capabilityFor(model, null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
      fastMode={false} onFastModeChange={noop} permissionMode="auto" onPermissionModeChange={noop} alwaysExpanded={expanded} />
  </div>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-prompt-skills-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const errors = [];
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  const waitFor = async (source) => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw Error("Timed out: " + source);
  };
  const type = async (text) => {
    await evaluate(
      `(() => { const input = document.querySelector('textarea'); input.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)}); input.setSelectionRange(input.value.length, input.value.length); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
    await delay(100);
  };
  const escape = async () => {
    await evaluate(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
    await delay(100);
  };
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    window.webContents.invalidate();
    await delay(250);
    // The first capture wakes a hidden window's compositor; save the next frame.
    await window.webContents.capturePage();
    await delay(100);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  const highlighted = () => evaluate(`[...document.querySelectorAll('[data-prompt-skill]')].map(el => el.textContent)`);
  const hoverSkill = async (index = 0) => {
    // Let the textarea's ResizeObserver finish after compact/expanded layout changes.
    await delay(100);
    const point = await evaluate(
      `(() => { const rect = document.querySelectorAll('[data-prompt-skill]')[${index}].getClientRects()[0]; return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }; })()`,
    );
    window.webContents.sendInputEvent({ type: "mouseMove", ...point });
    return point;
  };
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!document.querySelector('textarea')`);
    await type("/milagre");
    await waitFor(`document.querySelectorAll('[aria-label="Commands and skills"] button').length === 4`);
    assert.deepEqual(
      await evaluate(`[...document.querySelectorAll('[aria-label="Commands and skills"] button')].map(b => b.querySelector('span')?.textContent).sort()`),
      ["/milagre", "/milagre-advisor", "/milagre-committee", "/milagre-help"],
    );
    await screenshot("milagre-skills-menu");
    await type("run /tldr");
    await waitFor(`document.querySelector('[data-prompt-skill]')?.textContent === '/tldr'`);
    await escape();
    assert.deepEqual(await highlighted(), ["/tldr"], "Highlight survives dismissal of the skill menu");
    await hoverSkill();
    await waitFor(`document.querySelector('[role="tooltip"]')?.textContent.includes('Rewrite for a skimming reader')`);
    assert.ok(await evaluate(`document.querySelector('[role="tooltip"]').textContent.includes('/tldr')`), "Hover identifies the skill");
    await screenshot("skill-hover-light");
    window.webContents.sendInputEvent({ type: "mouseMove", x: 10, y: 10 });
    await waitFor(`!document.querySelector('[role="tooltip"]')`);
    for (const dark of [false, true]) {
      await evaluate(`document.documentElement.classList.toggle('dark', ${dark})`);
      const colors = await evaluate(
        `(() => { const token = document.querySelector('[data-prompt-skill]'); const text = document.querySelector('[data-prompt-highlights] > div'); const input = document.querySelector('textarea'); return { skill: getComputedStyle(token).color, text: getComputedStyle(text).color, caret: getComputedStyle(input).caretColor, input: getComputedStyle(input).color }; })()`,
      );
      assert.notEqual(colors.skill, colors.text, "Skill differs from ordinary text in each theme");
      assert.equal(colors.caret, colors.text, "Caret remains visible");
      assert.equal(colors.input, "rgba(0, 0, 0, 0)", "Only the mirror paints text");
      await screenshot(dark ? "compact-dark" : "compact-light");
    }
    await type("/tl /unknown https://example.com/tldr /tldr/file");
    assert.deepEqual(await highlighted(), []);
    // Restored/pasted drafts must discover skills even when the caret menu stays dismissed.
    await evaluate(`window.setDraft('Use /tldr, then /plugin:review-code please.'); window.setExpanded(true)`);
    await waitFor(`document.querySelectorAll('[data-prompt-skill]').length === 2`);
    await hoverSkill(1);
    await waitFor(`document.querySelector('[role="tooltip"]')?.textContent.includes('Review code')`);
    await screenshot("skill-hover-dark");
    // The textarea must remain the hit target over a skill, preserving caret placement and drag selection.
    assert.equal(
      await evaluate(
        `(() => { const rect = document.querySelectorAll('[data-prompt-skill]')[1].getClientRects()[0]; return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.tagName; })()`,
      ),
      "TEXTAREA",
    );
    const point = await hoverSkill(1);
    window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    await waitFor(`!document.querySelector('[role="tooltip"]')`);
    assert.equal(await evaluate(`document.activeElement?.tagName`), "TEXTAREA");
    await screenshot("expanded-dark");
    await evaluate(`document.documentElement.classList.remove('dark')`);
    await screenshot("expanded-light");
    await type("/tl");
    await waitFor(`!!document.querySelector('[aria-label="Commands and skills"] button')`);
    await evaluate(`document.querySelector('[aria-label="Commands and skills"] button').click()`);
    await waitFor(`document.querySelector('textarea').value === '/tldr '`);
    assert.deepEqual(await highlighted(), ["/tldr"], "Picker selection is highlighted");
    // Real typing and selection stay in the native input.
    await evaluate(`(() => { const input = document.querySelector('textarea'); input.focus(); input.setSelectionRange(1, 5); })()`);
    await window.webContents.insertText("unknown");
    await waitFor(`document.querySelector('textarea').value === '/unknown '`);
    assert.deepEqual(await highlighted(), [], "Editing a name removes stale highlighting");
    const longDraft = Array.from({ length: 20 }, (_, i) => "Line " + i + ": run /tldr and " + "wrapped text ".repeat(9)).join("\n");
    await type(longDraft);
    await escape();
    await window.setSize(530, 500);
    await delay(150);
    assert.deepEqual(await highlighted(), Array(20).fill("/tldr"));
    const geometry = await evaluate(`(() => {
      const input = document.querySelector('textarea'); const viewport = document.querySelector('[data-prompt-highlights]'); const text = viewport.firstElementChild;
      input.scrollTop = 120; input.dispatchEvent(new Event('scroll'));
      return { width: input.clientWidth, mirrorWidth: viewport.clientWidth, height: input.clientHeight, mirrorHeight: viewport.clientHeight, scroll: input.scrollTop, transform: text.style.transform, contentHeight: input.scrollHeight, mirrorContentHeight: text.scrollHeight, x: input.getBoundingClientRect().x, mirrorX: viewport.getBoundingClientRect().x };
    })()`);
    assert.equal(geometry.width, geometry.mirrorWidth, "Wrapped input and mirror have the same width");
    assert.equal(geometry.height, geometry.mirrorHeight);
    assert.equal(geometry.x, geometry.mirrorX);
    assert.ok(Math.abs(geometry.contentHeight - geometry.mirrorContentHeight) <= 1, "Mirror line wrapping matches textarea");
    assert.equal(geometry.transform, "translate(0px, -120px)", "Highlight follows textarea scrolling");
    await evaluate(`document.querySelector('textarea').scrollTop = 0`);
    await delay(100);
    await hoverSkill();
    await waitFor(`!!document.querySelector('[role="tooltip"]')`);
    await evaluate(`(() => { const input = document.querySelector('textarea'); input.scrollTop = 120; input.dispatchEvent(new Event('scroll')); })()`);
    await waitFor(`!document.querySelector('[role="tooltip"]')`);
    await screenshot("wrapped-scrolled");
    await type("run /tldr");
    await escape();
    await evaluate(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
    await waitFor(`document.querySelector('textarea').value === ''`);
    assert.deepEqual(await evaluate("window.sent"), ["run /tldr"], "Sending preserves the exact command text");
    assert.deepEqual(await highlighted(), [], "Sending clears highlighting");
    await type("run /tldr");
    await escape();
    await evaluate(`window.setProject('/other')`);
    await waitFor(`!document.querySelector('[data-prompt-skill]')`);
    // A Link's key brings its skills back though the folder is still /other.
    await evaluate(`window.setSkillScope('milagre-link:40996067-6cc2-4427-bc1e-9007c5f51875')`);
    await waitFor(`!!document.querySelector('[data-prompt-skill]')`);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: typed and picked skills, hover descriptions and dismissal, both themes, native editing, wrapped/scrolled alignment, exact send and catalog isolation",
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    console.error(
      await evaluate(
        `(() => { const input = document.querySelector('textarea'); return { value: input?.value, input: input?.getBoundingClientRect().toJSON(), spans: [...document.querySelectorAll('[data-prompt-skill]')].map(el => ({ text: el.textContent, rect: el.getBoundingClientRect().toJSON() })), tooltip: document.querySelector('[role="tooltip"]')?.textContent }; })()`,
      ),
    );
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-prompt-skills"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "prompt-skills-fixture",
        resolveId(id) {
          if (id === "/__prompt-skills.tsx") return id;
        },
        load(id) {
          if (id === "/__prompt-skills.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__prompt-skills") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__prompt-skills.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__prompt-skills`], {
      env,
      stdio: "inherit",
    });
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
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
