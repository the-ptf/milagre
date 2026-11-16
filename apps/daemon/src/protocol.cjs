const VERSION = 1;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_PENDING = 32;

function protocolError(code, message) {
  return Object.assign(new Error(message), { code });
}
const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function pageSize(maxFrameBytes) {
  return Math.max(1, Math.min(1024 * 1024, Math.floor((maxFrameBytes - 512) / 6)));
}

const EVENT_PREFIX = Buffer.from(`{"v":${VERSION},"event":`);
/** @param {Buffer} frame */
const isEventFrame = (frame) => frame.length > EVENT_PREFIX.length && frame.subarray(0, EVENT_PREFIX.length).equals(EVENT_PREFIX);

function wire(socket, { onMessage, onInvalid, maxFrameBytes = MAX_FRAME_BYTES, skip = /** @type {((frame: Buffer) => boolean) | null} */ (null) }) {
  let pending = [];
  let pendingBytes = 0;
  let failed = false;
  socket.on("data", (chunk) => {
    if (failed) return;
    if (!chunk.includes(10)) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes > maxFrameBytes) {
        failed = true;
        onInvalid(protocolError("FRAME_TOO_LARGE", "Frame exceeds the local daemon size limit"));
      }
      return;
    }
    let buffer = pending.length ? Buffer.concat([...pending, chunk]) : chunk;
    pending = [];
    pendingBytes = 0;
    while (buffer.length) {
      const newline = buffer.indexOf(10);
      if (newline > maxFrameBytes || (newline < 0 && buffer.length > maxFrameBytes)) {
        failed = true;
        onInvalid(protocolError("FRAME_TOO_LARGE", "Frame exceeds the local daemon size limit"));
        return;
      }
      if (newline < 0) {
        pending = [buffer];
        pendingBytes = buffer.length;
        return;
      }
      const frame = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (skip?.(frame)) continue;
      let message;
      try {
        message = JSON.parse(frame.toString("utf8"));
      } catch {
        failed = true;
        onInvalid(protocolError("INVALID_REQUEST", "Expected a JSON frame"));
        return;
      }
      onMessage(message);
      if (socket.destroyed) return;
    }
  });
  return {
    send(message, json, size) {
      if (socket.destroyed || socket.writableEnded) return false;
      const frame = (json ?? JSON.stringify(message)) + "\n";
      const bytes = size ?? Buffer.byteLength(frame);
      if (bytes > maxFrameBytes)
        throw Object.assign(
          protocolError("FRAME_TOO_LARGE", `The message is ${megabytes(bytes)}, over the local daemon's ${megabytes(maxFrameBytes)} frame limit`),
          { bytes },
        );
      if (socket.writableLength + bytes > 2 * maxFrameBytes) {
        socket.destroy();
        return false;
      }
      socket.write(frame);
      return true;
    },
  };
}

module.exports = { VERSION, MAX_FRAME_BYTES, MAX_PENDING, protocolError, pageSize, wire, isEventFrame };
