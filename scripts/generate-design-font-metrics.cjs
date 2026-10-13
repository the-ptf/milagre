// Regenerate the small, fixed metric table used for design wrapping. Requires the named fonts on this computer.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function measureFonts() {
  const context = document.createElement("canvas").getContext("2d");
  context.fontKerning = "none";
  const result = {};
  for (const [name, family] of Object.entries({ sans: "Arial", serif: "Georgia", times: "Times New Roman", mono: "Courier New" })) {
    result[name] = {};
    for (const weight of [400, 700]) {
      context.font = `${weight} 1000px "${family}"`;
      result[name][weight] = Array.from({ length: 95 }, (_, index) => Math.round(context.measureText(String.fromCharCode(32 + index)).width) / 1000);
    }
  }
  return result;
}

async function main() {
  if (!process.versions.electron) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require("node:child_process").spawnSync(require("electron"), [__filename], { env, stdio: "inherit" });
    process.exitCode = child.status ?? 1;
    return;
  }
  const { app, BrowserWindow } = require("electron");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-font-metrics-"));
  app.setPath("userData", temporary);
  try {
    await app.whenReady();
    const window = new BrowserWindow({ show: false });
    await window.loadURL("about:blank");
    const metrics = await window.webContents.executeJavaScript(`(${measureFonts.toString()})()`);
    const file = path.resolve(__dirname, "../packages/shared/src/design-font-metrics.mjs");
    fs.writeFileSync(
      file,
      `// Advance widths measured at 1000px with kerning disabled. Regenerate: node scripts/generate-design-font-metrics.cjs\nexport const designFontMetrics = ${JSON.stringify(metrics)};\n`,
    );
    window.destroy();
    app.quit();
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
