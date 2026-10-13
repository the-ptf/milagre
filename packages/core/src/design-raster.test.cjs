const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { renderDesignPng } = require("./design-raster.cjs");

const phone = (nodes, extra = {}) => ({ schemaVersion: 1, width: 390, height: 844, background: "#ffffff", nodes, ...extra });

// Decodes an 8-bit RGB/RGBA non-interlaced PNG into rows of pixel bytes; enough to count painted pixels.
function decode(base64) {
  const bytes = Buffer.from(base64, "base64");
  let offset = 8;
  let header;
  const data = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString();
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9] };
    if (type === "IDAT") data.push(body);
    offset += 12 + length;
  }
  assert.equal(header.depth, 8);
  const channels = { 2: 3, 6: 4 }[header.color];
  assert.ok(channels, `unsupported PNG color type ${header.color}`);
  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = header.width * channels;
  const pixels = Buffer.alloc(stride * header.height);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x];
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[y * stride + x] = (value + predictor) & 255;
    }
  }
  return { ...header, channels, pixels };
}

function nonWhiteIn(image, { x, y, width, height }) {
  let count = 0;
  for (let row = y; row < y + height; row++) {
    for (let column = x; column < x + width; column++) {
      const at = (row * image.width + column) * image.channels;
      if (image.pixels[at] < 200 || image.pixels[at + 1] < 200 || image.pixels[at + 2] < 200) count++;
    }
  }
  return count;
}

test("a phone design renders to a 1x PNG with Inter text and icons", async () => {
  const png = await renderDesignPng(
    phone([
      { id: "title", type: "text", x: 16, y: 60, width: 300, height: 40, text: "Filter and sort", fontSize: 24, fontWeight: 600, fill: "#111111" },
      { id: "close", type: "icon", icon: "x", x: 340, y: 64, width: 24, height: 24, fill: "#111111" },
    ]),
  );
  assert.equal(png.mime, "image/png");
  assert.deepEqual([png.width, png.height], [390, 844]);
  const bytes = Buffer.from(png.base64, "base64");
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  assert.ok(bytes.length > 2000, "text and icon pixels were drawn");
});

test("large canvases are scaled to 1568px on the long edge", async () => {
  const png = await renderDesignPng({ schemaVersion: 1, width: 3840, height: 2160, nodes: [] });
  assert.deepEqual([png.width, png.height], [1568, 882]);
});

test("an Inter 600 title and a token-coloured icon paint visible pixels", async () => {
  const document = phone(
    [
      { id: "title", type: "text", x: 16, y: 60, width: 300, height: 40, text: "Filter and sort", fontSize: 24, fontWeight: 600, fill: "$ink" },
      { id: "close", type: "icon", icon: "x", x: 340, y: 64, width: 24, height: 24, fill: "$ink" },
    ],
    { tokens: { ink: "#111111" } },
  );
  const image = decode((await renderDesignPng(document)).base64);
  assert.ok(nonWhiteIn(image, { x: 16, y: 60, width: 300, height: 40 }) > 150, "the Inter title is drawn");
  assert.ok(nonWhiteIn(image, { x: 340, y: 64, width: 24, height: 24 }) > 20, "the $token icon is drawn");
  const blank = decode((await renderDesignPng(phone([]))).base64);
  assert.equal(nonWhiteIn(blank, { x: 0, y: 0, width: 390, height: 844 }), 0);
});
