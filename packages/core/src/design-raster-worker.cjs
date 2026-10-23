const fs = require("node:fs");
const { parentPort } = require("node:worker_threads");

// Draws one design at a time for design-raster.cjs. Only this thread loads the WebAssembly, so ending the thread
// returns its memory to the operating system.
const MAX_EDGE = 1568;
let ready;

async function load() {
  const [{ initWasm, Resvg }, { designSvg, designFontBuffers, loadDesignFonts }] = await Promise.all([
    import("@resvg/resvg-wasm"),
    import("@milagre/shared/design"),
  ]);
  await initWasm(fs.readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
  return { Resvg, designSvg, designFontBuffers, loadDesignFonts };
}

async function render(document) {
  ready ??= load().catch((error) => {
    ready = undefined;
    throw error;
  });
  const { Resvg, designSvg, designFontBuffers, loadDesignFonts } = await ready;
  // Inter, plus the catalog families this design names.
  await loadDesignFonts(document);
  const fontBuffers = designFontBuffers(document).map((base64) => new Uint8Array(Buffer.from(base64, "base64")));
  const scale = Math.min(1, MAX_EDGE / Math.max(document.width, document.height));
  let resvg;
  let rendered;
  try {
    resvg = new Resvg(designSvg(document, { embedFonts: false, onCanvasOnly: true }), {
      font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: "Inter", sansSerifFamily: "Inter" },
      fitTo: { mode: "zoom", value: scale },
    });
    rendered = resvg.render();
    return { mime: "image/png", base64: Buffer.from(rendered.asPng()).toString("base64"), width: rendered.width, height: rendered.height };
  } finally {
    // After a panic resvg refuses to free its objects; the worker is replaced then, so the original error is what matters.
    try {
      rendered?.free();
      resvg?.free();
    } catch {}
  }
}

/** Redraws one raster image at width x height and returns it as a PNG, for images too large to embed as they are. */
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

parentPort.on("message", async ({ id, document, image }) => {
  try {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker_threads port, not a window
    parentPort.postMessage({ id, result: image ? await shrink(image) : await render(document) });
  } catch (error) {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker_threads port, not a window
    parentPort.postMessage({ id, error: error?.message ?? String(error) });
  }
});
