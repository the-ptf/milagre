// Actual Node WASM renderer, isolated worker only. No files/profiles/servers touched.
const { renderDesignPng, resizeImagePng, imageSize, designRasterTesting } = require("../../../packages/core/src/design-raster.cjs");
const { createHash } = require("node:crypto");
async function main() {
  const { validateDesignDocument } = await import("../../../packages/shared/src/design.mjs");
  const { DESIGN_FONT_CATALOG } = await import("../../../packages/shared/src/design-font-catalog.mjs");
  const document = (nodes, extra = {}) => ({ schemaVersion: 1, width: 300, height: 240, background: "#fcfcff", nodes, ...extra });
  const text = { id: "label", type: "text", x: 12, y: 14, width: 270, height: 140, text: "Milagre 123\nCafé & symbols", fill: "#24273a", fontSize: 20 };
  const cases = [
    { name: "empty", document: document([]) },
    { name: "text-default", document: document([text]) },
    { name: "scaled", document: document([{ ...text, width: 1800, height: 400, fontSize: 90 }], { width: 2400, height: 800 }) },
    {
      name: "paint",
      document: document([
        { id: "frame", type: "frame", x: 5, y: 10, width: 180, height: 130, fill: "#f5a97f", stroke: "#24273a", strokeWidth: 3, radius: 16, opacity: 0.8 },
        { id: "ellipse", type: "ellipse", parentId: "frame", x: 40, y: 15, width: 100, height: 100, fill: "#a6da95" },
        { id: "icon", type: "icon", x: 210, y: 20, width: 48, height: 48, icon: "check", fill: "#ed8796" },
        text,
      ]),
    },
    { name: "crop", document: document([text]), crop: { x: 10, y: 10, width: 140, height: 100 } },
    { name: "crop-negative", document: document([text]), crop: { x: -20, y: -10, width: 360, height: 210 } },
    { name: "crop-scale", document: document([text]), crop: { x: 0, y: 0, width: 1800, height: 600 } },
    {
      name: "remote-placeholder",
      document: document([{ id: "image", type: "image", width: 100, height: 100, src: "https://example.invalid/never-fetch.png", fill: "red" }]),
    },
    { name: "crop-invalid", document: document([text]), crop: { x: 0, y: 0, width: 0, height: 1 } },
  ];
  for (const font of Object.values(DESIGN_FONT_CATALOG))
    cases.push({ name: `font-${font.family}`, document: document([{ ...text, fontFamily: font.family }]) });
  const tiny = await renderDesignPng(validateDesignDocument(document([], { width: 240, height: 240, background: "#f5a97f" })));
  const src = `data:image/png;base64,${tiny.base64}`;
  cases.push({ name: "inline-png", document: document([{ id: "image", type: "image", width: 100, height: 70, src }]) });
  const huge = Buffer.from(tiny.base64, "base64");
  huge.writeUInt32BE(9000, 16);
  cases.push({
    name: "huge-placeholder",
    document: document([{ id: "image", type: "image", width: 100, height: 70, src: `data:image/png;base64,${huge.toString("base64")}` }]),
  });
  cases.push({ name: "resize", image: { src, width: 36, height: 24 } });
  cases.push({ name: "resize-too-large", image: { src: `data:image/png;base64,${huge.toString("base64")}`, width: 36, height: 24 } });
  for (const item of cases) {
    try {
      if (item.image) {
        const url = await resizeImagePng(item.image.src, item.image.width, item.image.height);
        item.result = { mime: "image/png", base64: url.split(",")[1] };
      } else item.result = await renderDesignPng(validateDesignDocument(item.document), { crop: item.crop });
    } catch (error) {
      item.error = error.message;
    }
  }
  const headers = [];
  for (const length of [0, 3, 9, 10, 23, 24, 29, 30, 80]) {
    for (const format of ["png", "gif", "jpeg", "vp8x", "vp8", "vp8l", "unknown"]) {
      const b = Buffer.alloc(80);
      if (format === "png") {
        b.writeUInt32BE(0x89504e47);
        b.write("IHDR", 12);
        b.writeUInt32BE(4096, 16);
        b.writeUInt32BE(4097, 20);
      }
      if (format === "gif") {
        b.write("GIF89a");
        b.writeUInt16LE(31, 6);
        b.writeUInt16LE(72, 8);
      }
      if (format === "jpeg") {
        b[0] = 255;
        b[1] = 216;
        b[2] = 255;
        b[3] = 192;
        b.writeUInt16BE(42, 7);
        b.writeUInt16BE(31, 9);
      }
      if (format.startsWith("vp8")) {
        b.write("RIFF");
        b.write("WEBP", 8);
        b.write({ vp8x: "VP8X", vp8: "VP8 ", vp8l: "VP8L" }[format], 12);
        b.writeUInt32LE(125000, 21);
        b.writeUIntLE(42, 24, 3);
        b.writeUIntLE(52, 27, 3);
      }
      const bytes = b.subarray(0, length);
      headers.push({ bytes: bytes.toString("base64"), result: imageSize(bytes) });
    }
  }
  process.stdout.write(
    JSON.stringify({
      cases,
      headers,
      source: createHash("sha256")
        .update(require("node:fs").readFileSync(require.resolve("../../../packages/core/src/design-raster.cjs")))
        .digest("hex"),
    }),
  );
}
main()
  .finally(() => designRasterTesting.retire())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
