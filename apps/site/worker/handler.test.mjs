import assert from "node:assert/strict";
import { test } from "node:test";
import { RECENT_RELEASES_API, RELEASES_API, RELEASES_PAGE, REPO_API, handleRequest, latestDownload, repoStars, withRange } from "./handler.mjs";

const release = {
  tag_name: "v0.92.0",
  assets: [
    { name: "Milagre-0.92.0-arm64.dmg.blockmap", browser_download_url: "https://example.test/arm64.dmg.blockmap" },
    { name: "Milagre-0.92.0-arm64.zip", browser_download_url: "https://example.test/arm64.zip" },
    { name: "Milagre-0.92.0-arm64.dmg", browser_download_url: "https://example.test/arm64.dmg" },
    { name: "Milagre-0.92.0-x64.dmg.blockmap", browser_download_url: "https://example.test/x64.dmg.blockmap" },
    { name: "Milagre-0.92.0-x64.dmg", browser_download_url: "https://example.test/x64.dmg" },
    { name: "Milagre-0.92.0-x86_64.AppImage", browser_download_url: "https://example.test/x86_64.AppImage" },
    { name: "Milagre-0.92.0-amd64.deb", browser_download_url: "https://example.test/amd64.deb" },
    { name: "Milagre-0.92.0-x86_64.rpm", browser_download_url: "https://example.test/x86_64.rpm" },
    { name: "milagre-linux-repository.tar.gz", browser_download_url: "https://example.test/repository.tar.gz" },
  ],
};

function github(body, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

const assets = { fetch: async (request) => new Response(`asset ${new URL(request.url).pathname}`) };

test("resolves the Apple Silicon DMG, never its blockmap or zip", async () => {
  const { fetchImpl, calls } = github(release);
  assert.equal(await latestDownload("mac-arm64", fetchImpl), "https://example.test/arm64.dmg");
  assert.equal(calls[0].url, RELEASES_API);
  assert.equal(calls[0].init.headers["user-agent"], "milagre-site");
});

test("resolves the Intel DMG", async () => {
  const { fetchImpl } = github(release);
  assert.equal(await latestDownload("mac-x64", fetchImpl), "https://example.test/x64.dmg");
});

test("gives the GitHub request an abort signal so a stalled API cannot hang the redirect", async () => {
  const { fetchImpl, calls } = github(release);
  await latestDownload("mac-arm64", fetchImpl);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("falls back to the releases page when the GitHub request is aborted", async () => {
  const aborted = async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  assert.equal(await latestDownload("mac-arm64", aborted, { timeoutMs: 1 }), RELEASES_PAGE);
});

test("sends a bearer token to GitHub when one is configured", async () => {
  const { fetchImpl, calls } = github(release);
  await latestDownload("mac-arm64", fetchImpl, { token: "ghp_test" });
  assert.equal(calls[0].init.headers.authorization, "Bearer ghp_test");
});

test("sends no authorization header without a token", async () => {
  const { fetchImpl, calls } = github(release);
  await latestDownload("mac-arm64", fetchImpl);
  assert.equal("authorization" in calls[0].init.headers, false);
});

test("handleRequest forwards the token to the GitHub lookup", async () => {
  const { fetchImpl, calls } = github(release);
  await handleRequest(new Request("https://milagre.cloud/download/mac-arm64"), { assets, fetchImpl, token: "ghp_test" });
  assert.equal(calls[0].init.headers.authorization, "Bearer ghp_test");
});

test("returns null for an unknown target without calling GitHub", async () => {
  const { fetchImpl, calls } = github(release);
  assert.equal(await latestDownload("amiga", fetchImpl), null);
  assert.equal(calls.length, 0);
});

test("falls back to the releases page when GitHub rate-limits", async () => {
  const { fetchImpl } = github({ message: "API rate limit exceeded" }, 403);
  assert.equal(await latestDownload("mac-arm64", fetchImpl), RELEASES_PAGE);
});

test("falls back to the releases page when the fetch throws", async () => {
  assert.equal(
    await latestDownload("mac-arm64", async () => {
      throw new Error("offline");
    }),
    RELEASES_PAGE,
  );
});

test("falls back to the releases page when the release has no DMG for that arch", async () => {
  const { fetchImpl } = github({ assets: [{ name: "Milagre-0.93.0-x64.exe", browser_download_url: "https://example.test/x64.exe" }] });
  assert.equal(await latestDownload("mac-arm64", fetchImpl), RELEASES_PAGE);
});

test("/download/mac-arm64 redirects with 302 and no caching", async () => {
  const { fetchImpl } = github(release);
  const response = await handleRequest(new Request("https://milagre.cloud/download/mac-arm64"), { assets, fetchImpl });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://example.test/arm64.dmg");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("/download/<unknown> is a 404", async () => {
  const { fetchImpl } = github(release);
  const response = await handleRequest(new Request("https://milagre.cloud/download/linux"), { assets, fetchImpl });
  assert.equal(response.status, 404);
});

test("www redirects permanently to the apex, keeping path and query", async () => {
  const { fetchImpl } = github(release);
  const response = await handleRequest(new Request("https://www.milagre.cloud/download/mac-x64?ref=x"), { assets, fetchImpl });
  assert.equal(response.status, 301);
  assert.equal(response.headers.get("location"), "https://milagre.cloud/download/mac-x64?ref=x");
  const dev = await handleRequest(new Request("https://www.milagre.dev/?ref=x"), { assets, fetchImpl });
  assert.equal(dev.status, 301);
  assert.equal(dev.headers.get("location"), "https://milagre.dev/?ref=x");
});

test("every other path is served from static assets", async () => {
  const { fetchImpl, calls } = github(release);
  const response = await handleRequest(new Request("https://milagre.cloud/"), { assets, fetchImpl });
  assert.equal(await response.text(), "asset /");
  assert.equal(calls.length, 0);
});

test("reads the star count from the repository", async () => {
  const { fetchImpl, calls } = github({ stargazers_count: 1234 });
  assert.equal(await repoStars(fetchImpl), 1234);
  assert.equal(calls[0].url, REPO_API);
});

test("serves the star count as JSON and caches it", async () => {
  const { fetchImpl } = github({ stargazers_count: 42 });
  const response = await handleRequest(new Request("https://milagre.cloud/api/stars"), { assets, fetchImpl });
  assert.deepEqual(await response.json(), { stars: 42 });
  assert.equal(response.headers.get("cache-control"), "public, max-age=600");
});

test("serves null stars without caching when GitHub fails", async () => {
  const { fetchImpl } = github({ message: "rate limited" }, 403);
  const response = await handleRequest(new Request("https://milagre.cloud/api/stars"), { assets, fetchImpl });
  assert.deepEqual(await response.json(), { stars: null });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("answers a byte range with 206 and only those bytes, as Safari needs for video", async () => {
  const file = () => new Response(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), { headers: { "content-type": "video/mp4" } });
  const ranged = (range) => withRange(new Request("https://milagre.cloud/demo/phone.mp4", { headers: { range } }), file());
  const first = await ranged("bytes=0-1");
  assert.equal(first.status, 206);
  assert.equal(first.headers.get("content-range"), "bytes 0-1/10");
  assert.equal(first.headers.get("content-type"), "video/mp4");
  assert.deepEqual([...new Uint8Array(await first.arrayBuffer())], [0, 1]);
  assert.deepEqual([...new Uint8Array(await (await ranged("bytes=8-")).arrayBuffer())], [8, 9]);
  assert.deepEqual([...new Uint8Array(await (await ranged("bytes=-3")).arrayBuffer())], [7, 8, 9]);
  assert.equal((await ranged("bytes=20-")).status, 416);
  const whole = await withRange(new Request("https://milagre.cloud/demo/phone.mp4"), file());
  assert.equal(whole.status, 200);
});

test("resolves the Linux AppImage, .deb and .rpm, never the repository archive", async () => {
  const { fetchImpl } = github(release);
  assert.equal(await latestDownload("linux-appimage", fetchImpl), "https://example.test/x86_64.AppImage");
  assert.equal(await latestDownload("linux-deb", fetchImpl), "https://example.test/amd64.deb");
  assert.equal(await latestDownload("linux-rpm", fetchImpl), "https://example.test/x86_64.rpm");
});

test("sends Windows to the latest release page until a Windows installer is published", async () => {
  const { fetchImpl } = github(release);
  assert.equal(await latestDownload("windows", fetchImpl), RELEASES_PAGE);
  const withExe = { ...release, assets: [...release.assets, { name: "Milagre-0.92.0-x64.exe", browser_download_url: "https://example.test/x64.exe" }] };
  assert.equal(await latestDownload("windows", github(withExe).fetchImpl), "https://example.test/x64.exe");
});

test("finds the Android APK in the newest recent release that has one, skipping drafts", async () => {
  const apk = (version) => ({ name: `Milagre-${version}-android-beta.apk`, browser_download_url: `https://example.test/${version}.apk` });
  const releases = [
    { draft: true, assets: [apk("draft")] },
    { draft: false, assets: release.assets },
    { draft: false, assets: [...release.assets, apk("0.91.0")] },
    { draft: false, assets: [apk("0.90.0")] },
  ];
  const { fetchImpl, calls } = github(releases);
  assert.equal(await latestDownload("android", fetchImpl), "https://example.test/0.91.0.apk");
  assert.equal(calls[0].url, RECENT_RELEASES_API);
  assert.equal(await latestDownload("android", github([{ draft: false, assets: release.assets }]).fetchImpl), RELEASES_PAGE);
});

test("an agent asking for Markdown gets the home page as Markdown; browsers keep HTML, and both vary on Accept", async () => {
  const markdown = await handleRequest(new Request("https://milagre.cloud/", { headers: { accept: "text/markdown, text/html;q=0.8" } }), {
    assets,
    fetchImpl: github({}).fetchImpl,
  });
  assert.equal(markdown.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(await markdown.text(), "asset /index.md");
  assert.equal(markdown.headers.get("x-markdown-tokens"), "4");
  assert.equal(markdown.headers.get("vary"), "Accept");
  const html = await handleRequest(new Request("https://milagre.cloud/", { headers: { accept: "text/html" } }), { assets, fetchImpl: github({}).fetchImpl });
  assert.equal(await html.text(), "asset /");
  assert.equal(html.headers.get("vary"), "Accept");
  const other = await handleRequest(new Request("https://milagre.cloud/privacy", { headers: { accept: "text/markdown" } }), {
    assets,
    fetchImpl: github({}).fetchImpl,
  });
  assert.equal(await other.text(), "asset /privacy");
});
