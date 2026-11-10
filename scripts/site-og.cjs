// Renders apps/site/public/og.png (1200 × 630) on Dawn's day sky, with the real demo recordings at the approval moment,
// so the link preview matches the page. Run after re-recording: node scripts/site-og.cjs
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

// The logo's legs and sparkle (StartupSplash), drawn as the landing hero draws them on Dawn's day sky.
const LEFT =
  "M49.6983 66.5562L21.6836 116.174C19.802 119.507 22.2098 123.632 26.0372 123.632H39.9727L54.9727 100.132L66.9727 119.632L51.9727 144.132H26.0372C6.24066 144.132 -6.29344 122.89 3.27837 105.561L30.9405 55.4819L49.6983 66.5562Z";
const RIGHT =
  "M142.666 105.561C152.238 122.89 139.704 144.132 119.907 144.132H93.9728L78.9728 119.632L90.9728 100.132L105.973 123.632H119.907C123.735 123.632 126.143 119.507 124.261 116.174L96.2462 66.5562L115.004 55.4819L142.666 105.561Z";
const STAR =
  "M69.528 1.96636C71.0759 -0.655453 74.869 -0.655453 76.4169 1.96636L91.0103 26.6837C91.3538 27.2656 91.8392 27.751 92.4211 28.0945L117.138 42.6879C119.76 44.2358 119.76 48.0289 117.138 49.5768L92.4211 64.1702C91.8392 64.5137 91.3538 64.9991 91.0103 65.581L76.4169 90.2983C74.869 92.9201 71.0759 92.9201 69.528 90.2983L54.9347 65.581C54.5911 64.9991 54.1057 64.5137 53.5238 64.1702L28.8065 49.5768C26.1847 48.0289 26.1847 44.2358 28.8065 42.6879L53.5238 28.0945C54.1057 27.751 54.5911 27.2656 54.9347 26.6837L69.528 1.96636Z";

// Soft clouds along the bottom, from the same seeded banks the hero uses (apps/site/src/dawn.ts), drawn for 1200 wide.
function clouds() {
  let seed = 0;
  const random = () => {
    seed = (Math.imul(seed ^ (seed >>> 15), seed | 1) + 0x6d2b79f5) | 0;
    return (seed >>> 0) / 4294967296;
  };
  const bank = (start, count, top, bottom, scale, shade, filter) => {
    seed = start;
    let back = "";
    let face = "";
    for (let index = 0; index < count; index++) {
      const x = (index / (count - 1)) * 1440 - 120 + (random() - 0.5) * 96;
      const y = top + (bottom - top) * random();
      const rx = (1200 * 0.09 + random() * 1200 * 0.12) * scale;
      const ry = rx * (0.42 + random() * 0.2);
      back += `<ellipse cx="${x}" cy="${y + ry * 0.35}" rx="${rx}" ry="${ry}"/>`;
      face += `<ellipse cx="${x - rx * 0.08}" cy="${y}" rx="${rx * 0.92}" ry="${ry * 0.9}"/>`;
    }
    return `<g filter="url(#${filter})"><g fill="${shade}">${back}</g><g fill="#fffaf0">${face}<rect x="-60" y="${bottom}" width="1320" height="400"/></g></g>`;
  };
  return `<svg class="clouds" viewBox="0 0 1200 630" preserveAspectRatio="none">
<filter id="cloudy" x="-50%" y="-80%" width="200%" height="260%"><feTurbulence type="fractalNoise" baseFrequency="0.011" numOctaves="4" seed="7" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="70" xChannelSelector="R" yChannelSelector="G"/><feGaussianBlur stdDeviation="5"/></filter>
<filter id="soft" x="-50%" y="-80%" width="200%" height="260%"><feTurbulence type="fractalNoise" baseFrequency="0.008" numOctaves="3" seed="3" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="90" xChannelSelector="R" yChannelSelector="G"/><feGaussianBlur stdDeviation="14"/></filter>
${bank(4, 9, 520, 580, 0.55, "#ebe3f1", "soft")}${bank(9, 10, 560, 612, 0.5, "#f3e9e2", "cloudy")}</svg>`;
}

function html(tmp) {
  const desktop = frame("desktop.mp4", path.join(tmp, "desktop.png"));
  const phone = frame("phone.mp4", path.join(tmp, "phone.png"));
  const geist = font("@fontsource-variable/geist/files/geist-latin-wght-normal.woff2");
  const serif = font("@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Geist; src: url(${geist}) format("woff2"); font-weight: 100 900; }
@font-face { font-family: Serif; src: url(${serif}) format("woff2"); font-style: italic; }
* { box-sizing: border-box; margin: 0; }
html, body { width: 1200px; height: 630px; overflow: hidden; }
/* Dawn's day frame, as the landing hero ends on it. */
body { position: relative; background: linear-gradient(#c3dbf3 0%, #e9f0f8 36%, #fff2dd 72%, #fffaf0 100%); color: #2a2116; font-family: Geist, sans-serif; }
.halo { position: absolute; left: 92px; top: 82px; width: 560px; height: 560px; translate: -50% -50%; border-radius: 50%; background: radial-gradient(circle, rgb(255 244 212 / 0.95) 0, rgb(255 226 160 / 0.55) 22%, rgb(255 214 140 / 0.18) 45%, transparent 68%); }
.rays { position: absolute; left: 92px; top: 82px; width: 1900px; height: 1900px; translate: -50% -50%; border-radius: 50%; background: repeating-conic-gradient(from 0deg, rgb(255 236 190 / 0) 0deg, rgb(255 236 190 / 0.34) 4deg, rgb(255 236 190 / 0) 9deg, rgb(255 236 190 / 0) 17deg); mask: radial-gradient(circle, #000 0, rgb(0 0 0 / 0.6) 18%, transparent 52%); }
.brand { position: absolute; top: 56px; left: 64px; display: flex; align-items: center; gap: 14px; font-size: 30px; font-weight: 600; letter-spacing: -0.01em; }
.mark { width: 56px; height: 56px; overflow: visible; fill: #fff; filter: drop-shadow(0 1px 1.5px rgb(140 90 20 / 0.55)) drop-shadow(0 2px 12px rgb(214 160 60 / 0.7)); }
.mark .star { filter: drop-shadow(0 0 6px #fff3cf) drop-shadow(0 0 14px rgb(255 200 110 / 0.95)); }
h1 { position: absolute; top: 168px; left: 64px; width: 520px; font-size: 52px; font-weight: 600; line-height: 1.04; letter-spacing: -0.035em; }
h1 em { display: block; margin-top: 8px; font-family: Serif, serif; font-weight: 400; font-size: 56px; line-height: 1.02; letter-spacing: -0.01em; color: #8a6324; }
.line { position: absolute; z-index: 3; left: 64px; bottom: 46px; width: 470px; font-size: 20px; line-height: 1.4; color: #5f513d; }
.mac { position: absolute; top: 108px; left: 600px; width: 720px; aspect-ratio: 16 / 10; border-radius: 14px; overflow: hidden; box-shadow: 0 0 0 1px rgb(30 30 60 / 0.18), 0 30px 80px rgb(40 30 70 / 0.3); }
.mac img { display: block; width: 100%; }
.lights { position: absolute; top: 8px; left: 14px; display: flex; gap: 4.5px; }
.lights i { width: 7px; height: 7px; border-radius: 50%; background: #ff5f57; }
.lights i:nth-child(2) { background: #febc2e; }
.lights i:nth-child(3) { background: #28c840; }
.phone { position: absolute; top: 150px; left: 950px; width: 196px; height: 440px; overflow: hidden; padding: 9px; border-radius: 40px; background: #0b0b0c; box-shadow: inset 0 0 0 1.5px rgb(255 255 255 / 0.18), 0 26px 60px rgb(40 30 70 / 0.35); }
.phone img { display: block; width: 100%; border-radius: 32px; }
.island { position: absolute; top: 17px; left: 50%; width: 56px; height: 16px; border-radius: 10px; background: #000; transform: translateX(-50%); }
.clouds { position: absolute; inset: 0; z-index: 2; width: 100%; height: 100%; }
</style></head><body>
<div class="rays"></div><div class="halo"></div>
<div class="brand"><svg class="mark" viewBox="-4 -4 154 154"><path d="${LEFT}"/><path d="${RIGHT}"/><path class="star" d="${STAR}"/></svg>Milagre</div>
<h1>Your agents keep working. <em>Answer them<br>from anywhere.</em></h1>
<div class="mac"><img src="${desktop}" alt=""><div class="lights"><i></i><i></i><i></i></div></div>
<div class="phone"><img src="${phone}" alt=""><div class="island"></div></div>
${clouds()}
<p class="line">Claude Code, Codex, Antigravity and Kiro run on your computer. Approve and reply from your phone.</p>
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
