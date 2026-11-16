const crypto = require("node:crypto");
const { renderRoutinePrompt } = require("@milagre/shared/routine-prompt");

const DEFAULT_SIGNING_HEADER = "sentry-hook-signature";
const PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}/g;
const decoder = new TextDecoder();

const hookIdOf = (secret) => crypto.createHash("sha256").update(secret).digest("hex");

function newHookSecret() {
  const secret = crypto.randomBytes(32).toString("base64url");
  return { secret, hookId: hookIdOf(secret), ownerKey: newOwnerKey() };
}
const newOwnerKey = () => crypto.randomBytes(32).toString("base64url");

function hookUrl(relayUrl, secret) {
  const base = String(relayUrl).replace(/^wss:/i, "https:").replace(/^ws:/i, "http:").replace(/\/+$/, "");
  return `${base}/hook/${secret}`;
}

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

function atPath(value, segments) {
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}
const asText = (value) => (value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value));

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

function webhookPrompt(template, delivery) {
  const { values, untrusted } = webhookFields(template, delivery);
  return renderRoutinePrompt(template, values, untrusted);
}

module.exports = { DEFAULT_SIGNING_HEADER, hookIdOf, newHookSecret, newOwnerKey, hookUrl, verifySignature, webhookFields, webhookPrompt };
