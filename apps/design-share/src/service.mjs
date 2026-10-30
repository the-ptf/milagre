export { createQuotaService, quotaLimits } from "./quota.mjs";
import { MAX_ASSET_BYTES, assetInline, byteRange } from "@milagre/shared/artifact-assets";
export const CHUNK_BYTES = 96 * 1024;
const encoder = new TextEncoder();
export const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export function response(body, status = 200, type = "text/plain; charset=utf-8", headers = {}) {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, "Content-Type": type, ...headers } });
}

/** A public page's policy also lets it show its own files, which the service keeps at `origin`. */
const pagePolicy = (origin) =>
  SECURITY_HEADERS["Content-Security-Policy"].replace("img-src data:", `img-src data: ${origin}; media-src ${origin}; font-src ${origin}`);

/** Where a page's file lives in the bucket. */
export const fileKey = (id, hash) => `pages/${id}/${hash}`;

/**
 * One file of a public page, from the bucket, whole or the one byte range asked for (a video player seeks with
 * them). It never runs as a page of this origin: a sandbox policy, no sniffing, and anything but media is a download.
 */
export async function serveFile(bucket, key, request) {
  const head = await bucket.head(key);
  if (!head) return response("Not found", 404);
  const headers = {
    "Accept-Ranges": "bytes",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": assetInline(head.type) ? "inline" : "attachment",
    ...(head.etag ? { ETag: head.etag } : {}),
  };
  const range = byteRange(request.headers.get("Range"), head.size);
  if (range === "unsatisfiable") return response(null, 416, "text/plain; charset=utf-8", { ...headers, "Content-Range": `bytes */${head.size}` });
  if (request.method === "HEAD") return response(null, 200, head.type, { ...headers, "Content-Length": String(head.size) });
  const object = await bucket.get(key, range ?? undefined);
  if (!object) return response("Not found", 404);
  if (!range) return response(object.body, 200, head.type, { ...headers, "Content-Length": String(head.size) });
  return response(object.body, 206, head.type, {
    ...headers,
    "Content-Length": String(range.length),
    "Content-Range": `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`,
  });
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function digest(bytes) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** Validate canonical encoding as well as length: alternate encodings must not create extra capabilities. */
export async function authorized(request, id) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("Authorization") ?? "");
  if (!match) return false;
  const secret = Uint8Array.from(atob(match[1].replaceAll("-", "+").replaceAll("_", "/") + "="), (c) => c.charCodeAt(0));
  return secret.length === 32 && base64url(secret) === match[1] && (await digest(secret)) === id;
}

/** Do not trust Content-Length alone; hosts may stream and attackers may lie. */
export async function boundedBody(request, limit = Number.MAX_SAFE_INTEGER) {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw Object.assign(new Error("Snapshot too large"), { status: 413 });
  }
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error("Expected snapshot"), { status: 400 });
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw Object.assign(new Error("Snapshot too large"), { status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function serial() {
  let tail = Promise.resolve();
  return (operation) => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
}

const decode = (value) => value.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[entity]);

/** The generated wrapper keeps its escaped title at the start of the first chunk.
 * Decorate reads so existing snapshots gain previews without rewriting their content.
 * Splice bytes, not decoded chunks: UTF-8 characters can span storage boundaries. */
function withSocialPreview(chunk, requestUrl) {
  const prefix = new TextDecoder().decode(chunk.subarray(0, 4096));
  const title = /<title>([^<]{1,1024}) \| Milagre (Designs|Artifact)<\/title>(?:<meta name="description" content="([^"<>]{1,2048})">)?/.exec(prefix);
  if (!title) return chunk;
  const url = new URL(requestUrl);
  url.search = "";
  url.hash = "";
  const escape = (value) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const decoded = decode(title[1]);
  // Pages published before descriptions existed keep the generic line.
  const own = title[3] ? decode(title[3]) : "";
  const description = own || (title[2] === "Designs" ? "View this Designs page shared with Milagre." : "Open this interactive Artifact shared with Milagre.");
  const image = `${url.origin}/og.png`;
  const properties = {
    "og:type": "website",
    "og:site_name": "Milagre",
    "og:title": decoded,
    "og:description": description,
    "og:url": url.href,
    "og:image": image,
    "og:image:type": "image/png",
    "og:image:width": "1200",
    "og:image:height": "630",
    "og:image:alt": "Shared with Milagre. Designs and interactive Artifacts.",
  };
  const names = {
    ...(own ? {} : { description }),
    "twitter:card": "summary_large_image",
    "twitter:title": decoded,
    "twitter:description": description,
    "twitter:image": image,
    "twitter:image:alt": properties["og:image:alt"],
  };
  const metadata = encoder.encode(
    Object.entries(properties)
      .map(([property, content]) => `<meta property="${property}" content="${escape(content)}">`)
      .join("") +
      Object.entries(names)
        .map(([name, content]) => `<meta name="${name}" content="${escape(content)}">`)
        .join("") +
      `<link rel="canonical" href="${escape(url.href)}">`,
  );
  const offset = encoder.encode(prefix.slice(0, title.index + title[0].length)).byteLength;
  const output = new Uint8Array(chunk.byteLength + metadata.byteLength);
  output.set(chunk.subarray(0, offset));
  output.set(metadata, offset);
  output.set(chunk.subarray(offset), offset + metadata.byteLength);
  return output;
}

/** Pages published before replacements existed have no revision and keep their original keys. */
const chunkKey = (revision, index) => (revision ? `html:${revision}:${index}` : `html:${index}`);

export const PAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;
// A file uploaded for a publication that never came is removed after this long.
const STAGED_MS = 60 * 60 * 1000;
const fileBytes = (files) => Object.values(files ?? {}).reduce((sum, file) => sum + file.size, 0);

/**
 * Durable intent plus an alarm repairs interrupted reservations, commits and refunds.
 *
 * An Artifact page's files live in `bucket`, under fileKey, and count toward the page's allocation with its HTML: a
 * file upload is a page operation like a publication (reserve, store, commit). `files` lists every file stored for
 * the page; one the published snapshot doesn't name (uploaded for a publication that never came) is removed after
 * STAGED_MS. Removed files wait in `trash` until the bucket confirms their deletion.
 */
export function createPageService({ storage, validate, render, quota, quotaId, setAlarm, deleteAlarm, bucket = null, now = Date.now }) {
  const enqueue = serial();
  const allocation = () => {
    const meta = storage.get("meta");
    return (meta && !meta.deleted ? (meta.bytes ?? 0) : 0) + fileBytes(storage.get("files"));
  };
  // Files the published snapshot doesn't name, with when they arrived.
  const staged = () => {
    const published = new Set(storage.get("meta")?.files ?? []);
    return Object.entries(storage.get("files") ?? {}).filter(([hash]) => !published.has(hash));
  };
  const schedule = async () => {
    const meta = storage.get("meta");
    if (storage.get("pending") || meta?.releasePending || storage.get("trash")?.length) return setAlarm(now() + RETRY_MS);
    const times = [meta && !meta.deleted ? meta.expiresAt : 0, ...staged().map(([, file]) => file.at + STAGED_MS)].filter(Boolean);
    if (times.length) await setAlarm(Math.min(...times));
    else await deleteAlarm();
  };
  const emptyTrash = async () => {
    const trash = storage.get("trash") ?? [];
    if (!trash.length || !bucket) return;
    try {
      await bucket.delete(trash);
      storage.delete("trash");
    } catch {
      /* The alarm retries. */
    }
  };
  const recover = async () => {
    const pending = storage.get("pending");
    if (!pending && !storage.get("meta")?.releasePending && !storage.get("trash")?.length) return;
    if (pending) {
      const meta = storage.get("meta");
      const done = pending.files ? storage.get("filesOperation") === pending.operation : meta?.operation === pending.operation;
      if (done) {
        if (!(await quota.commit(quotaId, pending.operation))) throw Error("Quota commit not confirmed");
      } else {
        await quota.abort(quotaId, pending.operation);
        // An upload that stopped before it was recorded may still have reached the bucket.
        if (pending.key) storage.put("trash", [...(storage.get("trash") ?? []), pending.key]);
      }
      storage.delete("pending");
    }
    const meta = storage.get("meta");
    if (meta?.releasePending) {
      await quota.release(quotaId);
      storage.put("meta", { deleted: true });
    }
    await emptyTrash();
    await schedule();
  };
  const remove = async (meta) => {
    // Schedule before either local mutation or remote refund. A crash always leaves a retry.
    await setAlarm(now() + RETRY_MS);
    storage.transaction(() => {
      for (let i = 0; i < (meta?.chunks ?? 0); i++) storage.delete(chunkKey(meta.revision, i));
      const files = Object.values(storage.get("files") ?? {});
      if (files.length) storage.put("trash", [...(storage.get("trash") ?? []), ...files.map((file) => file.key)]);
      storage.delete("files");
      storage.put("meta", { deleted: true, releasePending: true });
    });
    await recover();
  };
  // A page operation on its files: reserve the allocation they leave, change them, then commit.
  const begin = async (bytes, key) => {
    const operation = String((storage.get("sequence") ?? 0) + 1);
    await setAlarm(now() + RETRY_MS);
    storage.transaction(() => {
      storage.put("sequence", Number(operation));
      storage.put("pending", { operation, files: true, ...(key ? { key } : {}) });
    });
    if (await quota.reserve(quotaId, operation, bytes)) return operation;
    await recover();
    return null;
  };
  const dropStaged = async () => {
    const expired = staged().filter(([, file]) => file.at + STAGED_MS <= now());
    if (!expired.length) return;
    const operation = await begin(allocation() - fileBytes(Object.fromEntries(expired)));
    if (!operation) return;
    storage.transaction(() => {
      const files = storage.get("files") ?? {};
      for (const [hash] of expired) delete files[hash];
      storage.put("files", files);
      storage.put("trash", [...(storage.get("trash") ?? []), ...expired.map(([, file]) => file.key)]);
      storage.put("filesOperation", operation);
    });
    await recover();
  };
  /** Stores one file of the page by its SHA-256, charged to the page, before the snapshot that names it. */
  const upload = async (request, id, hash) => {
    if (request.method !== "PUT") return response("Method not allowed", 405);
    if (!bucket) return response("Not found", 404);
    const meta = storage.get("meta");
    if (meta?.deleted) return response("Snapshot revoked", 410);
    const stored = (storage.get("files") ?? {})[hash];
    if (stored) return response(JSON.stringify({ hash }), 200, "application/json; charset=utf-8");
    const type = request.headers.get("Content-Type") ?? "";
    if (!/^[a-z]+\/[a-z0-9.+-]{1,80}$/.test(type) || request.headers.has("Content-Encoding")) return response("Unsupported file type", 415);
    const declared = request.headers.get("Content-Length");
    if (declared === null || !/^\d+$/.test(declared)) return response("Length required", 411);
    const size = Number(declared);
    if (size > MAX_ASSET_BYTES) return response("File too large", 413);
    const total = allocation() + size;
    if (total > (await quota.available(quotaId))) return response("Publishing unavailable", 429);
    const key = fileKey(id, hash);
    const operation = await begin(total, key);
    if (!operation) return response("Publishing unavailable", 429);
    try {
      // The bucket checks the bytes against their hash and length.
      await bucket.put(key, request.body, { size, sha256: hash, type });
    } catch {
      await recover();
      return response("The file doesn't match its hash and length", 400);
    }
    storage.transaction(() => {
      storage.put("files", { ...storage.get("files"), [hash]: { key, size, type, at: now() } });
      // Uploaded again after it was removed: it stays.
      const trash = storage.get("trash") ?? [];
      if (trash.includes(key))
        storage.put(
          "trash",
          trash.filter((item) => item !== key),
        );
      storage.put("filesOperation", operation);
    });
    await recover();
    return response(JSON.stringify({ hash }), 201, "application/json; charset=utf-8");
  };
  const migrate = async () => {
    const meta = storage.get("meta");
    if (!meta || meta.deleted) {
      if (meta?.deleted) await quota.release(quotaId);
      return;
    }
    if (!meta.expiresAt) {
      await setAlarm(now() + PAGE_TTL_MS);
      storage.put("meta", { ...meta, expiresAt: now() + PAGE_TTL_MS });
    }
    // The legacy publisher discarded JSON, so only its surviving HTML can be inventoried.
    let bytes = 0;
    for (let i = 0; i < meta.chunks; i++) bytes += storage.get(chunkKey(meta.revision, i))?.byteLength ?? 0;
    await quota.importPage(quotaId, bytes);
    await schedule();
  };
  return {
    migrate: () => enqueue(migrate),
    alarm: () =>
      enqueue(async () => {
        try {
          await recover();
          const meta = storage.get("meta");
          if (meta && !meta.deleted && meta.expiresAt <= now()) await remove(meta);
          else {
            await dropStaged();
            await schedule();
          }
        } catch (error) {
          await setAlarm(now() + RETRY_MS);
          throw error;
        }
      }),
    fetch(request, id) {
      return enqueue(async () => {
        try {
          const isRead = request.method === "GET" || request.method === "HEAD";
          if (!isRead && !(await authorized(request, id))) return response("Unauthorized", 401);
          await recover();
          let meta = storage.get("meta");
          if (meta && !meta.deleted && !meta.expiresAt) {
            await migrate();
            meta = storage.get("meta");
          }
          if (meta && !meta.deleted && meta.expiresAt <= now()) {
            await remove(meta);
            meta = storage.get("meta");
          }
          const file = /\/files\/([a-f0-9]{64})$/.exec(new URL(request.url).pathname)?.[1];
          if (file) return await upload(request, id, file);
          if (isRead) {
            if (!meta || meta.deleted) return response("Not found", 404);
            if (request.method === "HEAD") return response(null, 200, "text/html; charset=utf-8");
            let index = 0;
            const stream = new ReadableStream(
              {
                pull(controller) {
                  try {
                    const current = storage.get("meta");
                    if (current?.deleted || current?.expiresAt <= now()) throw Error("Snapshot revoked");
                    if (current?.revision !== meta.revision) throw Error("Snapshot updated");
                    if (index >= meta.chunks) {
                      controller.close();
                      return;
                    }
                    const chunk = storage.get(chunkKey(meta.revision, index++));
                    if (!(chunk instanceof Uint8Array)) throw Error("Missing stored chunk");
                    controller.enqueue(index === 1 ? withSocialPreview(chunk, request.url) : chunk);
                  } catch (error) {
                    controller.error(error);
                  }
                },
              },
              { highWaterMark: 0 },
            );
            return response(stream, 200, "text/html; charset=utf-8", { "Content-Security-Policy": pagePolicy(new URL(request.url).origin) });
          }
          if (request.method === "DELETE") {
            if (!meta?.deleted) await remove(meta);
            return response(null, 204);
          }
          if (request.method !== "PUT") return response("Method not allowed", 405);
          if (meta?.deleted) return response("Snapshot revoked", 410);
          if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type") ?? ""))
            return response("Expected application/json", 415);
          if (request.headers.has("Content-Encoding")) return response("Encoded bodies are not supported", 415);
          // Only the service-wide cap bounds input. There is no per-page byte budget.
          const available = await quota.available(quotaId);
          if (!meta && !available) return response("Publishing unavailable", 429);
          const body = await boundedBody(request, meta ? Math.max(available, meta.bytes ?? 0) : available);
          let snapshot;
          try {
            snapshot = validate(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
          } catch {
            return response("Invalid Designs page snapshot", 400);
          }
          // An Artifact page's files are uploaded first, each by its hash; the snapshot only names them.
          const assets = snapshot.kind === "artifacts" ? (snapshot.artifacts?.[0]?.assets ?? []) : [];
          const files = storage.get("files") ?? {};
          const missing = [...new Set(assets.filter((asset) => files[asset.hash]?.size !== asset.size).map((asset) => asset.hash))];
          if (missing.length) return response(JSON.stringify({ missing }), 409, "application/json; charset=utf-8");
          const named = new Set(assets.map((asset) => asset.hash));
          const canonical = encoder.encode(JSON.stringify(snapshot));
          const hash = await digest(canonical);
          const result = () => JSON.stringify({ id, path: `/s/${id}` });
          if (meta?.hash === hash) {
            await setAlarm(now() + PAGE_TTL_MS);
            storage.put("meta", { ...meta, expiresAt: now() + PAGE_TTL_MS });
            return response(result(), 200, "application/json; charset=utf-8");
          }
          let html;
          try {
            html = encoder.encode(render(snapshot, { files: (asset) => `/s/${id}/files/${asset.hash}` }));
          } catch {
            return response("Unable to render Designs page", 400);
          }
          const bytes = canonical.byteLength + html.byteLength;
          const kept = Object.fromEntries(Object.entries(files).filter(([file]) => named.has(file)));
          const operation = String((storage.get("sequence") ?? 0) + 1);
          await setAlarm(now() + RETRY_MS);
          storage.transaction(() => {
            storage.put("sequence", Number(operation));
            storage.put("pending", { operation });
          });
          if (!(await quota.reserve(quotaId, operation, bytes + fileBytes(kept)))) {
            await recover();
            return response("Publishing unavailable", 429);
          }
          const count = Math.ceil(html.byteLength / CHUNK_BYTES);
          const revision = meta ? (meta.revision ?? 0) + 1 : 0;
          storage.transaction(() => {
            for (let i = 0; i < (meta?.chunks ?? 0); i++) storage.delete(chunkKey(meta.revision, i));
            for (let i = 0; i < count; i++) storage.put(chunkKey(revision, i), html.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
            storage.put("meta", {
              hash,
              chunks: count,
              revision,
              bytes,
              operation,
              expiresAt: now() + PAGE_TTL_MS,
              ...(named.size ? { files: [...named] } : {}),
            });
            // Files of an earlier version the new one doesn't name go.
            const dropped = Object.entries(files).filter(([file]) => !named.has(file));
            if (dropped.length) {
              storage.put("files", kept);
              storage.put("trash", [...(storage.get("trash") ?? []), ...dropped.map(([, file]) => file.key)]);
            }
          });
          await recover();
          return response(result(), meta ? 200 : 201, "application/json; charset=utf-8");
        } catch (error) {
          return response(error?.status === 413 ? "Snapshot too large" : "Unable to process snapshot", error?.status === 413 ? 413 : 503);
        } finally {
          // Finish an upload rejected before decoding without buffering it. The Worker
          // must not keep forwarding its request stream after the DO response is sent.
          if (request.body && !request.bodyUsed) {
            const reader = request.body.getReader();
            try {
              while (!(await reader.read()).done) {
                /* discard */
              }
            } catch {
              /* A disconnected sender has no remaining upload to drain. */
            } finally {
              reader.releaseLock();
            }
          }
        }
      });
    },
  };
}

/** No crawler may fetch shares, link preview bots included: Slack, Twitter/X and LinkedIn
 * honor this and unfurl a bare URL. A crawler that ignores it still gets noindex on every page. */
const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";

/** Public routing is separate from internal DO requests: clients cannot reach the quota object. */
export async function routeRequest(request, env) {
  const url = new URL(request.url);
  const local = env.ALLOW_LOCALHOST === "true" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!local && (url.protocol !== "https:" || url.origin !== env.PUBLIC_ORIGIN)) return response("Not found", 404);
  if (url.username || url.password) return response("Not found", 404);
  if (url.pathname === "/health" && request.method === "GET") return response("ok");
  if (url.pathname === "/robots.txt") {
    if (!["GET", "HEAD"].includes(request.method)) return response("Method not allowed", 405);
    return response(request.method === "HEAD" ? null : ROBOTS_TXT);
  }
  if (url.pathname === "/og.png") {
    if (!["GET", "HEAD"].includes(request.method)) return response("Method not allowed", 405);
    if (!env.previewImage) return response("Not found", 404);
    return response(request.method === "HEAD" ? null : env.previewImage, 200, "image/png");
  }
  // A page's file is read from the bucket directly: it is gone once the page is revoked or expires.
  const file = /^\/s\/([A-Za-z0-9_-]{43})\/files\/([a-f0-9]{64})$/.exec(url.pathname);
  if (file) {
    if (!["GET", "HEAD"].includes(request.method)) return response("Method not allowed", 405);
    return env.file ? env.file(file[1], file[2], request) : response("Not found", 404);
  }
  const read = /^\/s\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
  // A page's snapshot, or one of its files on the way up (PUT only; the page refuses anything else).
  const write = /^\/api\/pages\/([A-Za-z0-9_-]{43})(?:\/files\/[a-f0-9]{64})?$/.exec(url.pathname);
  if (!read && !write) return response("Not found", 404);
  if (url.search && !read) return response("Not found", 404);
  if (read && !["GET", "HEAD"].includes(request.method)) return response("Method not allowed", 405);
  if (write && !["PUT", "DELETE"].includes(request.method)) return response("Method not allowed", 405);
  if (write && (request.headers.has("Origin") || request.headers.get("Sec-Fetch-Site") === "cross-site"))
    return response("Browser publishing is not supported", 403);
  const id = (read ?? write)[1];
  if (write && !(await authorized(request, id))) return response("Unauthorized", 401);
  // CF sets this at ingress. Never honor X-Forwarded-For or client-supplied internal headers.
  const ip = local ? "local-preview" : request.headers.get("CF-Connecting-IP");
  if (write && (!ip || ip.length > 64)) return response("Publishing unavailable", 503);
  return env.page(id, request, ip ?? "");
}
