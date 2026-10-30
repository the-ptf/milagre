// Real desktop renderer + a loopback-only mobile fixture. No provider or personal data is read.
// node scripts/capture-readme.cjs /tmp/milagre-readme
// Pair a simulator with the printed demo link, capture its navigation, then:
// node scripts/capture-readme.cjs /tmp/milagre-readme --compose /absolute/mobile.png
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const output = path.resolve(process.argv[2] || path.join(os.tmpdir(), "milagre-readme"));
const projectPath = "/demo/milagre";
const projectImage =
  "data:image/png;base64," + fs.readFileSync(path.resolve(__dirname, "../apps/desktop/app/public/logo-milagre-image.png")).toString("base64");
const port = Number(process.env.MILAGRE_README_PORT || 8798);
const topics = [
  ["Phone pairing follow-ups", "feat/phone-pairing", 192],
  ["Find Projects from the phone", "feat/project-search", 189],
  ["A sidebar for mobile", "feat/mobile-sidebar", 186],
  ["Swipe between Chat and Changes", "feat/swipe-navigation", 184],
  ["Keep the Chat timer running", "fix/chat-timer", 177],
  ["Link Worktrees and share context", "feat/linked-worktrees", 168],
];
const state = {
  next_id: 100,
  projects: { 1: { id: 1, name: "Milagre" } },
  worktrees: { 1: { id: 1, project_id: 1, path: projectPath, name: "main" } },
  sessions: {},
  messages: [],
  connections: {},
  events: [],
  approvals: [],
  tasks: {},
  artifacts: {},
  outputs: [],
  conflicts: [],
};
topics.forEach(([title, branch], i) => {
  const id = i + 2;
  state.worktrees[id] = { id, project_id: 1, name: branch, path: `${projectPath}/${branch}`, base: "main" };
  state.sessions[id] = {
    id,
    worktree_id: id,
    title,
    agent_name: title,
    provider: i % 2 ? "claude" : "codex",
    status: "Stopped",
    ...(i === 4 ? { unread: true } : {}),
  };
  state.messages.push({
    id: id * 10,
    session_id: id,
    role: "user",
    body: `Let's work on ${title.toLowerCase()}.`,
    context: null,
    model: i % 2 ? "claude-sonnet-5-5" : "gpt-6.1-sol",
  });
});
const project = { path: projectPath, name: "Milagre", state };
const run = (text, more = {}) => ({
  text,
  model: "gpt-6.1-sol",
  startedAt: Date.now() - 90000,
  steps: [],
  approvals: [],
  questions: [],
  answered: {},
  ...more,
});
const runs = {
  runs: {
    [`${projectPath}#2`]: run("Checking the paired-phone count and reset flow."),
    [`${projectPath}#3`]: run("", {
      questions: [
        {
          id: "search-scope",
          questions: [
            {
              id: "scope",
              header: "Search",
              question: "Should Project search include ignored folders?",
              options: [
                { label: "Skip ignored folders", description: "Keep the results focused on Projects." },
                { label: "Include everything", description: "Search all folders." },
              ],
            },
          ],
        },
      ],
    }),
    [`${projectPath}#4`]: run("Testing the sidebar on iPhone."),
    [`${projectPath}#5`]: run("", {
      approvals: [{ id: "check", tool: "Bash", input: { command: "npm run test:mobile" }, description: "Run the swipe navigation checks" }],
    }),
  },
  seq: 1,
};
const models = { codex: null, claude: null, antigravity: null, kiro: null };
const linked = { delegations: [], negotiations: [], receiveOnly: [] };

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '/src/App';
import '/src/styles.css';
window.addEventListener('error', e => console.error(e.error?.stack || e.message));
const project = ${JSON.stringify(project)}, runs = ${JSON.stringify(runs)};
const replies = {
  getCurrentProject: project, getRuns: runs, getModels: ${JSON.stringify(models)},
  getCliStatus: {codex:{state:'ready'},claude:{state:'ready'},antigravity:{state:'ready'},kiro:{state:'missing'}},
  getRuntimeConnection: {connected:true}, getLinkedWork: ${JSON.stringify(linked)},
  listRecentProjects: [{path:project.path,name:project.name}], listBranches: ['main'],
  getWorktreeRoots: [], getCachedUsage: {providers:[]}, readUsage: {providers:[]}, getAgentPorts: {},
  getProjectImage: ${JSON.stringify(projectImage)}, getUpdateState: null, listSkills: {skills:[],warnings:[]}, listAgentPorts: [],
  readDiffStats: {}, getDiffStats: {},
};
window.milagre = new Proxy({}, {get(_, name) {
  if (name === 'git') return {diffStats: async () => ({added:0,removed:0}), diffFiles: async () => []};
  if (name.startsWith('on')) return () => () => {};
  if (name === 'readPullRequest') return async p => {
    const index = ${JSON.stringify(topics)}.findIndex(t => p.endsWith(t[1]));
    if (index < 0) return null;
    const [title,,number] = ${JSON.stringify(topics)}[index];
    return {number,title,url:'https://github.com/the-ptf/milagre-ade/pull/'+number,state:'OPEN',checks:index===0?'running':'passed',readyToMerge:index===5};
  };
  if (name === 'readPullRequests') return async (_, paths) => paths.map(() => null);
  // As an older host: the sidebar reads each Worktree's PR from readPullRequest above.
  if (name === 'readPullRequestSnapshot') return async () => { throw new Error('Unknown command: pull-requests:snapshot'); };
  return async () => name in replies ? replies[name] : null;
}});
localStorage.setItem('milagre-settings', JSON.stringify({theme:'light',defaultPermissionMode:'auto',notifyWhenWaiting:false,notifyOnCompletion:false,showDockBadge:false,showUsageInSidebar:false}));
createRoot(document.getElementById('root')).render(<App />);
`;

async function capture(url, compose) {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-readme-electron-")));
  await app.whenReady();
  const window = new BrowserWindow({
    width: compose ? 1800 : 1360,
    height: compose ? 980 : 900,
    useContentSize: true,
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  window.webContents.on("console-message", (e) => {
    if (e.level === "error") console.error(e.message);
  });
  await window.loadURL(url);
  if (!compose) {
    let ready = false;
    for (let i = 0; i < 200; i++) {
      if (await window.webContents.executeJavaScript(`!!document.querySelector('[data-row]') && !document.querySelector('.startup-splash-screen')`)) {
        ready = true;
        break;
      }
      await delay(50);
    }
    if (!ready) throw new Error("Desktop fixture did not render");
    await window.webContents.executeJavaScript(
      `[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'New chat' || b.getAttribute('aria-label') === 'New Chat')?.click()`,
    );
    console.log(await window.webContents.executeJavaScript("document.body.innerText"));
  }
  await window.webContents.executeJavaScript("document.fonts.ready");
  await delay(1000);
  fs.writeFileSync(path.join(output, compose ? "desktop-and-mobile.png" : "desktop.png"), (await window.webContents.capturePage()).toPNG());
  app.exit();
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const compose = process.argv.includes("--compose");
  if (process.versions.electron) return capture(process.argv.at(-1), compose);
  const { createServer } = await import("vite");
  let html;
  if (compose) {
    const mobile = process.argv[process.argv.indexOf("--compose") + 1];
    const uri = (file) => "data:image/png;base64," + fs.readFileSync(file).toString("base64");
    html = `<html><style>*{box-sizing:border-box}body{margin:0;width:1800px;height:980px;background:#f0f2f5;display:flex;align-items:center;justify-content:center;gap:42px}.desktop{width:1260px;height:834px;border-radius:18px;overflow:hidden;border:1px solid #d9dce1;box-shadow:0 20px 60px #17203320}.desktop img{width:100%;height:100%}.phone{width:370px;border:7px solid #232427;border-radius:44px;overflow:hidden;box-shadow:0 20px 50px #17203330;background:#fafafb}.phone img{display:block;width:100%}</style><body><div class="desktop"><img src="${uri(path.join(output, "desktop.png"))}"></div><div class="phone"><img src="${uri(mobile)}"></div></body></html>`;
  }
  if (!process.argv.includes("--host-only")) {
    const server = await createServer({
      configFile: path.resolve("apps/desktop/vite.config.ts"),
      server: { host: "127.0.0.1", port: 0 },
      plugins: [
        {
          name: "readme-fixture",
          resolveId: (id) => (id === "/__readme.tsx" ? id : null),
          load: (id) => (id === "/__readme.tsx" ? fixture : null),
          configureServer(server) {
            useAsyncMiddleware(server.middlewares, async (req, res, next) => {
              if (req.url !== "/__readme") return next();
              res.setHeader("Content-Type", "text/html");
              res.end(
                await server.transformIndexHtml(
                  req.url,
                  html || '<html><body><div id="root"></div><script type="module" src="/__readme.tsx"></script></body></html>',
                ),
              );
            });
          },
        },
      ],
    });
    await server.listen();
    const child = spawn(require("electron"), [__filename, output, ...(compose ? ["--compose"] : []), `${server.resolvedUrls.local[0]}__readme`], {
      stdio: "inherit",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
    });
    const code = await new Promise((resolve) => child.on("exit", resolve));
    await server.close();
    if (code) throw new Error("Screenshot capture failed");
    if (compose) return;
  }
  // Read-only fixture: accepts only a public demo token, never opens a real Project.
  const token = "0".repeat(64);
  const http = require("node:http").createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      return res.end();
    }
    let result = null;
    if (req.url.startsWith("/snapshot")) result = { project, runs };
    else if (req.url.startsWith("/runs")) result = runs;
    else if (req.url === "/rpc") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { method } = JSON.parse(body);
      const values = {
        "daemon:status": { connected: true },
        "project:recent": [{ path: projectPath, name: "Milagre" }],
        "project:open": project,
        "agent:models": models,
        "agent:cli-status": { codex: { state: "ready" }, claude: { state: "ready" }, antigravity: { state: "ready" }, kiro: { state: "missing" } },
        "chat:runs": runs,
        "usage:read": { providers: [] },
        "git:branches": ["main"],
        "project:image": projectImage,
      };
      result = values[method] ?? null;
      console.log("Mobile fixture:", method);
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ v: 1, result }));
  });
  http.listen(port, "127.0.0.1", () =>
    console.log(`Demo only: milagre://pair?address=${encodeURIComponent("http://127.0.0.1:" + port)}&token=${token}&name=My%20Mac`),
  );
  process.once("SIGINT", () => http.close());
  process.once("SIGTERM", () => http.close());
}
main().catch((error) => {
  console.error(error);
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
