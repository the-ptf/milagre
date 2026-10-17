// Webhook Routines on the Mac: the URL secret, the optional HMAC check and the first message a delivery words.
const crypto = require("node:crypto");
const { renderRoutinePrompt } = require("@milagre/shared/routine-prompt");

const DEFAULT_SIGNING_HEADER = "sentry-hook-signature";
const PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}/g;
const decoder = new TextDecoder();

const hookIdOf = (secret) => crypto.createHash("sha256").update(secret).digest("hex");

/** A new URL secret (32 random bytes, base64url, 43 characters) and its hook id, the secret's hex sha256. */
function newHookSecret() {
  const secret = crypto.randomBytes(32).toString("base64url");
  return { secret, hookId: hookIdOf(secret) };
}

/** The public URL for a secret, on the relay the Mac's phone access uses (`wss://` becomes `https://`). */
function hookUrl(relayUrl, secret) {
  const base = String(relayUrl).replace(/^wss:/i, "https:").replace(/^ws:/i, "http:").replace(/\/+$/, "");
  return `${base}/hook/${secret}`;
}

/**
 * Whether the delivery carries the HMAC-SHA256 of its raw body under `signingSecret`, as hex in `header` (a `sha256=` prefix
 * is fine). Compared in constant time.
 */
function verifySignature({ body, headers, header = DEFAULT_SIGNING_HEADER, signingSecret }) {
  if (typeof signingSecret !== "string" || signingSecret === "") return false;
  const given = String(headers?.[header] ?? "")
    .trim()
    .replace(/^sha256=/i, "")
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = crypto.createHmac("sha256", signingSecret).update(body).digest();
  return crypto.timingSafeEqual(Buffer.from(given, "hex"), expected);
}

// `body.a.b.0.c` in parsed JSON: own properties only, so a path can't reach a prototype.
function atPath(value, segments) {
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}
const asText = (value) => (value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value));

/**
 * A webhook Run's first message: the Routine's prompt with `{{body}}`, `{{request}}`, `{{body.<path>}}` (JSON),
 * `{{headers.<name>}}` and `{{query.<name>}}` filled from the delivery. Every one of them is text from outside Milagre,
 * so every one is untrusted data (routine-prompt.mjs fences it). The URL secret is never part of it.
 */
function webhookPrompt(template, delivery) {
  const body = decoder.decode(delivery.body);
  let parsed;
  let parsedOnce = false;
  const json = () => {
    if (!parsedOnce) {
      parsedOnce = true;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = undefined;
      }
    }
    return parsed;
  };
  const headers = delivery.headers ?? {};
  const query = delivery.query ?? {};
  const values = {};
  const untrusted = {};
  const put = (name, value, label) => {
    values[name] = value;
    untrusted[name] = label;
  };
  for (const [, name] of String(template ?? "").matchAll(PLACEHOLDER)) {
    if (Object.hasOwn(values, name)) continue;
    if (name === "body") put(name, body, "webhook body");
    else if (name === "request") {
      const search = new URLSearchParams(query).toString();
      const lines = Object.entries(headers).map(([key, value]) => `${key}: ${value}`);
      put(name, [`POST${search ? ` ?${search}` : ""}`, ...lines, "", body].join("\n"), "webhook request");
    } else if (name.startsWith("body.")) put(name, asText(atPath(json(), name.slice(5).split("."))), `webhook ${name}`);
    else if (name.startsWith("headers.")) {
      const key = name.slice(8).toLowerCase();
      put(name, Object.hasOwn(headers, key) ? headers[key] : "", `webhook header ${key}`);
    } else if (name.startsWith("query.")) {
      const key = name.slice(6);
      put(name, Object.hasOwn(query, key) ? query[key] : "", `webhook query ${key}`);
    }
  }
  return renderRoutinePrompt(template, values, untrusted);
}

module.exports = { DEFAULT_SIGNING_HEADER, hookIdOf, newHookSecret, hookUrl, verifySignature, webhookPrompt };
