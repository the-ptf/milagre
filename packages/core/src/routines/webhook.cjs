// Webhook Routines on the Mac: the URL secret, the optional HMAC check and the first message a delivery words.
const crypto = require("node:crypto");
const { renderRoutinePrompt } = require("@milagre/shared/routine-prompt");

const DEFAULT_SIGNING_HEADER = "sentry-hook-signature";
const PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}/g;
const decoder = new TextDecoder();

const hookIdOf = (secret) => crypto.createHash("sha256").update(secret).digest("hex");

/**
 * A new URL secret (32 random bytes, base64url, 43 characters), its hook id (the secret's hex sha256), and an owner key of
 * its own: never in the URL, it is what moves the hook to this Mac's room at the relay (after a Reset, say).
 */
function newHookSecret() {
  const secret = crypto.randomBytes(32).toString("base64url");
  return { secret, hookId: hookIdOf(secret), ownerKey: newOwnerKey() };
}
const newOwnerKey = () => crypto.randomBytes(32).toString("base64url");

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
 * The values a delivery gives the prompt's placeholders: `{{body}}`, `{{request}}`, `{{body.<path>}}` (JSON),
 * `{{headers.<name>}}` and `{{query.<name>}}`. Every one is text from outside Milagre, so every one is in `untrusted`,
 * labelled with the placeholder itself (which the Routine's author wrote), never a name taken from the request. The URL
 * secret is never part of them.
 */
function webhookFields(template, delivery) {
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
  for (const [, name] of String(template ?? "").matchAll(PLACEHOLDER)) {
    if (Object.hasOwn(values, name)) continue;
    let value;
    if (name === "body") value = body;
    else if (name === "request") {
      const search = new URLSearchParams(query).toString();
      const lines = Object.entries(headers).map(([key, item]) => `${key}: ${item}`);
      value = [`POST${search ? ` ?${search}` : ""}`, ...lines, "", body].join("\n");
    } else if (name.startsWith("body.")) value = asText(atPath(json(), name.slice(5).split(".")));
    else if (name.startsWith("headers.")) {
      const key = name.slice(8).toLowerCase();
      value = Object.hasOwn(headers, key) ? headers[key] : "";
    } else if (name.startsWith("query.")) {
      const key = name.slice(6);
      value = Object.hasOwn(query, key) ? query[key] : "";
    } else continue;
    values[name] = value;
    untrusted[name] = `webhook ${name}`;
  }
  return { values, untrusted };
}

/** A webhook Run's first message: the Routine's prompt filled from the delivery, every value as untrusted data. */
function webhookPrompt(template, delivery) {
  const { values, untrusted } = webhookFields(template, delivery);
  return renderRoutinePrompt(template, values, untrusted);
}

module.exports = { DEFAULT_SIGNING_HEADER, hookIdOf, newHookSecret, newOwnerKey, hookUrl, verifySignature, webhookFields, webhookPrompt };
