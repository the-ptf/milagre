import test from "node:test";
import assert from "node:assert/strict";
import { directPageUrl, externalPageUrl, originalPageUrl, pairedPageHost, privatePage } from "./browser-page-url.ts";

test("local pages use the reachable computer address, preserving path, query and hash", () => {
  assert.equal(directPageUrl("http://localhost:5173/x?q=1#part", "100.118.127.106"), "http://100.118.127.106:5173/x?q=1#part");
  assert.equal(directPageUrl("https://example.com/x", null), "https://example.com/x");
  for (const url of ["http://127.0.0.1:3000", "http://192.168.2.210:3000", "http://100.118.127.106:3000", "http://santo.local:3000", "http://[fd00::1]:3000"]) {
    assert.equal(privatePage(url), true, url);
    assert.equal(directPageUrl(url, null), null, "private origins use a proxy off the network");
  }
  for (const url of ["file:///tmp/a", "javascript:alert(1)", "http://user:password@localhost"]) assert.equal(directPageUrl(url, null), null);
});

test("a server listening on the Mac's loopback alone goes through the Mac, not its network address", () => {
  const loopbackOnly = new Set([5173]);
  assert.equal(directPageUrl("http://localhost:5173/pricing", "192.168.2.210", loopbackOnly), null);
  assert.equal(directPageUrl("http://localhost:3000/", "192.168.2.210", loopbackOnly), "http://192.168.2.210:3000/");
  assert.equal(directPageUrl("http://localhost:5173/", "127.0.0.1", loopbackOnly), "http://localhost:5173/", "a simulator on the Mac reaches it");
});

test("proxy navigation reports the site's original address without changing external redirects", () => {
  assert.equal(originalPageUrl("https://proxy.test/next?q=1#x", "http://localhost:5173/start", "https://proxy.test"), "http://localhost:5173/next?q=1#x");
  assert.equal(originalPageUrl("https://login.test/auth", "http://localhost:5173", "https://proxy.test"), "https://login.test/auth");
});

test("HTTP pairings preserve their already reachable LAN/Tailscale route", () => {
  assert.equal(pairedPageHost("http://100.118.127.106:8797"), "100.118.127.106");
  assert.equal(pairedPageHost("http://127.0.0.1:8787"), "127.0.0.1");
  assert.equal(pairedPageHost("https://paired.trycloudflare.com"), null);
  assert.equal(pairedPageHost("relay:mac"), null);
});

test("external browser bootstrap follows the current page and leaves external redirects alone", () => {
  const result = new URL(externalPageUrl("https://proxy.test/next?q=1#x", "https://proxy.test/auth", "https://proxy.test"));
  assert.equal(result.pathname, "/auth");
  assert.equal(result.searchParams.get("path"), "/next?q=1#x");
  assert.equal(externalPageUrl("https://login.test/", "https://proxy.test/auth", "https://proxy.test"), "https://login.test/");
});
