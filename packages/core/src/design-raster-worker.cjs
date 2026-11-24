const fs = require("node:fs");
const { parentPort } = require("node:worker_threads");
const { withDesignHost } = require("./design-host-fonts.cjs");

const MAX_EDGE = 1568;
const MIN_EDGE = 512;
const MAX_UPSCALE = 4;
let ready;

async function load() {
  const [{ initWasm, Resvg }, design] = await Promise.all([import("@resvg/resvg-wasm"), import("@milagre/shared/design")]);
  const { designSvg, designFontBuffers, loadDesignFonts } = withDesignHost(design);
  await initWasm(fs.readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
  return { Resvg, designSvg, designFontBuffers, loadDesignFonts };
}

async function render(document, crop) {
  ready ??= load().catch((error) => {
    ready = undefined;
    throw error;
  });
  const { Resvg, designSvg, designFontBuffers, loadDesignFonts } = await ready;
  await loadDesignFonts(document);
  const fontBuffers = designFontBuffers(document).map((base64) => new Uint8Array(Buffer.from(base64, "base64")));
  const longest = Math.max(crop?.width ?? document.width, crop?.height ?? document.height);
  const scale = Math.min(MAX_EDGE / longest, Math.max(1, Math.min(MAX_UPSCALE, MIN_EDGE / longest)));
  let resvg;
  let rendered;
  try {
    const svg = designSvg(document, { embedFonts: false, onCanvasOnly: true });
    resvg = new Resvg(svg, {
      font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: "Inter", sansSerifFamily: "Inter" },
      fitTo: { mode: "zoom", value: crop ? Math.max(1, scale) : scale },
    });
    rendered = resvg.render();
    if (crop) {
      const pixels = Buffer.from(rendered.asPng()).toString("base64");
      rendered.free();
      rendered = undefined;
      resvg.free();
      resvg = undefined;
      const clipped = `<svg xmlns="http://www.w3.org/2000/svg" width="${crop.width}" height="${crop.height}" viewBox="${crop.x} ${crop.y} ${crop.width} ${crop.height}"><image width="${document.width}" height="${document.height}" href="data:image/png;base64,${pixels}"/></svg>`;
      resvg = new Resvg(clipped, { font: { loadSystemFonts: false }, fitTo: { mode: "zoom", value: scale } });
      rendered = resvg.render();
    }
    return { mime: "image/png", base64: Buffer.from(rendered.asPng()).toString("base64"), width: rendered.width, height: rendered.height };
  } finally {
    try {
      rendered?.free();
      resvg?.free();
    } catch {}
  }
}

async function shrink({ src, width, height }) {
  ready ??= load().catch((error) => {
    ready = undefined;
    throw error;
  });
  const { Resvg } = await ready;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" preserveAspectRatio="none" href="${src}"/></svg>`;
  let resvg;
  let rendered;
  try {
    resvg = new Resvg(svg, { font: { loadSystemFonts: false } });
    rendered = resvg.render();
    return { mime: "image/png", base64: Buffer.from(rendered.asPng()).toString("base64") };
  } finally {
    try {
      rendered?.free();
      resvg?.free();
    } catch {}
  }
}

parentPort.on("message", async ({ id, document, image, crop }) => {
  try {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker_threads port, not a window
    parentPort.postMessage({ id, result: image ? await shrink(image) : await render(document, crop) });
  } catch (error) {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker_threads port, not a window
    parentPort.postMessage({ id, error: error?.message ?? String(error) });
  }
});
