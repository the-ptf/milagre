const fs = require("node:fs");

// The agent's view of a design: the shared SVG, drawn by resvg in WebAssembly so it works on any daemon, headless too.
// resvg reads fonts from buffers, not @font-face, so the SVG is built without embedded fonts and Inter is passed in
// directly. Remote https images are not fetched and keep their placeholder.
const MAX_EDGE = 1568;
let ready;

async function load() {
  const [{ initWasm, Resvg }, { designSvg, designInterFonts }] = await Promise.all([import("@resvg/resvg-wasm"), import("@milagre/shared/design")]);
  await initWasm(fs.readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
  const fontBuffers = Object.values(designInterFonts).map((base64) => new Uint8Array(Buffer.from(base64, "base64")));
  return { Resvg, designSvg, fontBuffers };
}

async function renderDesignPng(document) {
  ready ??= load().catch((error) => {
    ready = undefined;
    throw error;
  });
  const { Resvg, designSvg, fontBuffers } = await ready;
  const scale = Math.min(1, MAX_EDGE / Math.max(document.width, document.height));
  const rendered = new Resvg(designSvg(document, { embedFonts: false }), {
    font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: "Inter", sansSerifFamily: "Inter" },
    fitTo: { mode: "zoom", value: scale },
  }).render();
  const result = { mime: "image/png", base64: Buffer.from(rendered.asPng()).toString("base64"), width: rendered.width, height: rendered.height };
  rendered.free?.();
  return result;
}

module.exports = { renderDesignPng };
