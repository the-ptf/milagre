// Renders apps/site/public/og.png (1200 × 630) from the real demo recordings at the approval moment, so the link
// preview matches the page. Run after re-recording: node scripts/site-og.cjs
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const site = path.join(root, "apps/site");
const out = path.join(site, "public/og.png");
const AT = "6.5"; // seconds into the recordings: both show the approval card
const SCALE = 2; // rendered at 2x, then downscaled for crisp text

function frame(video, file) {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", AT, "-i", path.join(site, "public/demo", video), "-frames:v", "1", file]);
  return `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
}
const font = (file) => `data:font/woff2;base64,${fs.readFileSync(require.resolve(file, { paths: [root] })).toString("base64")}`;

function html(tmp) {
  const desktop = frame("desktop.mp4", path.join(tmp, "desktop.png"));
  const phone = frame("phone.mp4", path.join(tmp, "phone.png"));
  const icon = `data:image/png;base64,${fs.readFileSync(path.join(site, "public/app-icon-512.png")).toString("base64")}`;
  const geist = font("@fontsource-variable/geist/files/geist-latin-wght-normal.woff2");
  const serif = font("@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Geist; src: url(${geist}) format("woff2"); font-weight: 100 900; }
@font-face { font-family: Serif; src: url(${serif}) format("woff2"); font-style: italic; }
* { box-sizing: border-box; margin: 0; }
html, body { width: 1200px; height: 630px; overflow: hidden; }
body { position: relative; background: radial-gradient(120% 90% at 78% 70%, oklch(0.3 0.08 262) 0%, oklch(0.2 0.03 258) 58%); color: oklch(0.95 0.012 255); font-family: Geist, sans-serif; }
.brand { position: absolute; top: 56px; left: 64px; display: flex; align-items: center; gap: 14px; font-size: 30px; font-weight: 600; letter-spacing: -0.01em; }
.brand img { width: 52px; height: 52px; }
h1 { position: absolute; top: 158px; left: 64px; width: 520px; font-size: 52px; font-weight: 600; line-height: 1.04; letter-spacing: -0.035em; }
h1 em { display: block; margin-top: 8px; font-family: Serif, serif; font-weight: 400; font-size: 54px; line-height: 1.02; letter-spacing: -0.01em; color: oklch(0.86 0.06 255); }
.line { position: absolute; left: 64px; bottom: 58px; width: 450px; font-size: 20px; line-height: 1.4; color: oklch(0.74 0.03 256); }
.mac { position: absolute; top: 108px; left: 600px; width: 720px; aspect-ratio: 16 / 10; border-radius: 14px; overflow: hidden; box-shadow: 0 0 0 1px oklch(1 0 0 / 0.14), 0 30px 80px oklch(0 0 0 / 0.55); }
.mac img { display: block; width: 100%; }
.lights { position: absolute; top: 14px; left: 16px; display: flex; gap: 6px; }
.lights i { width: 9px; height: 9px; border-radius: 50%; background: #ff5f57; }
.lights i:nth-child(2) { background: #febc2e; }
.lights i:nth-child(3) { background: #28c840; }
.phone { position: absolute; top: 150px; left: 950px; width: 196px; height: 440px; overflow: hidden; padding: 9px; border-radius: 40px; background: #0b0b0c; box-shadow: inset 0 0 0 1.5px oklch(1 0 0 / 0.18), 0 26px 60px oklch(0 0 0 / 0.6); }
.phone img { display: block; width: 100%; border-radius: 32px; }
.island { position: absolute; top: 17px; left: 50%; width: 56px; height: 16px; border-radius: 10px; background: #000; transform: translateX(-50%); }
</style></head><body>
<div class="brand"><img src="${icon}" alt="">Milagre</div>
<h1>Your agents keep working. <em>Answer them<br>from anywhere.</em></h1>
<p class="line">Claude Code, Codex, Antigravity and Kiro run on your Mac. Approve and reply from your phone.</p>
<div class="mac"><img src="${desktop}" alt=""><div class="lights"><i></i><i></i><i></i></div></div>
<div class="phone"><img src="${phone}" alt=""><div class="island"></div></div>
</body></html>`;
}

async function render() {
  const { app, BrowserWindow } = require("electron");
  app.commandLine.appendSwitch("force-device-scale-factor", String(SCALE));
  await app.whenReady();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-og-"));
  const page = path.join(tmp, "og.html");
  fs.writeFileSync(page, html(tmp));
  const window = new BrowserWindow({ width: 1200, height: 630, useContentSize: true, show: false });
  await window.loadFile(page);
  await window.webContents.executeJavaScript("document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 300)))");
  const big = path.join(tmp, "og-2x.png");
  fs.writeFileSync(big, (await window.webContents.capturePage()).toPNG());
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", big, "-vf", "scale=1200:630:flags=lanczos", out]);
  console.log(`wrote ${path.relative(root, out)}`);
  app.exit(0);
}

if (process.versions.electron) {
  render().catch((error) => {
    console.error(error);
    require("electron").app.exit(1);
  });
} else {
  const child = spawn(require("electron"), [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } });
  child.on("exit", (code) => process.exit(code ?? 1));
}
