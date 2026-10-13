// HTML artifacts run in separate opaque sandboxed documents. Unlike srcdoc, a protocol
// response gets its own CSP, so the main renderer never needs unsafe-inline scripts.
const { randomBytes } = require("node:crypto");
const { ARTIFACT_CSP, artifactDocument } = require("@milagre/shared/artifact-document");
const PREFIX = "milagre-artifact://preview/";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
function createArtifactPreviews() {
  const entries = new Map();
  let bytes = 0;
  function release(owner, url) {
    const entry = entries.get(url);
    if (!entry || entry.owner !== owner) return;
    bytes -= entry.bytes;
    entries.delete(url);
  }
  return {
    register(owner, html) {
      if (typeof html !== "string" || Buffer.byteLength(html) > MAX_BYTES) throw new Error("Artifact preview is too large.");
      const body = artifactDocument(html);
      const size = Buffer.byteLength(body);
      if (bytes + size > MAX_TOTAL || entries.size >= 128) throw new Error("Too many artifact previews are open.");
      const url = `${PREFIX}${randomBytes(24).toString("hex")}`;
      entries.set(url, { owner, body, bytes: size });
      bytes += size;
      return url;
    },
    release,
    clear(owner) {
      for (const [url, entry] of entries) if (entry.owner === owner) release(owner, url);
    },
    handle(request) {
      const entry = request.method === "GET" && entries.get(request.url);
      if (!entry) return new Response("Not found", { status: 404 });
      return new Response(entry.body, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": ARTIFACT_CSP,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  };
}
module.exports = { createArtifactPreviews };
