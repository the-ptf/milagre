export const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
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
export async function boundedBody(request, limit = MAX_BODY_BYTES) {
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

/** The generated wrapper keeps its escaped title at the start of the first chunk.
 * Decorate reads so existing snapshots gain previews without rewriting their content.
 * Splice bytes, not decoded chunks: UTF-8 characters can span storage boundaries. */
function withSocialPreview(chunk, requestUrl) {
  const prefix = new TextDecoder().decode(chunk.subarray(0, 4096));
  const title = /<title>([^<]{1,1024}) \| Milagre (Designs|Artifact)<\/title>/.exec(prefix);
  if (!title) return chunk;
  const url = new URL(requestUrl);
  url.search = "";
  url.hash = "";
  const escape = (value) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const decoded = title[1].replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[entity]);
  const description = title[2] === "Designs" ? "View this Designs page shared with Milagre." : "Open this interactive Artifact shared with Milagre.";
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
    description,
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

/** The adapter's transaction is synchronous and atomic (SQLite Durable Object transactionSync). */
export function createPageService({ storage, validate, render, admit, reserve }) {
  const enqueue = serial();
  return {
    fetch(request, id, ip) {
      return enqueue(async () => {
        try {
          const isRead = request.method === "GET" || request.method === "HEAD";
          if (!isRead && !(await authorized(request, id))) return response("Unauthorized", 401);
          const meta = storage.get("meta");
          if (isRead) {
            if (!meta || meta.deleted) return response("Not found", 404);
            if (request.method === "HEAD") return response(null, 200, "text/html; charset=utf-8");
            let index = 0;
            // A zero high-water mark prevents idle readers from retaining even one chunk.
            // Check the tombstone on every pull so revocation stops an in-flight response.
            const stream = new ReadableStream(
              {
                pull(controller) {
                  try {
                    if (storage.get("meta")?.deleted) throw new Error("Snapshot revoked");
                    if (index >= meta.chunks) {
                      controller.close();
                      return;
                    }
                    const chunk = storage.get(`html:${index++}`);
                    if (!(chunk instanceof Uint8Array)) throw new Error("Missing stored chunk");
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
            // A timed-out PUT may still be in flight. Reserve this capability even when no page
            // exists yet, so a successful revoke cannot be undone by a delayed upload.
            if (!meta && !(await reserve(ip, 1024))) return response("Publishing limit reached", 429);
            if (!meta?.deleted)
              storage.transaction(() => {
                for (let i = 0; i < (meta?.chunks ?? 0); i++) storage.delete(`html:${i}`);
                storage.put("meta", { deleted: true });
              });
            return response(null, 204);
          }
          if (request.method !== "PUT") return response("Method not allowed", 405);
          if (meta?.deleted) return response("Snapshot revoked", 410);
          if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type") ?? "")) {
            return response("Expected application/json", 415);
          }
          if (request.headers.has("Content-Encoding")) return response("Encoded bodies are not supported", 415);
          // A retry of an already committed page must remain usable after quota exhaustion.
          // New uploads check durable counters before body decoding or expensive validation.
          if (!meta && !(await admit(ip))) return response("Publishing limit reached", 429);
          const bytes = await boundedBody(request);
          let snapshot;
          try {
            snapshot = validate(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
          } catch (error) {
            if (error?.status === 413) return response("Snapshot too large", 413);
            return response("Invalid Designs page snapshot", 400);
          }
          const canonical = encoder.encode(JSON.stringify(snapshot));
          if (canonical.byteLength > MAX_BODY_BYTES) return response("Snapshot too large", 413);
          const hash = await digest(canonical);
          const result = () => JSON.stringify({ id, path: `/s/${id}` });
          if (meta)
            return meta.hash === hash ? response(result(), 200, "application/json; charset=utf-8") : response("Published snapshots cannot be changed", 409);
          let html;
          try {
            html = encoder.encode(render(snapshot));
          } catch (error) {
            if (error?.status === 413) return response("Rendered snapshot too large", 413);
            return response("Unable to render Designs page", 400);
          }
          if (html.byteLength > MAX_HTML_BYTES) return response("Rendered snapshot too large", 413);
          // Count even failed writes against the budget. A crash can spend a reservation twice, but never bypass it.
          if (!(await reserve(ip, canonical.byteLength + html.byteLength))) return response("Publishing limit reached", 429);
          const count = Math.ceil(html.byteLength / CHUNK_BYTES);
          storage.transaction(() => {
            for (let i = 0; i < count; i++) storage.put(`html:${i}`, html.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
            storage.put("meta", { hash, chunks: count });
          });
          return response(result(), 201, "application/json; charset=utf-8");
        } catch (error) {
          return response(error?.status === 413 ? "Snapshot too large" : "Unable to process snapshot", error?.status === 413 ? 413 : 503);
        }
      });
    },
  };
}

export function quotaLimits(env) {
  const positive = (name, fallback, max) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  return {
    bytes: positive("MAX_TOTAL_BYTES", 1024 ** 3, 100 * 1024 ** 3),
    pages: positive("MAX_TOTAL_PAGES", 10000, 1000000),
    daily: positive("MAX_DAILY_PAGES", 100, 10000),
    perIp: positive("MAX_DAILY_IP_PAGES", 10, 1000),
  };
}

export function createQuotaService({ storage, limits, now = Date.now }) {
  const enqueue = serial();
  const check = (ip, bytes, spend) =>
    enqueue(async () => {
      if (!ip || ip.length > 64 || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_BODY_BYTES + MAX_HTML_BYTES) return false;
      const day = new Date(now()).toISOString().slice(0, 10);
      const ipHash = await digest(encoder.encode(`${day}:${ip}`));
      return storage.transaction(() => {
        const total = storage.get("total") ?? { pages: 0, bytes: 0 };
        const currentDay = storage.get("date") === day;
        const daily = currentDay ? (storage.get("daily") ?? 0) : 0;
        const count = currentDay ? (storage.get(`ip:${ipHash}`) ?? 0) : 0;
        if (total.pages >= limits.pages || total.bytes + bytes > limits.bytes || daily >= limits.daily || count >= limits.perIp) return false;
        if (!spend) return true;
        if (!currentDay) {
          for (const key of storage.keys("ip:")) storage.delete(key);
          storage.put("date", day);
        }
        storage.put("total", { pages: total.pages + 1, bytes: total.bytes + bytes });
        storage.put("daily", daily + 1);
        storage.put(`ip:${ipHash}`, count + 1);
        return true;
      });
    });
  return {
    admit: (ip) => check(ip, 1, false),
    reserve: (ip, bytes) => check(ip, bytes, true),
  };
}

/** Public routing is separate from internal DO requests: clients cannot reach the quota object. */
export async function routeRequest(request, env) {
  const url = new URL(request.url);
  const local = env.ALLOW_LOCALHOST === "true" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!local && (url.protocol !== "https:" || url.origin !== env.PUBLIC_ORIGIN)) return response("Not found", 404);
  if (url.username || url.password) return response("Not found", 404);
  if (url.pathname === "/health" && request.method === "GET") return response("ok");
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
