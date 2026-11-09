// Settings > Skills in Electron with a fixed catalog: groups, search and filters, detail, shadowed skills, warnings, Reload.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const { fileManager } = require("@milagre/shared/host-computer");

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsPanel } from '/src/components/Settings';
import { BridgeContext } from '/src/lib/computer-bridge';
import '/src/styles.css';
const skill = (name, scope, provider, description, path) => ({ name, scope, provider, description, path });
window.calls = { list: 0, read: [], open: [], reveal: [] };
window.milagre = {
  listEditors: async () => [{ id: 'cursor', name: 'Cursor' }],
  listSkills: async root => { window.calls.list++; return {
    skills: [
      skill('review', 'workspace', 'claude', 'Review the current diff for bugs and missing tests before you open a pull request', root + '/.claude/skills/review/SKILL.md'),
      skill('ship', 'workspace', 'agents', 'Open a PR with the team template', root + '/.agents/skills/ship/SKILL.md'),
      skill('notes', 'user', 'codex', 'Write release notes from merged PRs', '/Users/ana/.codex/skills/notes/SKILL.md'),
      ...['milagre','milagre-advisor','milagre-committee','milagre-help'].map(name => skill(name, 'bundled', 'milagre', 'Milagre orchestration and help', '/Applications/Milagre.app/skills/' + name + '/SKILL.md')),
      skill('tldr', 'bundled', 'milagre', 'Rewrite for a skimming reader', '/Applications/Milagre.app/skills/tldr/SKILL.md'),
    ],
    shadowed: [{ ...skill('review', 'user', 'claude', 'Older review', '/Users/ana/.claude/skills/review/SKILL.md'), shadowedBy: root + '/.claude/skills/review/SKILL.md' }],
    warnings: ['Cannot read /Users/ana/.gemini/skills/broken/SKILL.md: Invalid skill name'],
  }; },
  readSkill: async (_root, file) => { window.calls.read.push(file); return '---\\nname: review\\ndescription: Review\\n---\\n# Review\\n\\nRead the diff, then:\\n\\n- find bugs\\n- check tests\\n'; },
  openSkill: async request => { window.calls.open.push(request); return { ok: true, value: null }; },
  revealSkill: async (_root, file) => { window.calls.reveal.push(file); },
};
// Settings picks a local Project while a remote Project remains open behind it.
const remote = { ...window.milagre, listSkills: async () => { throw new Error('Local Settings reached the remote computer'); } };
createRoot(document.getElementById('root')).render(<BridgeContext value={remote}><div style={{ height: '100vh' }}><SettingsPanel section="skills" project={{ path: "/work/app", name: "app" }} models={[]} update={null} /></div></BridgeContext>);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-skills-settings-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 900, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
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
  const rows = () => evaluate(`[...document.querySelectorAll('[data-skill-group] li')].map(li => li.querySelector('span span').textContent)`);
  const groups = () => evaluate(`[...document.querySelectorAll('[data-skill-group] h2')].map(h => h.textContent)`);
  const search = (text) =>
    evaluate(
      `(() => { const input = document.querySelector('input[aria-label="Search skills"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
  const click = (text) => evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
  const pick = async (label, option) => {
    await evaluate(`document.querySelector('button[aria-label="${label}"]').click()`);
    await delay(100);
    await evaluate(`[...document.querySelectorAll('[role="option"]')].find(o => o.textContent.includes(${JSON.stringify(option)})).click()`);
    await delay(100);
  };
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    window.webContents.invalidate();
    await delay(250);
    await window.webContents.capturePage();
    await delay(100);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`document.querySelectorAll('[data-skill-group]').length === 3`);
    assert.deepEqual(await groups(), ["Project · 2", "User · 1", "Built-in · 5"]);
    assert.ok(await evaluate(`document.body.textContent.includes('~/.codex/skills/notes/SKILL.md')`), "paths shorten the home folder");
    assert.ok(await evaluate(`document.body.textContent.includes('Overrides 1 other')`), "the winner says what it hides");
    assert.ok(
      await evaluate(`document.querySelector('[data-skill-warnings]').textContent.includes('~/.gemini/skills/broken/SKILL.md')`),
      "warnings have their own section",
    );
    assert.deepEqual(
      await evaluate(`[...document.querySelectorAll('[data-skill-group="bundled"] li')].map(li => li.querySelector('span span').textContent).sort()`),
      ["/milagre", "/milagre-advisor", "/milagre-committee", "/milagre-help", "/tldr"],
    );
    await screenshot("list");

    await search("pull request");
    await waitFor(`document.querySelectorAll('[data-skill-group] li').length === 1`);
    assert.deepEqual(await rows(), ["/review"]);
    await search("");
    await pick("Scope", "Project");
    assert.deepEqual(await rows(), ["/review", "/ship"]);
    await pick("Source", "Agents");
    assert.deepEqual(await rows(), ["/ship"], "scope and source filter together");
    await search("release");
    await waitFor(`!!document.querySelector('[data-skills-settings] [role="status"]')`);
    assert.ok(await evaluate(`document.body.textContent.includes('No skills found. Create one in .claude/skills/<name>/SKILL.md')`));
    await screenshot("empty");
    await search("");
    await pick("Scope", "All scopes");
    await pick("Source", "All sources");

    await click("Reload");
    await waitFor(`window.calls.list === 2`);

    await evaluate(`document.querySelector('[data-skill-group] li button').click()`);
    await waitFor(`!!document.querySelector('[data-skill-detail] .markdown li')`);
    assert.ok(
      !(await evaluate(`document.querySelector('[data-skill-detail] .markdown').textContent.includes('description:')`)),
      "frontmatter shows as the header, not the body",
    );
    assert.ok(
      await evaluate(`document.querySelector('[data-skill-shadowed]').textContent.includes('~/.claude/skills/review/SKILL.md')`),
      "the ignored path is listed",
    );
    await screenshot("detail");
    await click("Open in Cursor");
    await click(`Show in ${fileManager}`);
    await waitFor(`window.calls.reveal.length === 1`);
    assert.deepEqual(await evaluate("window.calls.open.map(r => r.file)"), ["/work/app/.claude/skills/review/SKILL.md"]);
    await click("All skills");
    await waitFor(`document.querySelectorAll('[data-skill-group]').length === 3`);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: grouped list with counts, search and filters together, empty state, Reload, detail with rendered SKILL.md, shadowed paths, warnings and actions",
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-skills-settings"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "skills-settings-fixture",
        resolveId(id) {
          if (id === "/__skills-settings.tsx") return id;
        },
        load(id) {
          if (id === "/__skills-settings.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__skills-settings") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__skills-settings.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__skills-settings`], {
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
