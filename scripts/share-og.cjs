// Rebuild the public snapshot link image: node scripts/share-og.cjs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

async function render() {
  const { app, BrowserWindow } = require("electron");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-share-og-"));
  app.setPath("userData", path.join(temporary, "profile"));
  await app.whenReady();
  try {
    const root = path.resolve(__dirname, "..");
    const icon = fs.readFileSync(path.join(root, "apps/site/public/app-icon-512.png")).toString("base64");
    const html = `<!doctype html><html><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{width:1200px;height:630px;margin:0;overflow:hidden}body{font-family:Arial,sans-serif;background:#0e1825;color:#edf3fa}.grid{position:absolute;inset:0;background-image:radial-gradient(#2b3c51 1px,transparent 1px);background-size:24px 24px;opacity:.5}.brand{position:absolute;top:54px;left:62px;display:flex;align-items:center;gap:16px;font-size:28px;font-weight:650}.brand img{width:52px;height:52px}h1{position:absolute;top:157px;left:62px;font-size:76px;letter-spacing:-4px;line-height:1.02;font-weight:620;margin:0}h1 span{color:#a9c7f1}.caption{position:absolute;left:66px;top:355px;font-size:23px;color:#a8b6c9;line-height:1.5}.url{position:absolute;bottom:50px;left:66px;color:#8ca4c0;font-size:18px}.card{position:absolute;width:315px;border:1px solid #435468;border-radius:20px;background:#1b293a;box-shadow:0 20px 60px #0005;overflow:hidden}.card header{padding:18px 22px;border-bottom:1px solid #435468;color:#c7d6e8;font-size:15px}.design{top:104px;left:680px;transform:rotate(-7deg);height:366px}.art{top:240px;left:856px;transform:rotate(8deg);height:318px}.mini{margin:20px;border-radius:12px;background:#e8ebdf;height:258px;padding:24px}.line{height:11px;border-radius:5px;background:#708b75;margin:12px 0;width:70%}.line.short{width:45%;background:#a0b19c}.tile{margin-top:22px;background:#c5d3b8;height:90px;border-radius:12px}.pill{height:28px;margin-top:17px;border-radius:20px;background:#48614c}.flow{margin:22px auto;display:flex;align-items:center;flex-direction:column;gap:16px}.node{width:134px;height:37px;border:1px solid #7094c3;border-radius:8px;background:#334965}.stem{height:20px;border-left:2px solid #7094c3;margin-top:-16px;margin-bottom:-16px}.diamond{width:42px;height:42px;transform:rotate(45deg);border:1px solid #8c9cd2;background:#414867;margin:8px}.branches{display:flex;gap:20px}.branches .node{width:90px;background:#2e4c4b;border-color:#759f95}</style><body><div class="grid"></div><div class="brand"><img src="data:image/png;base64,${icon}" alt="">Milagre</div><h1>Shared with<br><span>Milagre.</span></h1><div class="caption">Designs and interactive Artifacts.<br>One link to see the idea.</div><div class="url">share.milagre.cloud</div><div class="card design"><header>Designs</header><div class="mini"><div class="line"></div><div class="line short"></div><div class="tile"></div><div class="pill"></div></div></div><div class="card art"><header>Artifact</header><div class="flow"><div class="node"></div><div class="stem"></div><div class="diamond"></div><div class="stem"></div><div class="branches"><div class="node"></div><div class="node"></div></div></div></div></body></html>`;
    const file = path.join(temporary, "index.html");
    fs.writeFileSync(file, html);
    const window = new BrowserWindow({
      width: 1200,
      height: 630,
      useContentSize: true,
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    await window.loadFile(file);
    await window.webContents.executeJavaScript("Promise.all([document.fonts.ready,...[...document.images].map(image=>image.decode())])");
    const output = path.join(root, "apps/design-share/assets/og.png");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, (await window.webContents.capturePage()).resize({ width: 1200, height: 630, quality: "best" }).toPNG());
    window.destroy();
    console.log(`Wrote ${output}`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    app.quit();
  }
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
