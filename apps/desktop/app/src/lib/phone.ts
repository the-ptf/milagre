import type { PhoneStatus } from "../electron";
import { ThisComputer } from "./shortcut-hints.ts";

/** The one line under "Allow devices to connect". */
export function phoneStatusLine(status: PhoneStatus | null): string {
  if (!status) return "Checking…";
  switch (status.state) {
    case "off":
      return "Off";
    case "starting":
      return "Starting…";
    case "error":
      return status.error || "Phone access stopped.";
    case "on":
      if (status.remote === "cloudflare" && status.publicUrl) return `Reachable at ${new URL(status.publicUrl).host}`;
      if (status.remote === "relay") {
        if (status.relay === "online") return "On, reachable from any network";
        if (status.relay === "offline") return "On, can't reach the relay. Retrying…";
        return "On, connecting to the relay…";
      }
      // Without a tunnel the bridge answers on this Mac's loopback only.
      return `${ThisComputer} only — ${status.localUrl ? new URL(status.localUrl).hostname : "127.0.0.1"}`;
  }
}

/** The line under "Allow on local network". Null until the daemon reports it. */
export function phoneLanLine(status: PhoneStatus | null): string | null {
  if (!status?.lan) return null;
  if (!status.lan.enabled) return "Off";
  if (status.lan.error) return `Couldn't listen on the local network: ${status.lan.error}`;
  if (!status.lan.addresses.length) return "Not connected to a local network";
  return `Reachable at ${status.lan.addresses.join(", ")}`;
}

/**
 * Under the Phones list. Remove drops a phone's local and relay routes, but a phone on the Cloudflare tunnel
 * authenticates with the shared token, so it keeps access until the token changes.
 */
export function cloudflarePhonesNote(status: PhoneStatus | null): string | null {
  return status?.remote === "cloudflare" ? "Phones on your Cloudflare tunnel keep access until Reset access." : null;
}

/** Whether new devices may still pair through the relay, and for how many whole minutes (rounded up). */
export function pairingWindow(status: PhoneStatus | null, now: number): { open: boolean; minutes: number } | null {
  if (!status || status.pairingUntil === undefined) return null;
  const left = status.pairingUntil - now;
  return left > 0 ? { open: true, minutes: Math.ceil(left / 60_000) } : { open: false, minutes: 0 };
}

/** The host's QR code is an SVG string; an <img> shows it without letting it run anything. */
export const phoneQrSrc = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
