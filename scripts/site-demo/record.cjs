const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn, execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { startSiteDemo } = require("./host.cjs");

const out = path.resolve(process.argv[2] || "/tmp/milagre-site-demo");
const root = path.resolve(__dirname, "../..");

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const events = [];
  const log = (event) => {
    events.push({ event, at: Date.now() });
    console.log(`host: ${event}`);
  };
  const demo = await startSiteDemo({ port: Number(process.env.MILAGRE_SITE_DEMO_PORT || 8913), log });
  console.log(`pair: ${demo.pairing}`);
  fs.writeFileSync(path.join(out, "demo.json"), JSON.stringify({ pairing: demo.pairing, heroChatId: demo.heroChatId, url: demo.bridgeUrl }, null, 2));

  execFileSync("npm", ["run", "build:renderer", "--workspace", "milagre"], { cwd: root, stdio: "ignore" });
  const appUrl = pathToFileURL(path.join(root, "apps/desktop/dist/index.html")).href;

  const electron = spawn(require("electron"), [path.join(__dirname, "desktop.cjs")], {
    cwd: root,
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", DATA_DIR: demo.dataDir, VERSION: demo.version, APP_URL: appUrl, HERO_CHAT: demo.heroChatId },
  });
  const waiting = new Map();
  let ready;
  const readyPromise = new Promise((resolve) => (ready = resolve));
  readline.createInterface({ input: electron.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return console.log(`electron: ${line}`);
    }
    if (message.ready) return ready();
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  let next = 0;
  const ask = (command) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      waiting.set(id, (message) => (message.error ? reject(new Error(message.error)) : resolve(message)));
      electron.stdin.write(JSON.stringify({ id, ...command }) + "\n");
    });
  electron.on("exit", (code) => console.log(`electron exited ${code}`));
  await readyPromise;
  console.log("desktop: ready");

  const until = async (event) => {
    while (!events.some((item) => item.event === event)) await new Promise((resolve) => setTimeout(resolve, 20));
  };
  const cmd = path.join(out, "cmd");
  fs.writeFileSync(cmd, "");
  for (;;) {
    const text = fs.readFileSync(cmd, "utf8").trim();
    if (!text) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    fs.writeFileSync(cmd, "");
    const [name, arg] = text.split(/\s+/, 2);
    try {
      if (name === "shot") await ask({ shot: path.resolve(out, arg || "desktop.png") });
      else if (name === "take") {
        const file = path.join(out, "desktop.mp4");
        await ask({ record: file });
        const started = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await demo.play();
        if (process.env.AUTO_APPROVE) void until("hero:approval").then(() => setTimeout(() => demo.approve(), Number(process.env.AUTO_APPROVE)));
        await until("hero:done");
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await ask({ stop: true });
        const marks = Object.fromEntries(events.map(({ event, at }) => [event, (at - started) / 1000]));
        fs.writeFileSync(path.join(out, "take.json"), JSON.stringify({ started, marks }, null, 2));
        console.log(`take: ${file} ${JSON.stringify(marks)}`);
      } else if (name === "quit") break;
      console.log(`done: ${text}`);
    } catch (error) {
      console.log(`failed: ${text}: ${error.message}`);
    }
  }
  electron.stdin.write(JSON.stringify({ quit: true }) + "\n");
  electron.kill();
  await demo.close();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
