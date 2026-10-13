const test = require("node:test");
const assert = require("node:assert/strict");
const { createArtifactPreviews } = require("./artifact-preview.cjs");
test("artifact previews have unguessable URLs, independent CSP and owner-scoped cleanup", async () => {
  const previews = createArtifactPreviews();
  const url = previews.register(12, '<button onclick="this.textContent=2">1</button>');
  assert.match(url, /^milagre-artifact:\/\/preview\/[a-f0-9]{48}$/);
  const response = previews.handle(new Request(url));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Security-Policy"), /default-src 'none'/);
  assert.match(response.headers.get("Content-Security-Policy"), /script-src 'unsafe-inline'/);
  assert.match(await response.text(), /onclick/);
  assert.equal(previews.handle(new Request(`${url}?anything`)).status, 404);
  assert.equal(previews.handle(new Request(url, { method: "POST" })).status, 404);
  previews.release(99, url);
  assert.equal(previews.handle(new Request(url)).status, 200);
  previews.clear(12);
  assert.equal(previews.handle(new Request(url)).status, 404);
});
test("artifact preview registration bounds individual and total retained data", () => {
  const previews = createArtifactPreviews();
  assert.throws(() => previews.register(1, null), /too large/);
  assert.throws(() => previews.register(1, "x".repeat(8 * 1024 * 1024 + 1)), /too large/);
  const body = "x".repeat(8 * 1024 * 1024);
  for (let i = 0; i < 7; i++) previews.register(1, body);
  assert.throws(() => previews.register(1, body), /Too many/);
  previews.clear(1);
  assert.ok(previews.register(1, body));
});
