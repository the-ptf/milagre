// Writes the sidebar's film grain: assets/grain/grain-light.png (white specks, drawn over the dark theme) and
// assets/grain/grain-dark.png (black specks, over the light theme). Each is 256 x 256 px of per-pixel noise, drawn
// as a 128pt tile, so one speck is one device pixel on a Retina display. The strength is in the alpha: 0 to
// MAX_ALPHA of 255 (mean about 3.5 %), matched against the reference video. Deterministic: run it again and
// the files do not change. Then run tools/gen-icons.mjs so src/assets/embedded.rs lists them.
//
//   node tools/gen-grain.mjs

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const SIZE = 256;
const MAX_ALPHA = 18;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

function png(value, seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 8) / 0x1000000;
  };
  // Grey + alpha, 8 bits each; every row starts with filter byte 0.
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 2));
  for (let y = 0; y < SIZE; y++) {
    const row = y * (1 + SIZE * 2);
    for (let x = 0; x < SIZE; x++) {
      raw[row + 1 + x * 2] = value;
      raw[row + 2 + x * 2] = Math.round(next() * MAX_ALPHA);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 4; // grey + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

writeFileSync(join(root, "assets/grain/grain-light.png"), png(255, 0x9e3779b9));
writeFileSync(join(root, "assets/grain/grain-dark.png"), png(0, 0x9e3779b9));
