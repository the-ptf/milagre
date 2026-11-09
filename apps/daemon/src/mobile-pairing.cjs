const os = require("node:os");
const { execFileSync } = require("node:child_process");

// This Mac's name is asked on every change to the computers list and every dial, and scutil holds the daemon's event
// loop until it answers, so it is looked up once per host: a Mac renamed in System Settings keeps its old name here
// until the host restarts.
/** @type {string | null} */
let thisMac = null;

/**
 * This Mac's name (System Settings › General › About), else its hostname. Asked with `options`, it is looked up again
 * each time.
 * @param {Parameters<typeof lookUpName>[0]} [options]
 */
function computerName(options) {
  if (options === undefined && thisMac !== null) return thisMac;
  const name = lookUpName(options);
  if (options === undefined) thisMac = name;
  return name;
}

function lookUpName({ platform = process.platform, run = execFileSync, hostname = os.hostname } = {}) {
  if (platform === "darwin") {
    try {
      const name = String(run("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] })).trim();
      if (name) return name;
    } catch {
      /* fall back to the hostname */
    }
  }
  return hostname().replace(/\.local$/i, "");
}

function pairingLink({ address, token, name, access }) {
  let url;
  try {
    url = new URL(address);
  } catch {
    throw new Error("The pairing address must be a URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The pairing address must use http or https.");
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/i.test(token)) throw new Error("The pairing token must be 64 hex characters.");
  if (access && (url.protocol !== "https:" || !/^[a-f0-9]{32}\.access$/.test(access.id) || !/^[A-Za-z0-9_-]{32,128}$/.test(access.secret)))
    throw new Error("The Cloudflare access token needs an HTTPS address, an id ending in .access and its secret.");
  // The Access service token rides along so the phone can pass Cloudflare's edge.
  const cloudflare = access ? `&cfId=${encodeURIComponent(access.id)}&cfSecret=${encodeURIComponent(access.secret)}` : "";
  return `milagre://pair?address=${encodeURIComponent(address)}&token=${token}&name=${encodeURIComponent(name ?? "")}${cloudflare}`;
}

/** The QR for a Mac that is reached through the relay: the relay's origin, this Mac's id and public key, and the token. */
function relayPairingLink({ relay, hostId, key, token, name, direct }) {
  let url;
  try {
    url = new URL(relay);
  } catch {
    throw new Error("The relay address must be a URL.");
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error("The relay address must use ws or wss.");
  if (typeof hostId !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(hostId)) throw new Error("The host id must be 22 base64url characters.");
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("The host key must be 43 base64url characters.");
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/i.test(token)) throw new Error("The pairing token must be 64 hex characters.");
  const routes = direct?.length ? `&direct=${encodeURIComponent(JSON.stringify(direct))}` : "";
  return `milagre://pair?relay=${encodeURIComponent(url.origin)}&host=${hostId}&key=${key}&token=${token}&name=${encodeURIComponent(name ?? "")}${routes}`;
}

module.exports = { computerName, pairingLink, relayPairingLink };
