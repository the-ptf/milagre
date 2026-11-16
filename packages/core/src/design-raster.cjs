const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { designImageDocument } = require("@milagre/shared/design-preview");

const MAX_IMAGE_EDGE = 4096;
const defaults = { maxRenders: 50, idleMs: 60_000, timeoutMs: 10_000 };
let options = { ...defaults };
let worker;
let rendersOnWorker = 0;
let workersStarted = 0;
let idleTimer;
let queue = Promise.resolve();
let nextId = 0;

function imageSize(bytes) {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.subarray(12, 16).toString("latin1") === "IHDR")
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 30 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    const chunk = bytes.subarray(12, 16).toString("latin1");
    if (chunk === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (chunk === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = bytes.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    return null;
  }
  if (bytes.length >= 10 && bytes.subarray(0, 3).toString("latin1") === "GIF") return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      if (marker === 0xff) {
        offset++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
      offset += 2 + bytes.readUInt16BE(offset + 2);
    }
  }
  return null;
}

function oversized(src) {
  const comma = src.indexOf(",");
  const size = imageSize(Buffer.from(src.slice(comma + 1), "base64"));
  return !!size && (size.width > MAX_IMAGE_EDGE || size.height > MAX_IMAGE_EDGE);
}

function rasterDocument(document) {
  return designImageDocument(document, (src) => src.startsWith("data:") && !oversized(src));
}

function retire() {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  const ending = worker;
  worker = undefined;
  rendersOnWorker = 0;
  ending?.terminate().catch(() => {});
}

function start() {
  workersStarted++;
  const started = new Worker(path.join(__dirname, "design-raster-worker.cjs"));
  // Listeners for the worker's whole life, not just one render: an unhandled error from an idle worker would crash the
  started.on("error", () => {});
  started.on("exit", () => {
    if (worker !== started) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
    worker = undefined;
    rendersOnWorker = 0;
  });
  return started;
}

function post(request) {
  clearTimeout(idleTimer);
  worker ??= start();
  const current = worker;
  current.ref();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const settle = (finish) => {
      clearTimeout(timer);
      current.off("message", onMessage);
      current.off("error", onError);
      current.off("exit", onExit);
      finish();
    };
    const onMessage = (message) => {
      if (message.id !== id) return;
      if (message.error && worker === current) retire();
      settle(() => (message.error ? reject(new Error(message.error)) : resolve(message.result)));
    };
    const onError = (error) => {
      if (worker === current) retire();
      settle(() => reject(error));
    };
    const onExit = () => {
      if (worker === current) retire();
      settle(() => reject(new Error("The design renderer stopped.")));
    };
    const timer = setTimeout(() => {
      if (worker === current) retire();
      settle(() => reject(new Error("Rendering took too long")));
    }, options.timeoutMs);
    current.on("message", onMessage);
    current.on("error", onError);
    current.on("exit", onExit);
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker_threads port, not a window
    current.postMessage({ id, ...request });
  }).finally(() => {
    if (worker !== current) return;
    rendersOnWorker++;
    if (rendersOnWorker >= options.maxRenders) return retire();
    current.unref();
    idleTimer = setTimeout(retire, options.idleMs);
    idleTimer.unref();
  });
}

function renderDesignPng(document, { crop } = {}) {
  if (crop && (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.width <= 0 || crop.height <= 0))
    return Promise.reject(Error("Invalid preview crop."));
  const result = queue.then(() => post({ document: rasterDocument(document), crop }));
  queue = result.catch(() => {});
  return result;
}

function resizeImagePng(src, width, height) {
  const size = imageSize(Buffer.from(src.slice(src.indexOf(",") + 1), "base64"));
  if (!size) return Promise.reject(Error("The image size could not be read."));
  if (size.width > MAX_IMAGE_EDGE * 2 || size.height > MAX_IMAGE_EDGE * 2) return Promise.reject(Error("The image is too large to decode."));
  const result = queue.then(() => post({ image: { src, width, height } })).then(({ mime, base64 }) => `data:${mime};base64,${base64}`);
  queue = result.catch(() => {});
  return result;
}

const designRasterTesting = {
  configure: (next) => {
    options = { ...defaults, ...next };
  },
  workersStarted: () => workersStarted,
  worker: () => worker,
  retire,
};

module.exports = { renderDesignPng, resizeImagePng, imageSize, designRasterTesting };
