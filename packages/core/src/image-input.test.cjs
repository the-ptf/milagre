const test = require("node:test");
const assert = require("node:assert/strict");
const { decodeImages } = require("./image-input.cjs");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
const image = { id: "one", name: "pasted.png", dataUrl: `data:image/png;base64,${png}` };

test("validates pasted images without a count cap and rejects unsupported or oversized images", () => {
  assert.equal(decodeImages([image])[0].mime, "image/png");
  assert.equal(decodeImages(Array.from({ length: 120 }, () => ({ ...image }))).length, 120);
  assert.throws(() => decodeImages([{ dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }]), /PNG/);
  assert.throws(() => decodeImages([{ dataUrl: "data:image/png;base64,aGVsbG8=" }]), /valid supported image/);
  assert.throws(() => decodeImages([{ dataUrl: "x".repeat(71 * 1024 * 1024) }]), /50 MiB/);
});
