// Messages carried inside the encrypted relay channel (one channel.seal() frame each).
// Dependency-free on purpose: runs in Node and in Hermes, which has no Buffer.
const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const INDEX = new Map([...CHARS].map((char, i) => [char, i]));
export const CHUNK = 256 * 1024;
export const MAX_RESPONSE = 64 * 1024 * 1024;

export function toBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += CHARS[(n >> 18) & 63] + CHARS[(n >> 12) & 63] + (i + 1 < bytes.length ? CHARS[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? CHARS[n & 63] : "=");
  }
  return out;
}

export function fromBase64(text) {
  const clean = text.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0,
    value = 0,
    j = 0;
  for (const char of clean) {
    const index = INDEX.get(char);
    if (index === undefined) throw new Error("Not base64");
    value = ((value << 6) | index) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (value >> bits) & 255;
    }
  }
  return out;
}

export function splitBody(bytes, size = CHUNK) {
  if (!bytes.length) return [""];
  const chunks = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(toBase64(bytes.subarray(i, i + size)));
  return chunks;
}

/** Collects a response's chunks by id; a dropped connection calls drop() for every pending id. */
export function createAssembler() {
  const pending = new Map();
  return {
    add(part) {
      const entry = pending.get(part.id) ?? { parts: [], size: 0, status: part.status, headers: part.headers };
      const bytes = fromBase64(part.chunk);
      entry.size += bytes.length;
      if (entry.size > MAX_RESPONSE) {
        pending.delete(part.id);
        throw new Error("Response too large");
      }
      entry.parts.push(bytes);
      if (part.more) {
        pending.set(part.id, entry);
        return { done: false };
      }
      pending.delete(part.id);
      const body = new Uint8Array(entry.size);
      let offset = 0;
      for (const piece of entry.parts) {
        body.set(piece, offset);
        offset += piece.length;
      }
      return { done: true, status: entry.status, headers: entry.headers, body };
    },
    drop(id) {
      pending.delete(id);
    },
  };
}
