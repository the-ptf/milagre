export const RELEASES_API = "https://api.github.com/repos/the-ptf/milagre-ade/releases/latest";
export const RELEASES_PAGE = "https://github.com/the-ptf/milagre-ade/releases/latest";
export const REPO_API = "https://api.github.com/repos/the-ptf/milagre-ade";
export const RECENT_RELEASES_API = "https://api.github.com/repos/the-ptf/milagre-ade/releases?per_page=10";

// Release assets carry the version in their names, so match by pattern.
const TARGETS = {
  "mac-arm64": /^Milagre-.+-arm64\.dmg$/,
  "mac-x64": /^Milagre-.+-x64\.dmg$/,
  "linux-appimage": /^Milagre-.+-x86_64\.AppImage$/,
  "linux-deb": /^Milagre-.+-amd64\.deb$/,
  "linux-rpm": /^Milagre-.+-x86_64\.rpm$/,
  // No Windows build is published yet; until one is, this falls back to the latest release page.
  windows: /^Milagre-.+\.exe$/,
  android: /^Milagre-.*android.*\.apk$/,
};
// The Android APK is attached by hand, not by every release, so it's looked up in the recent releases too.
const SEARCH_RECENT = new Set(["android"]);

function githubInit(token, timeoutMs) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "milagre-site" };
  if (token) headers.authorization = `Bearer ${token}`;
  return { headers, signal: AbortSignal.timeout(timeoutMs) };
}

export async function latestDownload(target, fetchImpl, { token, timeoutMs = 3000 } = {}) {
  const pattern = TARGETS[target];
  if (!pattern) return null;
  try {
    const recent = SEARCH_RECENT.has(target);
    const response = await fetchImpl(recent ? RECENT_RELEASES_API : RELEASES_API, githubInit(token, timeoutMs));
    if (!response.ok) return RELEASES_PAGE;
    const body = await response.json();
    const releases = recent ? (Array.isArray(body) ? body.filter((release) => !release.draft) : []) : [body];
    for (const release of releases) {
      const asset = (release.assets || []).find((item) => pattern.test(item.name));
      if (asset) return asset.browser_download_url;
    }
    return RELEASES_PAGE;
  } catch {
    return RELEASES_PAGE;
  }
}

// The star count for the nav pill, or null when GitHub can't be reached.
export async function repoStars(fetchImpl, { token, timeoutMs = 3000 } = {}) {
  try {
    const response = await fetchImpl(REPO_API, githubInit(token, timeoutMs));
    if (!response.ok) return null;
    const repo = await response.json();
    return Number.isInteger(repo.stargazers_count) ? repo.stargazers_count : null;
  } catch {
    return null;
  }
}

export async function handleRequest(request, { assets, fetchImpl, token }) {
  const url = new URL(request.url);
  if (url.hostname === "www.milagre.cloud" || url.hostname === "www.milagre.dev") {
    url.hostname = url.hostname.slice("www.".length);
    return Response.redirect(url.toString(), 301);
  }
  const download = url.pathname.match(/^\/download\/([a-z0-9-]+)\/?$/);
  if (download) {
    const location = await latestDownload(download[1], fetchImpl, { token });
    if (!location) return new Response("Unknown download", { status: 404 });
    return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
  }
  if (url.pathname === "/api/stars") {
    const stars = await repoStars(fetchImpl, { token });
    return Response.json({ stars }, { headers: { "cache-control": stars === null ? "no-store" : "public, max-age=600" } });
  }
  if (url.pathname === "/" && wantsMarkdown(request)) return markdownHome(request, assets);
  const response = withRange(request, await assets.fetch(request));
  return url.pathname === "/" ? varyOnAccept(await response) : response;
}

// Agents that ask for Markdown (Accept: text/markdown) get the home page as Markdown, public/index.md; browsers keep
// getting HTML. https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/
function wantsMarkdown(request) {
  return /\btext\/markdown\b/i.test(request.headers.get("accept") || "");
}

async function markdownHome(request, assets) {
  const page = await assets.fetch(new Request(new URL("/index.md", request.url), { headers: request.headers }));
  if (!page.ok) return page;
  const text = await page.text();
  return new Response(text, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      // About four characters to a token: an estimate, which is all the header promises.
      "x-markdown-tokens": String(Math.ceil(text.length / 4)),
      "cache-control": page.headers.get("cache-control") || "public, max-age=0, must-revalidate",
      vary: "Accept",
    },
  });
}

// The same URL answers HTML or Markdown, so caches keep the two apart.
function varyOnAccept(response) {
  const headers = new Headers(response.headers);
  headers.set("vary", headers.has("vary") ? `${headers.get("vary")}, Accept` : "Accept");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Safari plays a video only when the server answers byte ranges, so a whole-file answer is cut to the range asked for.
export async function withRange(request, response) {
  const range = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (!range || response.status !== 200 || (!range[1] && !range[2])) return response;
  const body = new Uint8Array(await response.arrayBuffer());
  const size = body.length;
  let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  }
  const headers = new Headers(response.headers);
  headers.set("content-range", `bytes ${start}-${end}/${size}`);
  headers.set("content-length", String(end - start + 1));
  headers.set("accept-ranges", "bytes");
  return new Response(body.slice(start, end + 1), { status: 206, headers });
}
