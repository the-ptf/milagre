const os = require("node:os");

// Tunnels, VM bridges and Apple's peer-to-peer links: a phone on the Wi-Fi can't reach these.
const VIRTUAL = /^(utun|bridge|vmnet|awdl|llw|gif|stf|anpi|ap)\d*/;

// Tailscale gives each machine a 100.64.0.0/10 address on a utun; a phone or a Mac on the same tailnet dials it from anywhere.
const TAILNET_IFACE = /^utun\d+$/;

function octets(address) {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function isPrivate(address) {
  const [a, b] = octets(address) ?? [];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isTailnet(address) {
  const [a, b] = octets(address) ?? [];
  return a === 100 && b >= 64 && b <= 127;
}

const sorted = (set) => [...set].toSorted((a, b) => a.localeCompare(b, "en", { numeric: true }));

/**
 * The addresses a phone or a paired Mac can dial: private LAN addresses first, then tailnet ones, which are slower but
 * answer away from home. Numbers only: a name like `mac.local` can resolve to another machine on another network, and
 * the phone would hand it a hello. Another VPN in 100.64.0.0/10 (Cloudflare WARP) is listed too; it just never answers.
 */
function lanAddresses(interfaces = os.networkInterfaces()) {
  const lan = new Set();
  const tailnet = new Set();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if ((entry.family !== "IPv4" && entry.family !== 4) || entry.internal) continue;
      if (!VIRTUAL.test(name) && isPrivate(entry.address)) lan.add(entry.address);
      else if (TAILNET_IFACE.test(name) && isTailnet(entry.address)) tailnet.add(entry.address);
    }
  }
  return [...sorted(lan), ...sorted(tailnet).filter((address) => !lan.has(address))];
}

module.exports = { lanAddresses };
