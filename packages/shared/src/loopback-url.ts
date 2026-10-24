// http://localhost:5173, http://127.0.0.1:3000/x, http://[::1]:8080, http://0.0.0.0:4000: a web link whose host means
// "the machine the server runs on". The host part ends at the port, path, query or hash.
const LOOPBACK_LINK = /^(https?:\/\/)(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])(?=[:/?#]|$)/i;

/** Whether a link points at the loopback of the machine that wrote it. */
export const isLoopbackUrl = (href: string) => LOOPBACK_LINK.test(href.trim());

/**
 * A link an agent wrote on another machine, pointed at `host`: the address the user reaches that machine on (its LAN or
 * Tailscale IP). Its port, path and query stay. Anything else, or no host, comes back as it was.
 */
export function reachableUrl(href: string, host: string | null | undefined): string {
  if (!host) return href;
  const text = href.trim();
  if (!LOOPBACK_LINK.test(text)) return href;
  return text.replace(LOOPBACK_LINK, `$1${host.includes(":") ? `[${host}]` : host}`);
}

/** Whether a server listening on `address` ("*", "0.0.0.0", "127.0.0.1", "::1") answers on another machine's address. */
export const listensBeyondLoopback = (address: string) => !/^(127\.|::1$|localhost$)/.test(address);
