const path = require("node:path");
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { Readable } = require("node:stream");
const { pathToFileURL } = require("node:url");
const EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp", ".svg", ".mp4", ".mov", ".webm", ".m4v", ".ogv"]);

// cannot expose another kind of file. Electron file fetch ignores Range, so stream those ranges here.
function createMediaHandler(fetch) {
  return async (request) => {
    try {
      const url = new URL(request.url);
      const file = url.searchParams.get("path");
      if (
        request.method !== "GET" ||
        url.protocol !== "milagre-media:" ||
        url.host !== "file" ||
        url.pathname !== "/" ||
        !file ||
        !path.isAbsolute(file) ||
        !EXTENSIONS.has(path.extname(file).toLowerCase())
      )
        return new Response(null, { status: 404 });
      const real = await fs.realpath(file);
      const ext = path.extname(real).toLowerCase();
      const stat = await fs.stat(real);
      if (!EXTENSIONS.has(ext) || !stat.isFile()) return new Response(null, { status: 404 });
      const range = request.headers.get("range");
      if (!range) return await fetch(pathToFileURL(real).href);
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const invalid = () => new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
      if (!match || (!match[1] && !match[2])) return invalid();
      const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
      const end = match[1] && match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) return invalid();
      const types = {
        ".mp4": "video/mp4",
        ".m4v": "video/mp4",
        ".mov": "video/quicktime",
        ".webm": "video/webm",
        ".ogv": "video/ogg",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".svg": "image/svg+xml",
      };
      return new Response(/** @type {ReadableStream<Uint8Array>} */ (/** @type {unknown} */ (Readable.toWeb(createReadStream(real, { start, end })))), {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          "Content-Type": types[ext] || `image/${ext.slice(1)}`,
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  };
}
module.exports = { createMediaHandler };
