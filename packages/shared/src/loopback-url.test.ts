import assert from "node:assert/strict";
import { test } from "node:test";
import { isLoopbackUrl, listensBeyondLoopback, loopbackOnlyPorts, openablePageUrl, reachableUrl } from "./loopback-url.ts";

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

test("a link to a server that listens on loopback only stays as written: its IP link would not answer", () => {
  const loopbackOnly = loopbackOnlyPorts([
    { port: 5175, address: "127.0.0.1" },
    { port: 5174, address: "*" },
    { port: 3000, address: "::1" },
    { port: 3000, address: "*" },
    { port: 80, address: "127.0.0.1" },
  ]);
  assert.deepEqual([...loopbackOnly].sort(), [5175, 80].sort());
  assert.equal(reachableUrl("http://127.0.0.1:5175", "10.0.0.4", loopbackOnly), "http://127.0.0.1:5175");
  assert.equal(reachableUrl("http://localhost/", "10.0.0.4", loopbackOnly), "http://localhost/");
  assert.equal(reachableUrl("http://localhost:5174", "10.0.0.4", loopbackOnly), "http://10.0.0.4:5174");
  assert.equal(reachableUrl("http://localhost:3000", "10.0.0.4", loopbackOnly), "http://10.0.0.4:3000");
  // A port nobody saw listening is the best guess: the computer's address.
  assert.equal(reachableUrl("http://localhost:8080", "10.0.0.4", loopbackOnly), "http://10.0.0.4:8080");
});

test("a streamed page opens here at an address this device reaches, or says why it can't", () => {
  assert.deepEqual(openablePageUrl("http://127.0.0.1:8789/kikah.pdf", { remote: false }), { href: "http://127.0.0.1:8789/kikah.pdf", reason: "" });
  assert.deepEqual(openablePageUrl("https://example.com/a", { remote: true }), { href: "https://example.com/a", reason: "" });
  assert.deepEqual(openablePageUrl("http://127.0.0.1:8789/kikah.pdf", { remote: true, host: "192.168.2.20" }), {
    href: "http://192.168.2.20:8789/kikah.pdf",
    reason: "",
  });
  assert.match(openablePageUrl("http://localhost:3000/", { remote: true, host: null }).reason, /relay only/);
  assert.equal(openablePageUrl("http://localhost:3000/", { remote: true, host: null }).href, null);
  assert.deepEqual(openablePageUrl("http://localhost:3000/", { remote: true, host: "100.64.0.2", loopbackOnly: new Set([3000]) }), {
    href: null,
    reason: "This server listens on its computer's localhost only",
  });
  assert.equal(openablePageUrl("about:blank", { remote: false }).href, null);
});
