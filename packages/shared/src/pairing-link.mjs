// The pairing link a Mac shows in Settings › Devices, as the phone (apps/mobile/src/pairing.ts) and the desktop's Add
// computer (apps/desktop/electron/computers.cjs) read it. Moved from apps/mobile/src/client.ts and pairing.ts unchanged,
// with `allowLocalRelay` added for tests that run their own relay.

/** A Cloudflare Access service token: the edge drops any request to the host's tunnel without it. */
export function validAccess(value) {
  const access = value;
  if (!access?.id && !access?.secret) return undefined;
  if (!/^[a-f0-9]{32}\.access$/.test(String(access.id)) || !/^[A-Za-z0-9_-]{32,128}$/.test(String(access.secret)))
    throw new Error("This computer's Cloudflare access token is not valid. Scan its code again.");
  return { id: String(access.id), secret: String(access.secret) };
}

export function localEndpoint(input) {
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter your computer's HTTPS address or a local simulator address.");
  }
  const local = url.protocol === "http:" && ["127.0.0.1", "10.0.2.2"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use an HTTPS address, or 127.0.0.1 on iOS / 10.0.2.2 on Android for a local simulator. Enter the token separately.");
  }
  return url.origin;
}

/** An encrypted device channel may use plain WebSockets on a private network. Public endpoints require TLS. */
export function privateDeviceEndpoint(input, { allowLocalRelay = false } = {}) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (url.protocol !== "ws:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;
  const parts = url.hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (allowLocalRelay && a === 127);
}

/**
 * An encrypted device channel: a private address or public relay, the Mac's identity, and its pinned box key.
 * `allowLocalRelay` also takes a relay on this machine (ws://127.0.0.1), which only tests run.
 */
export function validRelay(value, { allowLocalRelay = false } = {}) {
  const relay = value;
  const damaged = () => new Error("This pairing code is damaged. Scan the code again in Settings → Devices on your Mac.");
  let url;
  try {
    url = new URL(String(relay?.url ?? ""));
  } catch {
    throw damaged();
  }
  const local = privateDeviceEndpoint(url.href, { allowLocalRelay });
  if ((url.protocol !== "wss:" && !local) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw damaged();
  if (!/^[A-Za-z0-9_-]{22}$/.test(String(relay?.hostId)) || !/^[A-Za-z0-9_-]{43}$/.test(String(relay?.key))) throw damaged();
  if (
    relay.direct !== undefined &&
    (!Array.isArray(relay.direct) || relay.direct.length > 4 || !relay.direct.every((endpoint) => privateDeviceEndpoint(endpoint, { allowLocalRelay })))
  )
    throw damaged();
  const direct = relay.direct ? [...new Set(relay.direct.map((endpoint) => new URL(endpoint).origin))] : [];
  return {
    url: url.origin,
    hostId: String(relay.hostId),
    key: String(relay.key),
    ...(direct.length ? { direct } : {}),
  };
}
/** A relay computer's address and saved id: there is no URL to show, so its id on the relay stands in. */
export const relayAddress = (hostId) => `relay://${hostId}`;

/** Removes the public fallback from a pairing invitation while keeping its pinned identity and private routes. */
export function privatePairingLink(input) {
  const pairing = parsePairing(input);
  const relay = pairing.relay;
  const direct = [...new Set([...(relay?.direct ?? []), ...(relay && privateDeviceEndpoint(relay.url) ? [relay.url] : [])])];
  if (!relay || !direct.length)
    throw new Error("This code has no private network address. Choose LAN or Tailscale only in Settings → Devices on your Mac and copy its new link.");
  return `milagre://pair?relay=${encodeURIComponent(direct[0])}&host=${relay.hostId}&key=${relay.key}&token=${pairing.token}&name=${encodeURIComponent(pairing.name)}&direct=${encodeURIComponent(JSON.stringify(direct))}`;
}

/** Reads the link the host prints and encodes in its QR code: a direct address (scripts/mobile-pairing.cjs) or the relay (apps/daemon/src/mobile-pairing.cjs). */
export function parsePairing(input, { allowLocalRelay = false } = {}) {
  // React Native's URL does not parse custom schemes or query strings, so the link is read by hand.
  const match = /^milagre(?:-local)?:\/\/\/?pair\/?\?(.*)$/i.exec(input.trim());
  if (!match) throw new Error("That is not a Milagre pairing link. Scan the code your Mac shows, or copy its pairing link.");
  const params = {};
  for (const part of match[1].split("&")) {
    const [key, ...value] = part.split("=");
    try {
      params[decodeURIComponent(key)] = decodeURIComponent(value.join("=").replace(/\+/g, " "));
    } catch {
      /* skip a malformed pair */
    }
  }
  const token = params.token || "";
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error("This pairing link has no valid token. Restart the host on your Mac and scan the new code.");
  if (params.relay !== undefined || params.host !== undefined || params.key !== undefined) {
    // A link names one way to reach the Mac; one with both was not made by Milagre.
    if (params.address !== undefined) throw new Error("This pairing link is damaged. Scan the code again in Settings → Devices on your Mac.");
    let direct;
    try {
      direct = params.direct === undefined ? undefined : JSON.parse(params.direct);
    } catch {
      throw new Error("This pairing link is damaged. Scan the code again in Settings → Devices on your Mac.");
    }
    const relay = validRelay({ url: params.relay, hostId: params.host, key: params.key, direct }, { allowLocalRelay });
    return {
      address: relayAddress(relay.hostId),
      token,
      name: (params.name || "").trim().slice(0, 80) || "Mac",
      relay,
    };
  }
  const address = localEndpoint(params.address || "");
  const name = (params.name || "").trim().slice(0, 80) || address.replace(/^https?:\/\//, "").replace(/[:/].*$/, "");
  const access = validAccess({ id: params.cfId, secret: params.cfSecret });
  if (access && !address.startsWith("https:")) throw new Error("This pairing link has a Cloudflare token but no HTTPS address.");
  return access ? { address, token, name, access } : { address, token, name };
}
