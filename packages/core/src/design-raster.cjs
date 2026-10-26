const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { designImageDocument } = require("@milagre/shared/design-preview");

// The agent's view of a design: the shared SVG, drawn by resvg in WebAssembly so it works on any daemon, headless too.
// resvg reads fonts from buffers, not @font-face, so the SVG is built without embedded fonts and Inter, plus the catalog
// families the design names, is passed in directly. Drawing runs on a worker thread (design-raster-worker.cjs) so a large design never blocks the daemon, and
// the worker is ended now and then so the WebAssembly memory goes back to the operating system.
// Images resvg would not draw, or should not decode, keep their placeholder: remote https images (never fetched) and
// inline images larger than MAX_IMAGE_EDGE on either side.
const MAX_IMAGE_EDGE = 4096;
const defaults = { maxRenders: 50, idleMs: 60_000, timeoutMs: 10_000 };
let options = { ...defaults };
let worker;
let rendersOnWorker = 0;
let workersStarted = 0;
let idleTimer;
let queue = Promise.resolve();
let nextId = 0;

/** Width and height from a PNG, GIF, JPEG or WebP header, or null when the bytes are not one of those. */
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
      // Start-of-frame markers carry the size; C4 (DHT), C8 (JPG) and CC (DAC) share the range but do not.
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

/** A copy of the document in which every image resvg cannot honestly draw shows the grey placeholder instead. */
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
  // daemon, and a worker that exits while idle must not stay cached for the next render to wait out its time limit.
  // A render in flight still rejects through its own listeners.
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
      // A failed render may be a WebAssembly panic, which leaves resvg unusable; the next render gets a fresh worker.
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

/** Draws a validated design as a PNG, at most 1568 px on the long edge. Renders run one at a time. */
function renderDesignPng(document) {
  const result = queue.then(() => post({ document: rasterDocument(document) }));
  queue = result.catch(() => {});
  return result;
}

/** Redraws a PNG, JPEG, GIF or WebP data URL at width x height as a PNG data URL. Shares the render queue and worker. */
function resizeImagePng(src, width, height) {
  const size = imageSize(Buffer.from(src.slice(src.indexOf(",") + 1), "base64"));
  if (!size) return Promise.reject(Error("The image size could not be read."));
  if (size.width > MAX_IMAGE_EDGE * 2 || size.height > MAX_IMAGE_EDGE * 2) return Promise.reject(Error("The image is too large to decode."));
  const result = queue.then(() => post({ image: { src, width, height } })).then(({ mime, base64 }) => `data:${mime};base64,${base64}`);
  queue = result.catch(() => {});
  return result;
}

/** Test hooks: tune recycling and the time limit, and count the workers started so far. */
const designRasterTesting = {
  configure: (next) => {
    options = { ...defaults, ...next };
  },
  workersStarted: () => workersStarted,
  /** The cached worker, so a test can end it behind the cache's back. */
  worker: () => worker,
  retire,
};

module.exports = { renderDesignPng, resizeImagePng, imageSize, designRasterTesting };
