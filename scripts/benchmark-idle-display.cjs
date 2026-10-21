// Isolated production ThinkingIndicator, comparing visible/hidden work. No provider or real user state is loaded.
// MILAGRE_IDLE_BASELINE=1 reads the pre-change indicator/styles from the pinned baseline for a paired comparison.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const baseline = process.env.MILAGRE_IDLE_BASELINE === "1";
const baselineRef = process.env.MILAGRE_IDLE_BASELINE_REF || "691c2d47";
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThinkingIndicator } from '/src/components/ThinkingIndicator';
import { followDisplayVisibility } from '/src/lib/display-clock';
import '/src/styles.css';
${baseline ? "" : "followDisplayVisibility();"}
window.commits = 0;
const startedAt = Date.now() - 10000;
createRoot(document.getElementById('root')).render(<React.Profiler id="clock" onRender={() => window.commits++}>
  <ThinkingIndicator label="Working" startedAt={startedAt} />
</React.Profiler>);
`;

async function measure() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-idle-display-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 400, height: 200, show: true });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  try {
    await window.loadURL(process.argv[2]);
    await delay(1000);
    window.webContents.debugger.attach("1.3");
    const snapshot = async () => {
      await window.webContents.debugger.sendCommand("HeapProfiler.collectGarbage");
      return {
        capturedAtMs: Date.now(),
        ...(await evaluate(
          `({ commits: window.commits, visibility: document.visibilityState, elapsed: document.querySelector('[role="status"]')?.textContent })`,
        )),
        heap: await window.webContents.debugger.sendCommand("Runtime.getHeapUsage"),
        processes: app.getAppMetrics().map(({ type, cpu, memory }) => ({ type, cpu, memory })),
      };
    };
    const visibleStart = await snapshot();
    await delay(3000);
    const visibleEnd = await snapshot();
    window.hide();
    await delay(200);
    const hiddenStart = await snapshot();
    await delay(3000);
    const hiddenEnd = await snapshot();
    window.show();
    await delay(100);
    const returned = await snapshot();
    const result = {
      baseline,
      visibleCommits: visibleEnd.commits - visibleStart.commits,
      hiddenCommits: hiddenEnd.commits - hiddenStart.commits,
      visibleStart,
      visibleEnd,
      hiddenStart,
      hiddenEnd,
      returned,
    };
    console.log(JSON.stringify(result, null, 2));
    if (process.env.MILAGRE_BENCHMARK_OUTPUT) fs.writeFileSync(process.env.MILAGRE_BENCHMARK_OUTPUT, JSON.stringify(result, null, 2) + "\n");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve("apps/desktop/vite.config.ts"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "idle-display-benchmark",
        enforce: "pre",
        resolveId(id) {
          if (id === "/__idle_display.tsx") return id;
        },
        load(id) {
          if (id === "/__idle_display.tsx") return fixture;
          if (baseline && ["/components/ThinkingIndicator.tsx", "/styles.css"].some((suffix) => id.endsWith(suffix))) {
            return execFileSync("git", ["show", `${baselineRef}:${path.relative(process.cwd(), id)}`], { encoding: "utf8" });
          }
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__idle_display__") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__idle_display.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [__filename, server.resolvedUrls.local[0] + "__idle_display__"], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}
(process.versions.electron ? measure() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
