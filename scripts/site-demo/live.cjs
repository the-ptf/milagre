// Records landing page clips from the full desktop app: the source build, its own host and real agents, run off screen
// (MILAGRE_BACKGROUND=1) in a throwaway profile and Chats home, so the Milagre you have open is never touched.
//   node scripts/site-demo/live.cjs <out-dir> <project-folder>
// Reads commands from <out-dir>/cmd (one per write), like record.cjs:
//   eval <js>       evaluate in the window and print the result
//   shot <file>     screenshot the window
//   record <file>   start recording an mp4 of the window at 30 fps
//   stop            stop recording
//   quit
// Build the renderer first: npm run build:renderer --workspace milagre
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const out = path.resolve(process.argv[2] || "/tmp/milagre-site-live");
const project = path.resolve(process.argv[3] || process.cwd());
const root = path.resolve(__dirname, "../..");
const WIDTH = Number(process.env.WIDTH || 1280);
const HEIGHT = Number(process.env.HEIGHT || 800);
const SCALE = 2;
const FPS = 30;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (ready, ms = 50) => {
  while (!ready()) await wait(ms);
};

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const profile = process.env.PROFILE ? path.resolve(process.env.PROFILE) : path.join(out, "profile");
  const env = {
    ...process.env,
    MILAGRE_CHATS_HOME: process.env.MILAGRE_CHATS_HOME ?? path.join(profile, "chats-home"),
    MILAGRE_BACKGROUND: process.env.MILAGRE_BACKGROUND ?? "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  env.MILAGRE_DEV_SERVER_URL = require("node:url").pathToFileURL(path.join(root, "apps/desktop/dist/index.html")).href;
  const child = spawn(
    require("electron"),
    [path.join(root, "apps/desktop"), `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--use-mock-keychain"],
    {
      cwd: project,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  let port;
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      log = (log + data.toString()).slice(-20000);
      port ??= log.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1];
    });
  child.on("exit", (code) => console.log(`electron exited ${code}\n${log.slice(-2000)}`));
  // A copy left running keeps its Browser panel pages, and the next take's agent can reach those instead of its own.
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      child.kill();
      process.exit(1);
    });
  await until(() => port, 100);
  let page;
  while (!page) {
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    page = pages.find((item) => item.type === "page" && item.url.startsWith("file:") && !item.url.includes("floating"));
    if (!page) await wait(200);
  }
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.call("Runtime.enable");
  // Layout at 1280×800, drawn at 2x: the hero recording's size.
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false });
  console.log(`desktop: ready (CDP ${port}, profile ${profile})`);
  fs.writeFileSync(path.join(out, "live.json"), JSON.stringify({ port, profile }, null, 2));

  let latest = null;
  cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
    latest = Buffer.from(data, "base64");
    void cdp.call("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  let recording = null;
  const cmd = path.join(out, "cmd");
  fs.writeFileSync(cmd, "");
  for (;;) {
    const text = fs.readFileSync(cmd, "utf8").trim();
    if (!text) {
      await wait(100);
      continue;
    }
    fs.writeFileSync(cmd, "");
    const space = text.indexOf(" ");
    const [name, arg] = space === -1 ? [text, ""] : [text.slice(0, space), text.slice(space + 1)];
    try {
      if (name === "eval") {
        const result = await cdp.call("Runtime.evaluate", { expression: arg, awaitPromise: true, returnByValue: true });
        console.log(`result: ${JSON.stringify(result.exceptionDetails ?? result.result.value)}`);
      } else if (name === "shot") {
        const { data } = await cdp.call("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(path.resolve(out, arg || "shot.png"), Buffer.from(data, "base64"));
      } else if (name === "record") {
        latest = null;
        await cdp.call("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: WIDTH * SCALE, maxHeight: HEIGHT * SCALE, everyNthFrame: 1 });
        await until(() => latest, 20);
        recording = record(path.resolve(out, arg || "live.mp4"), () => latest);
      } else if (name === "stop") {
        await cdp.call("Page.stopScreencast");
        await recording?.stop();
        recording = null;
      } else if (name === "quit") break;
      console.log(`done: ${name}`);
    } catch (error) {
      console.log(`failed: ${text}: ${error.message}`);
    }
  }
  child.kill();
  process.exit(0);
}

// The newest frame into ffmpeg 30 times a second, repeated when nothing changed, so the clip keeps the run's timing.
function record(file, frame) {
  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
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
    writing ??= (async () => {
      const due = Math.floor(((Date.now() - started) / 1000) * FPS) + 1;
      while (written < due) {
        if (!ffmpeg.stdin.write(frame())) await once(ffmpeg.stdin, "drain");
        written++;
      }
    })().finally(() => (writing = null));
  }, 1000 / FPS);
  return {
    async stop() {
      clearInterval(timer);
      await writing;
      ffmpeg.stdin.end();
      await once(ffmpeg, "exit");
    },
  };
}

async function connect(url) {
  const socket = new WebSocket(url);
  await once(socket, "open");
  let next = 0;
  const waiting = new Map();
  const listeners = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    } else listeners.get(message.method)?.(message.params);
  });
  return {
    call: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        waiting.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
        socket.send(JSON.stringify({ id, method, params }));
      }),
    on: (method, listener) => listeners.set(method, listener),
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
