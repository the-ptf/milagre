const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { renderDesignPng, designRasterTesting } = require("./design-raster.cjs");

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

// The rightmost painted column in a band of rows, or -1.
function rightmostPainted(image, { y, height }) {
  let right = -1;
  for (let row = y; row < y + height; row++) {
    for (let column = 0; column < image.width; column++) {
      const at = (row * image.width + column) * image.channels;
      if ((image.pixels[at] < 200 || image.pixels[at + 1] < 200 || image.pixels[at + 2] < 200) && column > right) right = column;
    }
  }
  return right;
}

const weightPng = async (fontWeight) =>
  (
    await renderDesignPng(
      phone([{ id: "title", type: "text", x: 16, y: 60, width: 340, height: 40, text: "Weekly summary 2026", fontSize: 24, fontWeight, fill: "#111111" }]),
    )
  ).base64;

test("each measured Inter weight draws with its own face", async () => {
  const { createHash } = require("node:crypto");
  const hashes = [];
  for (const fontWeight of [400, 500, 600, 700]) {
    const png = await renderDesignPng(
      phone([{ id: "title", type: "text", x: 16, y: 60, width: 340, height: 40, text: "Weekly summary 2026", fontSize: 24, fontWeight, fill: "#111111" }]),
    );
    hashes.push(createHash("sha256").update(png.base64).digest("hex"));
  }
  assert.equal(new Set(hashes).size, 4, "400, 500, 600 and 700 each render differently");
  // In-between weights draw with the face the layout measured.
  assert.ok((await weightPng(650)) === (await weightPng(600)), "650 draws as 600");
  assert.ok((await weightPng(450)) === (await weightPng(400)), "450 draws as 400");
});

test("a 22/600 hug title is not clipped by its own box", async () => {
  const { designLayout, validateDesignDocument } = await import("@milagre/shared/design");
  const document = phone([
    {
      id: "title",
      type: "text",
      x: 16,
      y: 60,
      width: 10,
      height: 30,
      widthMode: "hug",
      heightMode: "hug",
      text: "Weekly summary",
      fontSize: 22,
      fontWeight: 600,
      fill: "#111111",
    },
  ]);
  const box = designLayout(validateDesignDocument(document)).get("title");
  const image = decode((await renderDesignPng(document)).base64);
  const right = rightmostPainted(image, { y: Math.floor(box.y), height: Math.ceil(box.height) });
  assert.ok(right > box.x + box.width / 2, "the title is drawn");
  assert.ok(right < Math.floor(box.x + box.width), `glyphs end at ${right}, inside the box's right edge ${box.x + box.width}`);
  // The same title in a wide box ends at the same column, so nothing was cut.
  const wide = decode((await renderDesignPng(phone([{ ...document.nodes[0], widthMode: "fixed", width: 340 }]))).base64);
  assert.equal(rightmostPainted(wide, { y: Math.floor(box.y), height: Math.ceil(box.height) }), right);
});

const pixelAt = (image, x, y) => [...image.pixels.subarray((y * image.width + x) * image.channels, (y * image.width + x) * image.channels + 3)];

// A real PNG of the given size, one black pixel row repeated, so resvg would decode and draw it.
function blackPng(width, height) {
  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), body])));
    return Buffer.concat([length, Buffer.from(type), body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  return `data:image/png;base64,${Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64")}`;
}

test("a remote image paints the grey placeholder, not a blank", async () => {
  const image = decode(
    (
      await renderDesignPng(
        phone([{ id: "hero", type: "image", x: 20, y: 100, width: 200, height: 120, src: "https://example.com/hero.png", fill: "transparent" }]),
      )
    ).base64,
  );
  assert.deepEqual(pixelAt(image, 120, 160), [0xd8, 0xde, 0xd8]);
});

test("an inline image drawn by resvg, but one past 4096 px on a side, is a placeholder", async () => {
  const small = decode((await renderDesignPng(phone([{ id: "photo", type: "image", x: 20, y: 100, width: 100, height: 100, src: blackPng(8, 8) }]))).base64);
  assert.deepEqual(pixelAt(small, 70, 150), [0, 0, 0]);
  const huge = decode((await renderDesignPng(phone([{ id: "photo", type: "image", x: 20, y: 100, width: 100, height: 100, src: blackPng(5000, 2) }]))).base64);
  assert.deepEqual(pixelAt(huge, 70, 150), [0xd8, 0xde, 0xd8]);
});

test("concurrent renders all resolve, in order", async () => {
  const documents = Array.from({ length: 6 }, (_, index) =>
    phone([{ id: "box", type: "rectangle", x: 0, y: 0, width: 10 + index * 10, height: 10, fill: "#000000" }]),
  );
  const images = await Promise.all(documents.map((document) => renderDesignPng(document)));
  assert.equal(images.length, 6);
  images.forEach((png, index) => {
    const image = decode(png.base64);
    assert.deepEqual(pixelAt(image, 5 + index * 10, 5), [0, 0, 0]);
    assert.deepEqual(pixelAt(image, 15 + index * 10, 5), [255, 255, 255]);
  });
});

test("the worker is recycled after its render quota and when idle, and a slow render is cut off", async (t) => {
  t.after(() => {
    designRasterTesting.configure({});
    designRasterTesting.retire();
  });
  const document = phone([{ id: "box", type: "rectangle", x: 0, y: 0, width: 10, height: 10, fill: "#000000" }]);
  designRasterTesting.retire();
  designRasterTesting.configure({ maxRenders: 2 });
  let before = designRasterTesting.workersStarted();
  for (let index = 0; index < 5; index++) await renderDesignPng(document);
  assert.equal(designRasterTesting.workersStarted() - before, 3, "five renders at two per worker need three workers");

  designRasterTesting.retire();
  designRasterTesting.configure({ idleMs: 20 });
  before = designRasterTesting.workersStarted();
  await renderDesignPng(document);
  await renderDesignPng(document);
  assert.equal(designRasterTesting.workersStarted() - before, 1, "back-to-back renders share a worker");
  await new Promise((resolve) => setTimeout(resolve, 80));
  await renderDesignPng(document);
  assert.equal(designRasterTesting.workersStarted() - before, 2, "an idle worker is ended");

  designRasterTesting.configure({ timeoutMs: 1 });
  await assert.rejects(renderDesignPng(document), /Rendering took too long/);
  designRasterTesting.configure({});
  assert.equal((await renderDesignPng(document)).mime, "image/png", "the next render starts a fresh worker");
});

test("layers wholly off the screen are left out instead of crashing resvg", async () => {
  const document = phone([
    { id: "seen", type: "rectangle", x: 0, y: 0, width: 20, height: 20, fill: "#000000" },
    { id: "right", type: "rectangle", x: 1000, y: 10, width: 40, height: 8, fill: "#ff0000", opacity: 0.5 },
    { id: "below", type: "text", x: 10, y: 3000, width: 40, height: 20, text: "Gone" },
    { id: "card", type: "frame", x: 300, y: 100, width: 200, height: 100, fill: "#ffffff" },
    { id: "inside", parentId: "card", type: "icon", icon: "x", x: 900, y: 120, width: 24, height: 24 },
  ]);
  const image = decode((await renderDesignPng(document)).base64);
  assert.deepEqual(pixelAt(image, 10, 10), [0, 0, 0]);
  assert.equal((await renderDesignPng(phone([]))).mime, "image/png");
});

test("a failed render ends its worker so the next render starts clean", async () => {
  designRasterTesting.retire();
  const before = designRasterTesting.workersStarted();
  await assert.rejects(renderDesignPng({ schemaVersion: 1, width: 390, height: 844, nodes: [{ id: "bad", type: "nope" }] }));
  assert.equal((await renderDesignPng(phone([]))).mime, "image/png");
  assert.equal(designRasterTesting.workersStarted() - before, 2);
});
