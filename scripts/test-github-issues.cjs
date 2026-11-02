const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { GitHubIssueImport } from "/src/components/GitHubIssueImport";
import { GitHubIssueCard } from "/src/components/agents/GitHubIssueCard";
import "/src/styles.css";
const issue = { repository: "acme/app", number: 12, url: "https://github.com/acme/app/issues/12", title: "GitHub login redirect", body: "## Reproduction\\nOpen the login screen.", state: "OPEN", importedAt: "2026-11-02T23:00:00Z", account: "victor" };
window.githubImports = [];
window.milagre = {
  listGitHubIssues: async () => ({ repository: "acme/app", account: "victor", issues: [issue] }),
  readGitHubIssue: async (_path, url) => { if (window.githubReadError) throw new Error(window.githubReadError); if (url !== issue.url) throw new Error("Invalid issue URL"); if (window.deferGithubRead) return new Promise(resolve => { window.finishGithubRead = () => resolve(issue); }); return issue; },
  importGitHubIssue: async (request) => { window.githubImports.push(request); if (window.deferGithubImport) return new Promise(resolve => { window.finishGithubImport = () => resolve({ project: { state: {} }, sessionId: 42, worktreeId: 3 }); }); return { project: { state: {} }, sessionId: 42, worktreeId: 3 }; },
};
function Fixture() {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState("/fixture");
  window.showGithubImport = setOpen;
  window.changeGithubProject = () => setScope(current => current === "/fixture" ? "/other-project" : "/fixture");
  const state = { worktrees: { 1: { id: 1, name: "main", path: scope } }, sessions: { 2: { id: 2, worktree_id: 1, title: "Existing Chat" } } };
  return <div style={{ padding: 24 }}>
    <GitHubIssueCard issue={{ ...issue, kind: "github-issue", note: "Inspect first" }} />
    {open && <GitHubIssueImport key={scope} project={{ path: scope, name: scope === "/fixture" ? "Fixture" : "Other Project", state }} computer="This computer" baseBranch="main" options={{ provider: "codex", model: "test", permissionMode: "ask" }} note="Inspect first" onClose={() => setOpen(false)} onImported={() => setOpen(false)} />}
  </div>;
}
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-github-issues-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 800, height: 800, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(source)) return;
      await delay(50);
    }
    throw new Error(`Timed out waiting for ${source}`);
  }
  const button = (text) => `[...document.querySelectorAll("dialog button")].find(button => button.textContent.trim() === ${JSON.stringify(text)})`;
  const enterUrl = async (url) => {
    await evaluate(
      `(() => { const input = document.querySelector('dialog input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(url)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
  };
  async function preview() {
    await evaluate("window.showGithubImport(true)");
    await waitFor('!!document.querySelector("dialog input")');
    await waitFor('!document.querySelector("dialog").textContent.includes("Reading GitHub...")');
    await enterUrl("https://github.com/acme/app/issues/12");
    await waitFor(`!${button("Preview URL")}.disabled`);
    await evaluate(`${button("Preview URL")}.click()`);
    await waitFor('!!document.querySelector("[data-slot=github-issue-preview]")');
  }
  async function close() {
    await evaluate(`${button("Cancel")}.click()`);
    await waitFor('!document.querySelector("dialog")');
  }
  try {
    await window.loadURL(process.argv[2]);
    await waitFor('!!document.querySelector("[data-slot=github-issue]")');
    assert.equal(await evaluate('document.querySelector("[data-slot=github-issue] a").getAttribute("href")'), "https://github.com/acme/app/issues/12");
    assert.ok(await evaluate('document.querySelector("[data-slot=github-issue]").textContent.includes("acme/app#12")'));
    assert.equal(await evaluate('document.querySelector("[data-slot=github-issue] p").textContent'), "Inspect first");
    await preview();
    assert.ok(await evaluate('document.querySelector("[data-slot=github-issue-preview]").textContent.includes("Open the login screen.")'));
    assert.ok(await evaluate('document.querySelector("[data-slot=github-issue-preview]").textContent.includes("Account: victor. Imported:")'));
    assert.equal(await evaluate("window.githubImports.length"), 0);
    await enterUrl("https://github.com/acme/app/issues/99");
    await waitFor('!document.querySelector("[data-slot=github-issue-preview]")');
    assert.equal(await evaluate(`${button("Import and start Chat")}.disabled`), true, "editing a URL invalidates the selected issue");
    await enterUrl("https://github.com/acme/app/issues/12");
    await evaluate(`${button("Preview URL")}.click()`);
    await waitFor('!!document.querySelector("[data-slot=github-issue-preview]")');
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "github-issue-preview.png"), (await window.webContents.capturePage()).toPNG());
    }
    await close();
    assert.equal(await evaluate("window.githubImports.length"), 0, "Cancel never starts work");
    // Changing Project/Computer discards a pending preview rather than allowing the old issue into the new target.
    await evaluate("window.deferGithubRead = true; window.showGithubImport(true)");
    await waitFor('!!document.querySelector("dialog input")');
    await waitFor('!document.querySelector("dialog").textContent.includes("Reading GitHub...")');
    await enterUrl("https://github.com/acme/app/issues/12");
    await waitFor(`!${button("Preview URL")}.disabled`);
    await evaluate(`${button("Preview URL")}.click()`);
    await waitFor("typeof window.finishGithubRead === 'function'");
    await evaluate("window.changeGithubProject()");
    await waitFor('document.querySelector("dialog").textContent.includes("Other Project")');
    await evaluate("window.finishGithubRead(); window.deferGithubRead = false");
    await delay(100);
    assert.equal(await evaluate('!!document.querySelector("[data-slot=github-issue-preview]")'), false);
    await close();
    await evaluate("window.githubReadError = \"Error invoking remote method 'github:issue': Error: GitHub access denied\"");
    await evaluate("window.showGithubImport(true)");
    await waitFor('!!document.querySelector("dialog input")');
    await waitFor('!document.querySelector("dialog").textContent.includes("Reading GitHub...")');
    await enterUrl("https://github.com/acme/app/issues/12");
    await waitFor(`!${button("Preview URL")}.disabled`);
    await evaluate(`${button("Preview URL")}.click()`);
    await waitFor('document.querySelector("[role=alert]")?.textContent.includes("GitHub access denied")');
    assert.equal(await evaluate(`${button("Import and start Chat")}.disabled`), true);
    assert.equal(await evaluate('document.querySelector("[role=alert]").textContent'), "GitHub access denied");
    await close();
    await evaluate('window.githubReadError = ""');
    await preview();
    await evaluate(`${button("Import and start Chat")}.click()`);
    await waitFor('window.githubImports.length === 1 && !document.querySelector("dialog")');
    assert.deepEqual(await evaluate("window.githubImports[0].target"), { kind: "worktree", baseBranch: "main" });
    assert.equal(await evaluate("window.githubImports[0].url"), "https://github.com/acme/app/issues/12");
    // A late completion from the old Computer/Project cannot close or navigate the new form.
    await evaluate("window.deferGithubImport = true");
    await preview();
    await evaluate(`${button("Import and start Chat")}.click()`);
    await waitFor("typeof window.finishGithubImport === 'function'");
    await evaluate("window.changeGithubProject()");
    await waitFor('document.querySelector("dialog").textContent.includes("Project: /fixture")');
    await evaluate("window.finishGithubImport(); window.deferGithubImport = false");
    await delay(100);
    assert.equal(await evaluate('!!document.querySelector("dialog")'), true, "a completed import from the old target never closes the current form");
    await close();
    console.log("PASS: GitHub issue preview, provenance, cancellation, permission errors, stale responses and confirmed import");
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
        name: "github-issue-fixture",
        resolveId(id) {
          if (id === "/__github_issue_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__github_issue_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__github_issues__") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__github_issue_fixture.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env, MILAGRE_BACKGROUND: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__github_issues__`], { env, stdio: "inherit" });
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
