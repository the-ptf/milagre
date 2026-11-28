const { randomBytes, timingSafeEqual } = require("node:crypto");

const SEALED_HEADER = "x-milagre-sealed";
const SEALED_VALUE = randomBytes(24).toString("hex");

/**
 * Whether a bridge request came through this process's end-to-end channel (relay, LAN or Tailscale), which stamps
 * each request it forwards. A Cloudflare tunnel or another HTTPS proxy reaches the bridge after TLS ends at the proxy,
 * so it can read what it carries: secret values must not travel that way.
 */
function isSealed(req) {
  const given = Buffer.from(String(req?.headers?.[SEALED_HEADER] ?? ""));
  const expected = Buffer.from(SEALED_VALUE);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

module.exports = { SEALED_HEADER, SEALED_VALUE, isSealed };
