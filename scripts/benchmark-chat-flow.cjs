// Synthetic renderer benchmark, using the real App and the send test's held IPC fixture.
// Run before/after with the same Node/Electron versions, idle machine and viewport.
// Values are React render time, not network latency or a guarantee for real projects.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const base = require("./fixtures/chat-send-feedback.cjs");
const fixture = base
  .replace(
    "const listeners = new Set();",
    `
const count = Number(new URLSearchParams(location.search).get('count') || 40);
state.messages = Array.from({ length: count }, (_, index) => ({
  id: index + 3, session_id: 2, role: index % 2 ? 'assistant' : 'user', context: null,
  body: index % 2 ? 'Completed the requested change.\\n\\n' + 'The updated component keeps the existing messages visible while the request is pending. Here are the changes and checks.\\n\\n'.repeat(8) : 'Please continue with change ' + index,
  ...(index % 2 ? { steps: Array.from({ length: 8 }, (_, step) => ({ id: index + '-' + step, kind: 'read', title: 'Read source and check implementation', status: 'done', detail: 'Read source file.\\n'.repeat(20) })) } : {}),
}));
state.next_id = count + 3;
window.renderSamples = [];
const listeners = new Set();
`,
  )
  .replace("<App />", '<React.Profiler id="app" onRender={(_id, phase, duration) => window.renderSamples.push({ phase, duration })}><App /></React.Profiler>');

async function benchmark() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-flow-benchmark-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1100, height: 760, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const results = [];
  try {
    for (const count of [40, 300, 1000]) {
      for (let trial = 0; trial < 3; trial++) {
        await window.loadURL(process.argv[2] + "?count=" + count);
        let ready = false;
        for (let wait = 0; wait < 600; wait++) {
          if (await evaluate(`!!document.querySelector('[data-slot="message"]') && !document.querySelector('.startup-splash-screen')`)) {
            ready = true;
            break;
          }
          await delay(25);
        }
        if (!ready) throw new Error("Benchmark did not mount the conversation");
        await delay(500);
        const initial = await evaluate(
          `({ nodes: document.querySelectorAll('*').length, renderMs: window.renderSamples.reduce((sum, item) => sum + item.duration, 0) })`,
        );
        await evaluate(`window.emitAgent(99, { type: 'turn-started' }); window.emitAgent(99, { type: 'text-delta', text: 'Background agent' })`);
        await delay(100);
        const background = await evaluate(`(async () => {
          window.renderSamples = [];
          for (let i = 0; i < 40; i++) {
            window.emitAgent(99, { type: 'text-delta', text: ' Additional output.' });
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          return { commits: window.renderSamples.length, renderMs: window.renderSamples.reduce((sum, item) => sum + item.duration, 0) };
        })()`);
        const result = { count, trial, initial, background };
        results.push(result);
        console.log(JSON.stringify(result));
      }
    }
    if (process.env.MILAGRE_BENCHMARK_OUTPUT) fs.writeFileSync(process.env.MILAGRE_BENCHMARK_OUTPUT, JSON.stringify(results, null, 2) + "\n");
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
    configFile: path.resolve("apps/desktop/vite.config.ts"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "chat-flow-benchmark",
        enforce: "pre",
        resolveId(id) {
          if (id === "/__chat_flow_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__chat_flow_fixture.tsx") return fixture;
          // Optional snapshots let an A/B run use the previous components without editing the working tree.
          const snapshots = process.env.MILAGRE_BENCHMARK_COMPONENTS;
          if (snapshots && ["/components/ChatComposer.tsx", "/components/motion/PreviewRail.tsx"].some((file) => id.endsWith(file))) {
            return fs.readFileSync(path.join(snapshots, path.basename(id)), "utf8");
          }
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url.split("?")[0] !== "/__chat_flow__") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__chat_flow_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), server.resolvedUrls.local[0] + "__chat_flow__"], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}
(process.versions.electron ? benchmark() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
