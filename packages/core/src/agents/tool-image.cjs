const { createHash } = require("node:crypto");
const { mkdirSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { decodeImages } = require("../image-input.cjs");

// Store returned bytes, never the source file a tool happened to read. Signature validation does
// not promise that a client can decode the image; clients still need a load-failure state.
function saveToolImage(dataUrl, directory = path.join(os.tmpdir(), "milagre-generated-images")) {
  const [{ bytes, mime }] = decodeImages([{ dataUrl }]);
  const hash = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${hash}.${mime === "image/jpeg" ? "jpg" : mime.slice(6)}`);
  writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}

module.exports = { saveToolImage };
