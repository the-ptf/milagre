// HTML artifacts run in separate opaque sandboxed documents. Unlike srcdoc, a protocol
// response gets its own CSP, so the main renderer never needs unsafe-inline scripts.
const { randomBytes } = require("node:crypto");
const { artifactCsp, artifactDocument, ARTIFACT_CSP } = require("@milagre/shared/artifact-document");
const { ASSET_HASH, ASSET_NAME, byteRange, rewriteAssetUrls } = require("@milagre/shared/artifact-assets");
const { diagramScript } = require("@milagre/shared/diagram-script");
const PREFIX = "milagre-artifact://preview/";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
// A page's files load from this scheme, so every preview's policy allows it; each preview's address is unguessable.
const ASSET_SOURCE = "milagre-artifact:";
/** The policy a preview runs under: its iframe asks for the same one (ArtifactFrame), so Chromium accepts the page. */
const PREVIEW_CSP = artifactCsp(ASSET_SOURCE);
const FILE = /^(milagre-artifact:\/\/preview\/[a-f0-9]{48})\/assets\/([^/?#]+)$/;

/**
 * `readAsset(chatId, name, offset, length)` reads part of a file of the Chat's Artifact page from the computer the Chat
 * is on (artifact:asset). A page's `assets/<name>` points at this preview's address, which streams the file in the
 * chunks that call returns, by byte range when the player asks for one.
 */
/** @param {{ readAsset?: (chatId: string, name: string, offset: number, length: number) => Promise<{ base64: string; hash: string }> }} [options] */
function createArtifactPreviews({ readAsset } = {}) {
  const entries = new Map();
  let bytes = 0;
  function release(owner, url) {
    const entry = entries.get(url);
    if (!entry || entry.owner !== owner) return;
    bytes -= entry.bytes;
    entries.delete(url);
  }
  return {
    register(owner, html, source) {
      if (typeof html !== "string" || Buffer.byteLength(html) > MAX_BYTES) throw new Error("Artifact preview is too large.");
      const url = `${PREFIX}${randomBytes(24).toString("hex")}`;
      const chatId = typeof source?.chatId === "string" ? source.chatId : null;
      const assets = (Array.isArray(source?.assets) ? source.assets : []).filter(
        (asset) =>
          ASSET_NAME.test(asset?.name ?? "") && ASSET_HASH.test(asset?.hash ?? "") && Number.isSafeInteger(asset?.size) && typeof asset?.type === "string",
      );
      const page = chatId && assets.length ? rewriteAssetUrls(html, assets, (asset) => `${url}/assets/${asset.name}`) : html;
      // The page's viewer drives its helper (pins, comments, zoom); Mermaid blocks render with Pele.
      const inline = source?.inline === true;
      const body = inline ? artifactDocument(page) : artifactDocument(page, { page: true, diagrams: diagramScript(), assets: ASSET_SOURCE });
      const size = Buffer.byteLength(body);
      if (bytes + size > MAX_TOTAL || entries.size >= 128) throw new Error("Too many artifact previews are open.");
      entries.set(url, {
        owner,
        body,
        policy: inline ? ARTIFACT_CSP : PREVIEW_CSP,
        bytes: size,
        chatId,
        assets: new Map(assets.map((asset) => [asset.name, asset])),
      });
      bytes += size;
      return url;
    },
    release,
    clear(owner) {
      for (const [url, entry] of entries) if (entry.owner === owner) release(owner, url);
    },
    handle(request) {
      if (request.method !== "GET") return new Response("Not found", { status: 404 });
      const entry = entries.get(request.url);
      if (entry)
        return new Response(entry.body, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": entry.policy,
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
          },
        });
      const match = FILE.exec(request.url);
      const owner = match && entries.get(match[1]);
      const asset = match && owner?.assets.get(decodeURIComponent(match[2] ?? ""));
      if (!asset || !owner.chatId || !readAsset) return new Response("Not found", { status: 404 });
      return fileResponse(readAsset, owner.chatId, asset, request.headers.get("Range"));
    },
  };
}

/** One file of a page, whole or by byte range, streamed a chunk at a time; it never runs as a page of its own. */
function fileResponse(readAsset, chatId, asset, header) {
  const range = byteRange(header, asset.size);
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
  };
  if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${asset.size}` } });
  const { offset, length } = range ?? { offset: 0, length: asset.size };
  let position = offset;
  const body = new ReadableStream(
    {
      async pull(controller) {
        if (position >= offset + length) return controller.close();
        try {
          const chunk = await readAsset(chatId, asset.name, position, offset + length - position);
          const bytes = Buffer.from(chunk?.base64 ?? "", "base64");
          // The page changed under the player: this file is another one now, or gone.
          if (chunk?.hash !== asset.hash || !bytes.length) throw new Error("This file is no longer on the page.");
          position += bytes.length;
          controller.enqueue(bytes);
        } catch (error) {
          controller.error(error);
        }
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      ...headers,
      "Content-Type": asset.type,
      "Content-Length": String(length),
      ...(range ? { "Content-Range": `bytes ${offset}-${offset + length - 1}/${asset.size}` } : {}),
    },
  });
}
module.exports = { createArtifactPreviews };
