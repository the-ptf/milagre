import { isLoopbackUrl, reachableUrl } from "@milagre/shared/loopback-url";

/** A local/private server needs the computer's network, or an authenticated tunnel when that network is unavailable. */
export function privatePage(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
      isLoopbackUrl(url) ||
      /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|f[cd][\da-f]{2}:|fe80:)/.test(host) ||
      host.endsWith(".local") ||
      !/[.:]/.test(host)
    );
  } catch {
    return false;
  }
}

export function directPageUrl(url: string, host: string | null): string | null {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    if (privatePage(url) && !host) return null;
    return reachableUrl(url, host);
  } catch {
    return null;
  }
}

/** Legacy HTTP pairing already proves a route to a private address, even without the route supervisor. */
export function pairedPageHost(connection: string | undefined): string | null {
  try {
    const url = new URL(connection ?? "");
    return ["http:", "https:"].includes(url.protocol) && privatePage(url.href) ? url.hostname.replace(/^\[|\]$/g, "") : null;
  } catch {
    return null;
  }
}

/** Keep comments and the address bar in the original site's coordinates, without leaking the proxy's login URL. */
export function originalPageUrl(url: string, original: string, loaded: string): string {
  try {
    const page = new URL(url),
      source = new URL(original),
      routed = new URL(loaded);
    return page.origin === routed.origin ? source.origin + page.pathname + page.search + page.hash : url;
  } catch {
    return original;
  }
}

/** A second browser needs its own cookie, but should open the path currently being viewed. */
export function externalPageUrl(url: string, bootstrap: string, proxyOrigin: string): string {
  const page = new URL(url);
  if (page.origin !== proxyOrigin) return url;
  const login = new URL(bootstrap);
  login.searchParams.set("path", page.pathname + page.search + page.hash);
  return login.href;
}
