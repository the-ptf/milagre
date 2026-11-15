const LOOPBACK_LINK = /^(https?:\/\/)(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])(?=[:/?#]|$)/i;

export const isLoopbackUrl = (href: string) => LOOPBACK_LINK.test(href.trim());

/**
 * Points a loopback link written on another machine at `host`. Anything else, or no host, comes back as it was, and so
 * does a link
 * to a port in `loopbackOnly`: that server answers on its machine only.
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

export const listensBeyondLoopback = (address: string) => !/^(127\.|::1$|localhost$)/.test(address);

/** Ports that listen through loopback alone; a port also bound beyond it is not listed. */
export function loopbackOnlyPorts(ports: ReadonlyArray<{ port: number; address: string }> | null | undefined): ReadonlySet<number> {
  const all = ports ?? [];
  const reachable = new Set(all.filter((entry) => listensBeyondLoopback(entry.address)).map((entry) => entry.port));
  return new Set(all.filter((entry) => !reachable.has(entry.port)).map((entry) => entry.port));
}

/** `href` is null, with `reason`, when the page can't open on this device. */
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
