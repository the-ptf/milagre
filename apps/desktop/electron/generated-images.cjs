const fs = require("node:fs/promises");
const path = require("node:path");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function imageData(source) {
  const match = typeof source === "string" && /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(source);
  const kind = match ? match[1] : undefined;
  const data = match ? match[2] : undefined;
  return kind !== undefined && data !== undefined ? { extension: kind === "jpeg" ? "jpg" : kind, bytes: Buffer.from(data, "base64") } : null;
}

async function requireImage(file) {
  if (typeof file !== "string" || !path.isAbsolute(file) || !IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())) throw new Error("Not an image file.");
  const real = await fs.realpath(file);
  if (!IMAGE_EXTENSIONS.has(path.extname(real).toLowerCase()) || !(await fs.stat(real)).isFile()) throw new Error("Not an image file.");
  return real;
}

async function copyImage(file, { createFromPath, createFromBuffer, writeImage }) {
  const data = imageData(file);
  const image = data ? createFromBuffer(data.bytes) : createFromPath(await requireImage(file));
  if (image.isEmpty()) throw new Error("Couldn't read the image.");
  await writeImage(image);
}

async function saveImage(file, { showSaveDialog, downloads }, name = "Pasted image") {
  const data = imageData(file);
  const source = data ? "" : await requireImage(file);
  const extension = data ? data.extension : path.extname(source).slice(1).toLowerCase();
  const base = data ? `${path.basename(String(name)).replace(/\.[^.]*$/, "") || "Pasted image"}.${extension}` : path.basename(file);
  const { canceled, filePath } = await showSaveDialog({ defaultPath: path.join(downloads, base), filters: [{ name: "Image", extensions: [extension] }] });
  if (canceled || !filePath) return null;
  if (data) await fs.writeFile(filePath, data.bytes);
  else await fs.copyFile(source, filePath);
  return filePath;
}

module.exports = { copyImage, imageData, requireImage, saveImage };
