// Media stays behind viewer capabilities. Retain one frame, never a replay queue.
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_HEADER_BYTES = 8192;
/** Large, detailed Android PNGs are valid captures. Bound the relay payload by encoding them on the Mac. */
async function normalizeAndroidSnapshot(data, { execFile, signal }) {
  if (data.length <= MAX_FRAME_BYTES) return { data, mimeType: "image/png" };
  const fs = require("node:fs/promises"),
    path = require("node:path");
  const directory = await fs.mkdtemp(path.join(require("node:os").tmpdir(), "milagre-simulator-frame-"));
  try {
    const input = path.join(directory, "input.png"),
      output = path.join(directory, "output.jpg");
    await fs.writeFile(input, data, { mode: 0o600, signal });
    await execFile("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", "1280", input, "--out", output], {
      timeout: 5000,
      maxBuffer: 8192,
      signal,
    });
    if ((await fs.stat(output)).size > MAX_FRAME_BYTES) throw new Error("Oversized simulator frame.");
    const jpeg = await fs.readFile(output, { signal });
    if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9)
      throw new Error("Invalid Android frame conversion.");
    return { data: jpeg, mimeType: "image/jpeg" };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
function latestFrames() {
  const abort = new AbortController(),
    waiters = new Set();
  let latest = null,
    sequence = 0,
    failure = null;
  const notify = () => {
    for (const wake of Array.from(waiters)) wake();
  };
  return {
    signal: abort.signal,
    discard() {
      latest = null;
      return sequence;
    },
    publish(image) {
      if (abort.signal.aborted) return;
      if (!Buffer.isBuffer(image.data) || !image.data.length || image.data.length > MAX_FRAME_BYTES || !["image/jpeg", "image/png"].includes(image.mimeType))
        throw new Error("Invalid or oversized simulator frame.");
      latest = { sequence: ++sequence, data: image.data.toString("base64"), mimeType: image.mimeType };
      notify();
    },
    fail() {
      if (abort.signal.aborted) return;
      failure = new Error("Simulator frame stream failed. Retry to reconnect.");
      notify();
    },
    async read(after, signal) {
      if (abort.signal.aborted || signal?.aborted) return null;
      if (!failure && (!latest || latest.sequence <= after)) {
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            waiters.delete(done);
            signal?.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, 2500);
          waiters.add(done);
          signal?.addEventListener("abort", done, { once: true });
        });
      }
      if (abort.signal.aborted || signal?.aborted) return null;
      if (failure) throw failure;
      return latest && latest.sequence > after ? latest : null;
    },
    close() {
      abort.abort();
      latest = null;
      notify();
    },
  };
}

/** The helper sends Content-Length per JPEG. Consume the frame immediately, including on an idle screen. */
function createMjpegFrames(open) {
  const frames = latestFrames();
  let started = false;
  async function consume() {
    const response = await open(frames.signal);
    if (frames.signal.aborted) {
      await response.body?.cancel();
      return;
    }
    if (!response.ok || !response.headers.get("content-type")?.startsWith("multipart/x-mixed-replace")) {
      await response.body?.cancel();
      throw new Error("Invalid simulator stream.");
    }
    let buffer = Buffer.alloc(0),
      length = null;
    for await (const chunk of response.body) {
      if (frames.signal.aborted) return;
      // A fetch reader's chunks are bounded; a corrupt part cannot accumulate indefinitely.
      if (buffer.length + chunk.byteLength > MAX_FRAME_BYTES * 2 + MAX_HEADER_BYTES) throw new Error("Oversized simulator frame.");
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (length === null) {
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) {
            if (buffer.length > MAX_HEADER_BYTES) throw new Error("Invalid simulator frame headers.");
            break;
          }
          if (end > MAX_HEADER_BYTES) throw new Error("Invalid simulator frame headers.");
          const header = buffer.subarray(0, end).toString("ascii");
          const size = /\r\ncontent-length:\s*(\d+)\s*(?:\r\n|$)/i.exec(header);
          length = size ? Number(size[1]) : 0;
          if (!Number.isSafeInteger(length) || length < 4 || length > MAX_FRAME_BYTES) throw new Error("Invalid simulator frame length.");
          buffer = buffer.subarray(end + 4);
        }
        if (buffer.length < length) break;
        const data = buffer.subarray(0, length);
        if (data[0] !== 0xff || data[1] !== 0xd8 || data[length - 2] !== 0xff || data[length - 1] !== 0xd9) throw new Error("Invalid JPEG frame.");
        frames.publish({ data, mimeType: "image/jpeg" });
        buffer = buffer.subarray(length);
        length = null;
      }
    }
    throw new Error("Simulator stream ended.");
  }
  return {
    discard: () => frames.discard(),
    read(after, signal) {
      if (!started && !frames.signal.aborted) {
        started = true;
        void consume().catch(() => frames.fail());
      }
      return frames.read(after, signal);
    },
    close: () => frames.close(),
  };
}

/** Snapshot-only sources share one bounded capture across viewers and run only on demand. */
function createSnapshotFrames(capture, { intervalMs = 250 } = {}) {
  const frames = latestFrames();
  let pending = null,
    nextAt = 0,
    timer = null;
  return {
    read(after, signal) {
      if (!pending && !frames.signal.aborted) {
        pending = (
          nextAt > Date.now()
            ? new Promise((resolve) => {
                timer = setTimeout(resolve, nextAt - Date.now());
              })
            : Promise.resolve()
        )
          .then(async () => {
            if (!frames.signal.aborted) frames.publish(await capture(frames.signal));
            nextAt = Date.now() + intervalMs;
          })
          .catch(() => frames.fail())
          .finally(() => {
            pending = null;
          });
      }
      return frames.read(after, signal);
    },
    close() {
      clearTimeout(timer);
      frames.close();
    },
  };
}
module.exports = { createMjpegFrames, createSnapshotFrames, normalizeAndroidSnapshot };
