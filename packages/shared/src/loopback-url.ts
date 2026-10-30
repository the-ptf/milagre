// http://localhost:5173, http://127.0.0.1:3000/x, http://[::1]:8080, http://0.0.0.0:4000: a web link whose host means
// "the machine the server runs on". The host part ends at the port, path, query or hash.
const LOOPBACK_LINK = /^(https?:\/\/)(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])(?=[:/?#]|$)/i;

/** Whether a link points at the loopback of the machine that wrote it. */
export const isLoopbackUrl = (href: string) => LOOPBACK_LINK.test(href.trim());

/**
 * A link an agent wrote on another machine, pointed at `host`: the address the user reaches that machine on (its LAN or
 * Tailscale IP). Its port, path and query stay. Anything else, or no host, comes back as it was, and so does a link to
 * a port in `loopbackOnly` (loopbackOnlyPorts): that server answers on the machine itself only, so the IP link is dead.
 */
export function reachableUrl(href: string, host: string | null | undefined, loopbackOnly?: ReadonlySet<number>): string {
  if (!host) return href;
  const text = href.trim();
  const match = LOOPBACK_LINK.exec(text);
  if (!match) return href;
  const port = /^:(\d+)/.exec(text.slice(match[0].length))?.[1];
  if (loopbackOnly?.has(port ? Number(port) : /^https/i.test(match[0]) ? 443 : 80)) return href;
  return text.replace(LOOPBACK_LINK, `$1${host.includes(":") ? `[${host}]` : host}`);
}

/** Whether a server listening on `address` ("*", "0.0.0.0", "127.0.0.1", "::1") answers on another machine's address. */
export const listensBeyondLoopback = (address: string) => !/^(127\.|::1$|localhost$)/.test(address);

/** The ports a Chat's servers listen on through loopback alone; one also bound beyond it is reachable and not listed. */
export function loopbackOnlyPorts(ports: ReadonlyArray<{ port: number; address: string }> | null | undefined): ReadonlySet<number> {
  const all = ports ?? [];
  const reachable = new Set(all.filter((entry) => listensBeyondLoopback(entry.address)).map((entry) => entry.port));
  return new Set(all.filter((entry) => !reachable.has(entry.port)).map((entry) => entry.port));
}

/**
 * A page's address as this device opens it in its own browser. `remote`: the page runs on another computer, whose
 * localhost is its own, so a loopback address goes through `host` (that computer's address here) as reply links do. With
 * no host, or for a server on its loopback alone, it can't open here: `href` is null and `reason` says why.
 */
export function openablePageUrl(
  url: string,
  { remote, host, loopbackOnly }: { remote: boolean; host?: string | null; loopbackOnly?: ReadonlySet<number> },
): { href: string | null; reason: string } {
  if (!/^https?:\/\//i.test(url.trim())) return { href: null, reason: "Only web pages open in your browser" };
  if (!remote || !isLoopbackUrl(url)) return { href: url, reason: "" };
  if (!host) return { href: null, reason: "Its computer is reached through the relay only, so its localhost doesn't open here" };
  const href = reachableUrl(url, host, loopbackOnly);
  return isLoopbackUrl(href) ? { href: null, reason: "This server listens on its computer's localhost only" } : { href, reason: "" };
}
