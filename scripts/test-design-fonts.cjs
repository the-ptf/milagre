// Inter renders from the embedded faces, with the advances designTextLayout assumes.
const assert = require("node:assert/strict");
const path = require("node:path");

async function check() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", path.join(require("node:os").tmpdir(), `milagre-design-fonts-${process.pid}`));
  await app.whenReady();
  const { designHtml, designTextLayout, validateDesignDocument } = await import("../packages/shared/src/design.mjs");
  const sample = "The quick brown fox jumps over the lazy dog. Reservations 0123456789 · Filter and sort — it’s “quoted” café € 5 → 6…";
  // 450 and 650 sit between measured weights: they must render with the face the layout measured, not CSS's heavier pick.
  const weights = [400, 450, 500, 600, 650, 700];
  const nodes = weights.map((fontWeight, index) => ({
    id: `w${fontWeight}`,
    type: "text",
    y: index * 40,
    width: 2000,
    height: 40,
    text: sample,
    fontSize: 16,
    fontWeight,
  }));
  const document = validateDesignDocument({ schemaVersion: 1, width: 2200, height: 400, nodes });
  const window = new BrowserWindow({ show: false, width: 2200, height: 400, webPreferences: { backgroundThrottling: false } });
  try {
    await window.loadURL(`data:text/html;base64,${Buffer.from(designHtml(document)).toString("base64")}`);
    await window.webContents.executeJavaScript("document.fonts.ready");
    // document.fonts.check() also passes when Inter is installed system-wide, so inspect the declared faces themselves.
    const faces = await window.webContents.executeJavaScript(
      `[...document.fonts].map((face) => ({ family: face.family.replace(/["']/g, ""), weight: face.weight, status: face.status }))`,
    );
    for (const node of nodes) {
      const covering = faces.filter((face) => {
        const [from, to = from] = face.weight.split(" ").map(Number);
        return face.family === "Inter" && node.fontWeight >= from && node.fontWeight <= to;
      });
      assert.equal(covering.length, 1, `exactly one embedded Inter face covers weight ${node.fontWeight}: ${JSON.stringify(faces)}`);
      assert.equal(covering[0].status, "loaded", `the Inter face for ${node.fontWeight} is loaded`);
      const rendered = await window.webContents.executeJavaScript(
        `(() => { const span = document.querySelector('[data-design-node="${node.id}"] span'); const range = document.createRange(); range.selectNodeContents(span); return range.getBoundingClientRect().width; })()`,
      );
      const measured = designTextLayout(node).width;
      const delta = Math.abs(rendered - measured) / measured;
      console.log(`Inter ${node.fontWeight}: rendered ${rendered.toFixed(3)}px, measured ${measured.toFixed(3)}px, delta ${(delta * 100).toFixed(3)}%`);
      assert.ok(delta < 0.005, `Inter ${node.fontWeight}: rendered ${rendered}px vs measured ${measured}px`);
    }
    console.log("PASS: embedded Inter renders at the measured widths");
  } finally {
    window.destroy();
    app.quit();
  }
}

function run() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawnSync(require("electron"), [__filename], { env, stdio: "inherit" });
  process.exitCode = child.status ?? 1;
}

if (process.versions.electron || require.main === module)
  (process.versions.electron ? check() : Promise.resolve(run())).catch((error) => {
    console.error(error);
    process.exit(1);
  });
