export { createQuotaService, quotaLimits } from "./quota.mjs";
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

export function response(body, status = 200, type = "text/plain; charset=utf-8") {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, "Content-Type": type } });
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

/** Durable intent plus an alarm repairs interrupted reservations, commits and refunds. */
export function createPageService({ storage, validate, render, quota, quotaId, setAlarm, deleteAlarm, now = Date.now }) {
  const enqueue = serial();
  const schedule = async () => {
    const meta = storage.get("meta");
    if (storage.get("pending") || meta?.releasePending) await setAlarm(now() + RETRY_MS);
    else if (meta && !meta.deleted && meta.expiresAt) await setAlarm(meta.expiresAt);
    else await deleteAlarm();
  };
  const recover = async () => {
    const pending = storage.get("pending");
    if (!pending && !storage.get("meta")?.releasePending) return;
    if (pending) {
      const meta = storage.get("meta");
      if (meta?.operation === pending.operation) {
        if (!(await quota.commit(quotaId, pending.operation))) throw Error("Quota commit not confirmed");
      } else await quota.abort(quotaId, pending.operation);
      storage.delete("pending");
    }
    const meta = storage.get("meta");
    if (meta?.releasePending) {
      await quota.release(quotaId);
      storage.put("meta", { deleted: true });
    }
    await schedule();
  };
  const remove = async (meta) => {
    // Schedule before either local mutation or remote refund. A crash always leaves a retry.
    await setAlarm(now() + RETRY_MS);
    storage.transaction(() => {
      for (let i = 0; i < (meta?.chunks ?? 0); i++) storage.delete(chunkKey(meta.revision, i));
      storage.put("meta", { deleted: true, releasePending: true });
    });
    await recover();
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
          else await schedule();
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
            return response(stream, 200, "text/html; charset=utf-8");
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
            html = encoder.encode(render(snapshot));
          } catch {
            return response("Unable to render Designs page", 400);
          }
          const bytes = canonical.byteLength + html.byteLength;
          const operation = String((storage.get("sequence") ?? 0) + 1);
          await setAlarm(now() + RETRY_MS);
          storage.transaction(() => {
            storage.put("sequence", Number(operation));
            storage.put("pending", { operation });
          });
          if (!(await quota.reserve(quotaId, operation, bytes))) {
            await recover();
            return response("Publishing unavailable", 429);
          }
          const count = Math.ceil(html.byteLength / CHUNK_BYTES);
          const revision = meta ? (meta.revision ?? 0) + 1 : 0;
          storage.transaction(() => {
            for (let i = 0; i < (meta?.chunks ?? 0); i++) storage.delete(chunkKey(meta.revision, i));
            for (let i = 0; i < count; i++) storage.put(chunkKey(revision, i), html.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
            storage.put("meta", { hash, chunks: count, revision, bytes, operation, expiresAt: now() + PAGE_TTL_MS });
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
  const read = /^\/s\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
  const write = /^\/api\/pages\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
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
