// Electron side of the landing page recording: the real renderer and preload, attached to the demo host like the
// desktop app attaches to its own host (see apps/desktop/electron/main.cjs), drawn offscreen at 2x and captured at
// 30 fps. Driven by record.cjs over stdin/stdout, one JSON command per line.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, ipcMain } = require("electron");
const { connectDesktopRuntime } = require("../../apps/desktop/electron/daemon-runtime.cjs");

const { DATA_DIR, VERSION, APP_URL, HERO_CHAT } = process.env;
const WIDTH = 1280;
const HEIGHT = 800;
const SCALE = 2;
const FPS = 30;

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-site-demo-electron-")));
app.on("window-all-closed", () => {});

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");

async function main() {
  await app.whenReady();
  let window;
  const runtime = await connectDesktopRuntime({
    dataDir: DATA_DIR,
    version: VERSION,
    cwd: process.cwd(),
    emit(channel, payload) {
      if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
    },
  });
  for (const method of runtime.methods) ipcMain.handle(method, (_event, ...args) => runtime.invoke(method, args));
  // The main process's own handlers, answered as a fresh install would.
  const local = {
    "runtime:connection": { connected: true },
    "app:version": VERSION,
    "update:state": { status: "idle" },
    "update:channel": "stable",
    "editor:list": [],
    "notification:state": null,
    "settings:notify-when-waiting": null,
    "settings:window-background": null,
  };
  for (const [channel, value] of Object.entries(local)) if (!runtime.methods.includes(channel)) ipcMain.handle(channel, () => value);

  window = new BrowserWindow({
    // Offscreen windows paint at 1x, so the window is twice the size and the page zoomed 2x: 1280×800 of layout, sharp.
    width: WIDTH * SCALE,
    height: HEIGHT * SCALE,
    useContentSize: true,
    show: false,
    backgroundColor: "#1c1d1f",
    webPreferences: {
      preload: path.resolve(__dirname, "../../apps/desktop/electron/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      zoomFactor: SCALE,
      backgroundThrottling: false,
    },
  });
  window.webContents.setFrameRate(FPS);
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") process.stderr.write(`renderer: ${event.message}\n`);
  });
  let latest = null;
  window.webContents.on("paint", (_event, _dirty, image) => {
    latest = image;
  });

  await window.loadURL(APP_URL);
  await window.webContents.executeJavaScript(
    `localStorage.setItem("milagre-settings", JSON.stringify({ theme: "dark", defaultPermissionMode: "ask", notifyWhenWaiting: false, notifyOnCompletion: false, showDockBadge: false, showUsageInSidebar: false, legacySidebar: false }))`,
  );
  const reloaded = new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
  window.webContents.reload();
  await reloaded;
  await waitFor(window, `!!document.querySelector('[data-row]') && !document.querySelector('.startup-splash-screen')`);
  window.webContents.send("notification:open-chat", HERO_CHAT);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  send({ ready: true });

  let recording = null;
  const commands = readline.createInterface({ input: process.stdin });
  for await (const line of commands) {
    const command = JSON.parse(line);
    try {
      if (command.eval) send({ id: command.id, result: await window.webContents.executeJavaScript(command.eval) });
      else if (command.shot) {
        fs.writeFileSync(command.shot, (latest ?? (await window.webContents.capturePage())).toPNG());
        send({ id: command.id, done: true });
      } else if (command.record) {
        recording = record(command.record, () => latest);
        send({ id: command.id, done: true });
      } else if (command.stop) {
        await recording?.stop();
        recording = null;
        send({ id: command.id, done: true });
      } else if (command.quit) break;
    } catch (error) {
      send({ id: command.id, error: error.message });
    }
  }
  window.destroy();
  app.exit(0);
}

// Raw BGRA frames into ffmpeg at a steady 30 fps: each tick writes the newest paint, repeating it when nothing changed,
// and catches up from the wall clock so the video's timing matches the run's.
function record(file, frame) {
  const size = frame().getSize();
  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "bgra",
      "-s",
      `${size.width}x${size.height}`,
      "-r",
      String(FPS),
      "-i",
      "-",
      "-c:v",
      "h264_videotoolbox",
      "-b:v",
      "40M",
      "-pix_fmt",
      "yuv420p",
      file,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  const started = Date.now();
  let written = 0;
  let writing = null;
  const timer = setInterval(() => {
    writing ??= writeDue().finally(() => (writing = null));
  }, 1000 / FPS);
  async function writeDue() {
    const due = Math.floor(((Date.now() - started) / 1000) * FPS) + 1;
    while (written < due) {
      const image = frame();
      const bitmap = image.getSize().width === size.width ? image.toBitmap() : image.resize(size).toBitmap();
      if (!ffmpeg.stdin.write(bitmap)) await new Promise((resolve) => ffmpeg.stdin.once("drain", resolve));
      written++;
    }
  }
  return {
    async stop() {
      clearInterval(timer);
      await writing;
      ffmpeg.stdin.end();
      await new Promise((resolve) => ffmpeg.on("exit", resolve));
    },
  };
}

async function waitFor(window, source, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await window.webContents.executeJavaScript(source).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${source}`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  app.exit(1);
});
