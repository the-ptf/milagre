import assert from "node:assert/strict";
import { test } from "node:test";
import { isLoopbackUrl, listensBeyondLoopback, reachableUrl } from "./loopback-url.ts";

test("a loopback link points at the machine's address, keeping port, path and query", () => {
  assert.equal(reachableUrl("http://localhost:5173", "100.69.206.111"), "http://100.69.206.111:5173");
  assert.equal(reachableUrl("http://127.0.0.1:3000/app?x=1#top", "192.168.2.179"), "http://192.168.2.179:3000/app?x=1#top");
  assert.equal(reachableUrl("https://0.0.0.0:8443/", "10.0.0.4"), "https://10.0.0.4:8443/");
  assert.equal(reachableUrl("http://[::1]:8080", "10.0.0.4"), "http://10.0.0.4:8080");
  assert.equal(reachableUrl("HTTP://LOCALHOST:4000", "10.0.0.4"), "HTTP://10.0.0.4:4000");
  assert.equal(reachableUrl("http://localhost:4000", "fd00::1"), "http://[fd00::1]:4000");
});

test("other links, and no address, stay as they were", () => {
  for (const href of [
    "https://example.com",
    "http://localhost.evil.com:80",
    "http://localhostx:1",
    "ftp://localhost/x",
    "docs/spec.md",
    "http://user@localhost:1",
  ])
    assert.equal(reachableUrl(href, "10.0.0.4"), href);
  assert.equal(reachableUrl("http://localhost:5173", null), "http://localhost:5173");
  assert.equal(isLoopbackUrl("http://localhost:5173"), true);
  assert.equal(isLoopbackUrl("https://milagre.cloud"), false);
});

test("a server bound to loopback only can't be reached from another machine", () => {
  for (const address of ["127.0.0.1", "::1", "127.0.0.53"]) assert.equal(listensBeyondLoopback(address), false);
  for (const address of ["*", "0.0.0.0", "::", "192.168.2.179"]) assert.equal(listensBeyondLoopback(address), true);
});
