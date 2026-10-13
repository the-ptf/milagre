import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { validateDesignPageSnapshot, renderDesignPage } from "@milagre/shared/design-page";
import { authorized, boundedBody, CHUNK_BYTES, createPageService, createQuotaService, digest, MAX_BODY_BYTES, quotaLimits, routeRequest } from "./service.mjs";

function memory() {
  const map = new Map();
  return {
    get: (key) => structuredClone(map.get(key)),
    put: (key, value) => map.set(key, structuredClone(value)),
    delete: (key) => map.delete(key),
    keys: (prefix) => [...map.keys()].filter((key) => key.startsWith(prefix)),
    transaction(callback) {
      const before = new Map(map);
      try {
        return callback();
      } catch (error) {
        map.clear();
        for (const [key, value] of before) map.set(key, value);
        throw error;
      }
    },
  };
}

async function fixture(options = {}) {
  const bytes = randomBytes(32);
  const secret = bytes.toString("base64url");
  const id = await digest(bytes);
  const storage = memory();
  const reservations = [];
  const settings = {
    storage,
    validate(value) {
      if (typeof value?.title !== "string") throw new Error("private validation details");
      return { title: value.title };
    },
    render: (value) => `<html>${value.title}</html>`,
    admit: async () => true,
    reserve: async (ip, size) => {
      reservations.push({ ip, size });
      return true;
    },
    ...options,
  };
  const service = createPageService(settings);
  const request = (method, body = { title: "Page" }, headers = {}) =>
    new Request(`https://share.milagre.cloud/${method === "GET" || method === "HEAD" ? "s" : "api/pages"}/${id}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", ...headers },
      ...(method === "PUT" ? { body: JSON.stringify(body) } : {}),
    });
  const send = (method, body, headers) => service.fetch(request(method, body, headers), id, "192.0.2.1");
  return { id, secret, storage, service, settings, request, send, reservations };
}

test("create is immutable, identical retries survive service restart, and public responses do not contain the secret", async () => {
  const f = await fixture();
  const first = await f.send("PUT");
  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), { id: f.id, path: `/s/${f.id}` });
  const restarted = createPageService(f.settings);
  assert.equal((await restarted.fetch(f.request("PUT"), f.id, "192.0.2.1")).status, 200);
  assert.equal((await f.send("PUT", { title: "Changed" })).status, 409);
  assert.equal(f.reservations.length, 1);
  const publicPage = await f.send("GET", undefined, { Authorization: "" });
  assert.equal(publicPage.status, 200);
  assert.equal(await publicPage.text(), "<html>Page</html>");
  assert.equal(publicPage.headers.get("cache-control"), "no-store");
  assert.match(publicPage.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(publicPage.headers.get("referrer-policy"), "no-referrer");
  assert.match(publicPage.headers.get("x-robots-tag"), /noindex/);
  assert.equal(publicPage.headers.get("access-control-allow-origin"), null);
  assert.ok(!JSON.stringify(f.storage.get("meta")).includes(f.secret));
  assert.equal((await f.send("HEAD")).status, 200);
  assert.equal(await (await f.send("HEAD")).text(), "");
});

test("revoke deletes bytes and permanently prevents publication under the same id", async () => {
  const f = await fixture();
  assert.equal((await f.send("PUT")).status, 201);
  assert.equal((await f.send("DELETE")).status, 204);
  assert.equal((await f.send("DELETE")).status, 204);
  assert.equal((await f.send("GET")).status, 404);
  assert.equal((await f.send("PUT")).status, 410);
  assert.deepEqual(f.storage.keys("html:"), []);
  assert.deepEqual(f.storage.get("meta"), { deleted: true });
  assert.equal(f.reservations.length, 1);
});

test("revoke before delayed upload reserves a durable tombstone and prevents publication", async () => {
  const f = await fixture();
  assert.equal((await f.send("DELETE")).status, 204);
  assert.deepEqual(f.storage.get("meta"), { deleted: true });
  const restarted = createPageService(f.settings);
  assert.equal((await restarted.fetch(f.request("PUT"), f.id, "192.0.2.1")).status, 410);
  assert.equal((await f.send("DELETE")).status, 204);
  assert.equal((await f.send("GET")).status, 404);
  assert.deepEqual(f.reservations, [{ ip: "192.0.2.1", size: 1024 }]);
});

test("quota exhaustion refuses a new tombstone but does not block revoking an existing page", async () => {
  const denied = await fixture({ reserve: async () => false });
  assert.equal((await denied.send("DELETE")).status, 429);
  assert.equal(denied.storage.get("meta"), undefined);
  let allowed = true;
  const existing = await fixture({ reserve: async () => allowed });
  assert.equal((await existing.send("PUT")).status, 201);
  allowed = false;
  assert.equal((await existing.send("DELETE")).status, 204);
  assert.equal((await existing.send("PUT")).status, 410);
});

test("a secret for another page cannot publish or revoke; noncanonical secrets are rejected", async () => {
  const f = await fixture();
  const wrong = `Bearer ${randomBytes(32).toString("base64url")}`;
  for (const method of ["PUT", "DELETE"]) assert.equal((await f.send(method, undefined, { Authorization: wrong })).status, 401);
  assert.equal(await authorized(f.request("PUT"), f.id), true);
  const secretBytes = new Uint8Array(32);
  const zeroId = await digest(secretBytes);
  const alternate = new Request("https://test", { headers: { Authorization: `Bearer ${"A".repeat(42)}B` } });
  assert.equal(await authorized(alternate, zeroId), false);
});

test("simultaneous create and changed create cannot overwrite one another", async () => {
  const f = await fixture();
  const results = await Promise.all([f.send("PUT"), f.send("PUT", { title: "Other" }), f.send("PUT")]);
  assert.deepEqual(
    results.map((r) => r.status),
    [201, 409, 200],
  );
  assert.equal(f.reservations.length, 1);
  assert.equal(await (await f.send("GET")).text(), "<html>Page</html>");
});

test("invalid, compressed, and oversized content never reaches storage or quota", async () => {
  const f = await fixture();
  assert.equal((await f.send("PUT", {})).status, 400);
  assert.equal((await f.send("PUT", undefined, { "Content-Type": "text/html" })).status, 415);
  assert.equal((await f.send("PUT", undefined, { "Content-Encoding": "gzip" })).status, 415);
  assert.equal((await f.send("PUT", undefined, { "Content-Length": String(MAX_BODY_BYTES + 1) })).status, 413);
  assert.equal(f.storage.get("meta"), undefined);
  assert.equal(f.reservations.length, 0);
});

test("streaming body stops at the byte limit even when Content-Length lies", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("https://test", { method: "PUT", body: stream, duplex: "half", headers: { "Content-Length": "1" } });
  await assert.rejects(boundedBody(request, 10), { status: 413 });
  assert.equal(cancelled, true);
});

test("HTML chunks preserve Unicode across byte boundaries and revoke removes every chunk", async () => {
  const html = "x".repeat(CHUNK_BYTES - 1) + "日本語".repeat(CHUNK_BYTES);
  const f = await fixture({ render: () => html });
  assert.equal((await f.send("PUT")).status, 201);
  assert.ok(f.storage.keys("html:").length > 2);
  for (const key of f.storage.keys("html:")) assert.ok(f.storage.get(key).byteLength <= CHUNK_BYTES);
  assert.equal(await (await f.send("GET")).text(), html);
  await f.send("DELETE");
  assert.equal(f.storage.keys("html:").length, 0);
});

test("quota or storage failure never exposes partial snapshots", async () => {
  const f = await fixture({ reserve: async () => false });
  assert.equal((await f.send("PUT")).status, 429);
  assert.equal((await f.send("GET")).status, 404);
  const storage = memory();
  const put = storage.put;
  storage.put = (key, value) => {
    if (key === "meta") throw new Error("internal secret");
    put(key, value);
  };
  const broken = await fixture({ storage });
  const failed = await broken.send("PUT");
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes("internal secret"));
  assert.deepEqual(storage.keys("html:"), []);
});

test("quota stays durable, daily limits reset, and lifetime bytes are never refunded", async () => {
  const storage = memory();
  let now = Date.UTC(2026, 9, 12);
  const opts = { storage, limits: { pages: 4, bytes: 90, daily: 2, perIp: 1 }, now: () => now };
  let service = createQuotaService(opts);
  assert.equal(await service.reserve("192.0.2.1", 20), true);
  service = createQuotaService(opts);
  assert.equal(await service.reserve("192.0.2.1", 20), false);
  assert.equal(await service.reserve("192.0.2.2", 20), true);
  assert.equal(await service.reserve("192.0.2.3", 20), false);
  now += 86400000;
  assert.equal(await service.reserve("192.0.2.1", 20), true);
  assert.equal(await service.reserve("192.0.2.2", 31), false);
  assert.equal(await service.reserve("192.0.2.2", 30), true);
  now += 86400000;
  assert.equal(await service.reserve("192.0.2.9", 1), false);
  assert.ok(storage.keys("ip:").every((key) => !key.includes("192.0.2")));
});

test("concurrent quota reservations cannot exceed the global count", async () => {
  const service = createQuotaService({ storage: memory(), limits: { pages: 1, bytes: 100, daily: 1, perIp: 1 } });
  assert.deepEqual(await Promise.all([service.reserve("1", 20), service.reserve("2", 20)]), [true, false]);
  assert.throws(() => quotaLimits({ MAX_TOTAL_PAGES: "NaN" }), /Invalid/);
  assert.throws(() => quotaLimits({ MAX_DAILY_PAGES: "10001" }), /Invalid/);
});

test("public router rejects browser writes, unexpected origins, wrong methods and write query strings", async () => {
  const f = await fixture();
  let calls = 0;
  const env = {
    PUBLIC_ORIGIN: "https://share.milagre.cloud",
    page: async () => {
      calls++;
      return new Response("ok");
    },
  };
  const incoming = (headers = {}) => f.request("PUT", undefined, { "CF-Connecting-IP": "192.0.2.1", ...headers });
  assert.equal((await routeRequest(incoming(), env)).status, 200);
  assert.equal((await routeRequest(incoming({ Origin: "https://share.milagre.cloud" }), env)).status, 403);
  assert.equal((await routeRequest(incoming({ Origin: "null" }), env)).status, 403);
  assert.equal((await routeRequest(incoming({ "Sec-Fetch-Site": "cross-site" }), env)).status, 403);
  assert.equal((await routeRequest(f.request("PUT"), env)).status, 503);
  assert.equal((await routeRequest(new Request(`https://share.milagre.cloud/s/${f.id}?fbclid=tracking`), env)).status, 200);
  assert.equal((await routeRequest(new Request(`https://share.milagre.cloud/s/${f.id}?fbclid=tracking`, { method: "HEAD" }), env)).status, 200);
  assert.equal((await routeRequest(new Request(`https://share.milagre.cloud/api/pages/${f.id}?fbclid=tracking`, incoming()), env)).status, 404);
  assert.equal((await routeRequest(new Request(`https://share.milagre.cloud/s/${f.id}`, { method: "POST" }), env)).status, 405);
  assert.equal((await routeRequest(new Request(`https://share.milagre.cloud/api/pages/${f.id}`), env)).status, 405);
  assert.equal((await routeRequest(new Request(`https://other.test/s/${f.id}`), env)).status, 404);
  assert.equal(calls, 3);
});

test("localhost mode is explicit and forwarded IP headers cannot change ingress identity", async () => {
  const f = await fixture();
  let observed;
  const env = {
    PUBLIC_ORIGIN: "https://share.milagre.cloud",
    page: async (_id, _request, ip) => {
      observed = ip;
      return new Response("ok");
    },
  };
  const request = f.request("PUT", undefined, { "CF-Connecting-IP": "192.0.2.1", "X-Forwarded-For": "evil", "X-Milagre-Client-IP": "evil" });
  assert.equal((await routeRequest(request, env)).status, 200);
  assert.equal(observed, "192.0.2.1");
  const local = new Request(`http://localhost:8787/s/${f.id}`);
  assert.equal((await routeRequest(local, env)).status, 404);
  assert.equal((await routeRequest(local, { ...env, ALLOW_LOCALHOST: "true" })).status, 200);
  assert.equal(observed, "local-preview");
});

test("real shared validation publishes all page designs, escapes titles, and rejects remote assets", async () => {
  const f = await fixture({ validate: validateDesignPageSnapshot, render: renderDesignPage });
  const page = {
    schemaVersion: 1,
    title: "<script>leak()</script>",
    privateChat: "never-upload-chat",
    designs: ["First", "Second"].map((title) => ({ title, document: { schemaVersion: 1, width: 390, height: 844, nodes: [] } })),
  };
  assert.equal((await f.send("PUT", page)).status, 201);
  const html = await (await f.send("GET")).text();
  assert.ok(html.includes("First") && html.includes("Second"));
  assert.ok(html.includes("&lt;script&gt;leak()&lt;/script&gt;"));
  assert.ok(!html.includes("never-upload-chat"));
  assert.ok(!html.includes("<script>leak()</script>"));
  const invalid = structuredClone(page);
  invalid.designs[0].document.nodes.push({ id: "img", type: "image", x: 0, y: 0, width: 100, height: 100, src: "https://evil.example/tracking.png" });
  const other = await fixture({ validate: validateDesignPageSnapshot, render: renderDesignPage });
  assert.equal((await other.send("PUT", invalid)).status, 400);
  assert.equal(other.reservations.length, 0);
});

test("narrow text amplification is rejected before rendering or spending quota", async () => {
  let renders = 0;
  const f = await fixture({
    validate: validateDesignPageSnapshot,
    render: (page) => {
      renders++;
      return renderDesignPage(page);
    },
  });
  const page = {
    schemaVersion: 1,
    title: "Narrow text",
    designs: [
      {
        title: "One",
        document: {
          schemaVersion: 1,
          width: 390,
          height: 844,
          nodes: Array.from({ length: 60 }, (_, i) => ({ id: `text${i}`, type: "text", width: 1, height: 1, fontSize: 2, text: "a".repeat(15000) })),
        },
      },
    ],
  };
  assert.equal((await f.send("PUT", page)).status, 413);
  assert.equal(renders, 0);
  assert.equal(f.reservations.length, 0);
  assert.equal(f.storage.get("meta"), undefined);
});

test("admission authenticates first and refuses an exhausted publisher before parsing, validation or rendering", async () => {
  let checks = 0;
  const f = await fixture({
    admit: async () => {
      checks++;
      return false;
    },
    validate: () => assert.fail("validation must not run"),
    render: () => assert.fail("render must not run"),
  });
  assert.equal((await f.send("PUT", undefined, { Authorization: "Bearer wrong" })).status, 401);
  assert.equal(checks, 0);
  const request = new Request(f.request("PUT"), { method: "PUT", body: "{invalid json" });
  assert.equal((await f.service.fetch(request, f.id, "192.0.2.1")).status, 429);
  assert.equal(request.bodyUsed, false);
  assert.equal(checks, 1);
  assert.equal(f.reservations.length, 0);
});

test("durable admission checks never spend or reset counters, including after a day rollover", async () => {
  const storage = memory();
  let now = Date.UTC(2026, 9, 12);
  const options = { storage, limits: { pages: 3, bytes: 100, daily: 2, perIp: 1 }, now: () => now };
  let quota = createQuotaService(options);
  assert.equal(await quota.admit("192.0.2.1"), true);
  assert.deepEqual(storage.keys(""), []);
  assert.equal(await quota.reserve("192.0.2.1", 20), true);
  quota = createQuotaService(options);
  assert.equal(await quota.admit("192.0.2.1"), false);
  const before = storage.keys("").map((key) => [key, storage.get(key)]);
  assert.equal(await quota.admit("192.0.2.2"), true);
  now += 86400000;
  assert.equal(await quota.admit("192.0.2.1"), true);
  assert.deepEqual(
    storage.keys("").map((key) => [key, storage.get(key)]),
    before,
  );
  assert.equal(await quota.reserve("192.0.2.1", 20), true);
  assert.equal(await quota.reserve("192.0.2.2", 60), true);
  assert.equal(await quota.admit("192.0.2.3"), false);
});

test("quota exhaustion preserves identical retries of a committed snapshot", async () => {
  let admitted = true;
  const f = await fixture({ admit: async () => admitted });
  assert.equal((await f.send("PUT")).status, 201);
  admitted = false;
  assert.equal((await f.send("PUT")).status, 200);
  assert.equal(f.reservations.length, 1);
});

test("public reads load one chunk per pull, cancellation stops reads, and revocation terminates active streams", async () => {
  const storage = memory();
  let reads = 0;
  const get = storage.get;
  storage.get = (key) => {
    if (key.startsWith("html:")) reads++;
    return get(key);
  };
  const f = await fixture({ storage, render: () => "x".repeat(CHUNK_BYTES * 8) });
  assert.equal((await f.send("PUT")).status, 201);
  const pages = await Promise.all(Array.from({ length: 8 }, () => f.send("GET")));
  assert.equal(reads, 0);
  const readers = pages.map((page) => page.body.getReader());
  await Promise.all(readers.map(async (reader) => assert.equal((await reader.read()).value.byteLength, CHUNK_BYTES)));
  assert.equal(reads, 8);
  await readers[0].cancel();
  assert.equal((await readers[0].read()).done, true);
  assert.equal(reads, 8);
  await f.send("DELETE");
  for (const reader of readers.slice(1)) await assert.rejects(reader.read(), /Snapshot revoked/);
  assert.equal(reads, 8);
});

test("rendered size limits return 413 without a quota reservation", async () => {
  const f = await fixture({ render: () => "x".repeat(8 * 1024 * 1024 + 1) });
  assert.equal((await f.send("PUT")).status, 413);
  assert.equal(f.reservations.length, 0);
  const budget = await fixture({
    render: () => {
      throw Object.assign(new Error("budget exceeded"), { status: 413 });
    },
  });
  assert.equal((await budget.send("PUT")).status, 413);
  assert.equal(budget.reservations.length, 0);
});
