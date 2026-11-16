// The first Electron launch on a fresh Linux CI runner is unreliable: its GPU process can fail to start
// (UnknownVizError), pages render slowly, and early input is dropped. A second launch behaves. `npm test`
// runs this once before the Electron checks on Linux CI so no check is the first launch.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (!process.versions.electron) {
  const { spawnSync } = require("node:child_process");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require("electron"), [__filename], { env, stdio: "inherit" });
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require("electron");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-warmup-")));
setTimeout(() => app.exit(0), 30_000).unref();
app.whenReady().then(async () => {
  try {
    const window = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { backgroundThrottling: false } });
    await window.loadURL("data:text/html,<p>warm-up</p><button>ok</button>");
    await window.webContents.capturePage();
  } catch (error) {
    console.log(`warm-up: ${error.message}`);
  } finally {
    app.exit(0);
  }
});
