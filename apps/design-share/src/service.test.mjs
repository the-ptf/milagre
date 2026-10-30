import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { validateDesignPageSnapshot, renderDesignPage } from "@milagre/shared/design-page";
import { authorized, boundedBody, CHUNK_BYTES, createPageService, createQuotaService, digest, PAGE_TTL_MS, quotaLimits, routeRequest } from "./service.mjs";

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
    quotaId: id,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    quota: {
      available: async () => 20 * 1024 ** 3,
      reserve: async (id, operation, size) => {
        reservations.push({ id, operation, size });
        return true;
      },
      commit: async () => true,
      abort: async () => {},
      release: async () => {},
      importPage: async () => {},
    },
    ...options,
  };
  if (options.reserve) settings.quota = { ...settings.quota, reserve: options.reserve };
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

test("create, identical retries survive service restart, and public responses do not contain the secret", async () => {
  const f = await fixture();
  const first = await f.send("PUT");
  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), { id: f.id, path: `/s/${f.id}` });
  const restarted = createPageService(f.settings);
  assert.equal((await restarted.fetch(f.request("PUT"), f.id, "192.0.2.1")).status, 200);
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
  assert.deepEqual(f.reservations, []);
});

test("quota exhaustion never blocks revocation", async () => {
  const denied = await fixture({ reserve: async () => false });
  assert.equal((await denied.send("DELETE")).status, 204);
  assert.deepEqual(denied.storage.get("meta"), { deleted: true });
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

test("simultaneous writes apply one at a time and leave exactly one whole revision", async () => {
  const f = await fixture();
  const results = await Promise.all([f.send("PUT"), f.send("PUT", { title: "Other" }), f.send("PUT", { title: "Other" }), f.send("PUT")]);
  assert.deepEqual(
    results.map((r) => r.status),
    [201, 200, 200, 200],
  );
  assert.equal(f.reservations.length, 3, "the identical retry in the middle is free");
  assert.equal(await (await f.send("GET")).text(), "<html>Page</html>");
  assert.deepEqual(f.storage.keys("html:"), ["html:2:0"]);
});

test("an authorized PUT with changed content replaces the page under the same link", async () => {
  const f = await fixture({ render: (value) => `<html>${value.title}</html>`.padEnd(CHUNK_BYTES * 2 + 10, "x") });
  assert.equal((await f.send("PUT")).status, 201);
  assert.deepEqual(f.storage.keys("html:"), ["html:0", "html:1", "html:2"]);
  const replaced = await f.send("PUT", { title: "Second" });
  assert.equal(replaced.status, 200);
  assert.deepEqual(await replaced.json(), { id: f.id, path: `/s/${f.id}` });
  assert.match(await (await f.send("GET")).text(), /^<html>Second<\/html>/);
  assert.deepEqual(f.storage.keys("html:"), ["html:1:0", "html:1:1", "html:1:2"], "old chunks are removed with the replacement");
  assert.equal(f.storage.get("meta").revision, 1);
  assert.equal(f.reservations.length, 2, "a replacement stores new bytes and spends a reservation");
  assert.equal((await f.send("PUT", { title: "Second" })).status, 200);
  assert.equal(f.reservations.length, 2, "retrying the replacement is free");
  assert.equal((await f.send("DELETE")).status, 204);
  assert.deepEqual(f.storage.keys("html:"), []);
  assert.equal((await f.send("PUT", { title: "Third" })).status, 410);
});

test("a refused replacement leaves the published page untouched", async () => {
  let reserved = true;
  const f = await fixture({ reserve: async () => reserved });
  assert.equal((await f.send("PUT")).status, 201);
  reserved = false;
  assert.equal((await f.send("PUT", { title: "Changed" })).status, 429);
  assert.equal((await f.send("PUT")).status, 200);
  assert.equal(await (await f.send("GET")).text(), "<html>Page</html>");
});

test("a reader of the old revision stops instead of receiving a mixed page", async () => {
  const f = await fixture({ render: (value) => value.title.repeat(CHUNK_BYTES * 3) });
  assert.equal((await f.send("PUT", { title: "a" })).status, 201);
  const reader = (await f.send("GET")).body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "a".repeat(CHUNK_BYTES));
  assert.equal((await f.send("PUT", { title: "b" })).status, 200);
  await assert.rejects(reader.read(), /Snapshot updated/);
  assert.equal(await (await f.send("GET")).text(), "b".repeat(CHUNK_BYTES * 3));
});

test("a page published before revisions existed is replaced and its chunks removed", async () => {
  const f = await fixture();
  f.storage.put("meta", { hash: "legacy", chunks: 2 });
  f.storage.put("html:0", new TextEncoder().encode("<html>Old"));
  f.storage.put("html:1", new TextEncoder().encode("</html>"));
  assert.equal((await f.send("PUT", { title: "New" })).status, 200);
  assert.deepEqual(f.storage.keys("html:"), ["html:1:0"]);
  assert.equal(await (await f.send("GET")).text(), "<html>New</html>");
});

test("invalid, compressed, and oversized content never reaches storage or quota", async () => {
  const f = await fixture();
  assert.equal((await f.send("PUT", {})).status, 400);
  assert.equal((await f.send("PUT", undefined, { "Content-Type": "text/html" })).status, 415);
  assert.equal((await f.send("PUT", undefined, { "Content-Encoding": "gzip" })).status, 415);

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

test("rendered pages above 8 MiB are charged to the shared cap", async () => {
  const f = await fixture({ render: () => "x".repeat(8 * 1024 * 1024 + 1) });
  assert.equal((await f.send("PUT")).status, 201);
  assert.ok(f.reservations[0].size > 8 * 1024 * 1024);
});

test("one interactive Artifact publishes as a sandboxed page, updates in place and can be revoked", async () => {
  const f = await fixture({ validate: validateDesignPageSnapshot, render: renderDesignPage });
  const snapshot = {
    schemaVersion: 1,
    kind: "artifacts",
    title: "Explanation",
    artifacts: [{ title: "Explanation", width: 1280, height: 800, html: '<!doctype html><button onclick="this.textContent=42">Explore</button>' }],
  };
  assert.equal((await f.send("PUT", snapshot)).status, 201);
  assert.equal((await f.send("PUT", snapshot)).status, 200);
  const page = await f.send("GET");
  assert.match(page.headers.get("content-security-policy"), /frame-src 'none'/);
  const html = await page.text();
  assert.match(html, /sandbox="allow-scripts"/);
  assert.match(html, /Explore/);
  assert.doesNotMatch(html, /allow-same-origin|Canvas zoom/);
  snapshot.artifacts[0].html = "<h1>Later edit</h1>";
  assert.equal((await f.send("PUT", snapshot)).status, 200);
  const updated = await (await f.send("GET")).text();
  assert.notEqual(updated, html);
  assert.match(updated, /Later edit/);
  assert.equal((await f.send("DELETE")).status, 204);
  assert.equal((await f.send("GET")).status, 404);
  assert.equal((await f.send("PUT", snapshot)).status, 410);
});

test("public Designs and Artifact pages include escaped social previews and canonical URLs", async () => {
  for (const kind of ["designs", "artifacts"]) {
    const snapshot =
      kind === "designs"
        ? { schemaVersion: 1, title: 'Research "A" & <B>', designs: [{ title: "Screen", document: { schemaVersion: 1, width: 390, height: 844, nodes: [] } }] }
        : {
            schemaVersion: 1,
            kind,
            title: 'Research "A" & <B>',
            artifacts: [{ title: "Page", width: 390, height: 844, html: '<h1>Private source title</h1><meta property="og:title" content="Do not use this">' }],
          };
    const f = await fixture({ validate: validateDesignPageSnapshot, render: renderDesignPage });
    assert.equal((await f.send("PUT", snapshot)).status, 201);
    const original = f.storage.get("html:0").slice();
    const url = `https://share.milagre.cloud/s/${f.id}`;
    const html = await (await f.service.fetch(new Request(url + "?fbclid=tracking"), f.id, "")).text();
    assert.ok(html.includes('<meta property="og:title" content="Research &quot;A&quot; &amp; &lt;B&gt;">'));
    assert.ok(html.includes(`<meta property="og:url" content="${url}">`));
    assert.ok(html.includes('<meta property="og:image" content="https://share.milagre.cloud/og.png">'));
    assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'));
    // Descriptions come from the published content (the design's name, the Artifact's text), never the Artifact's own og:title.
    const description = kind === "designs" ? "Screen" : "Private source title";
    assert.ok(html.includes(`<meta property="og:description" content="${description}">`));
    assert.ok(html.includes(`<meta name="twitter:description" content="${description}">`));
    assert.equal(html.match(/<meta name="description"/g).length, 1);
    assert.doesNotMatch(html, /content="Do not use this"/);
    assert.ok(html.indexOf('property="og:title"') < html.indexOf("</head>"));
    assert.deepEqual(f.storage.get("html:0"), original, "metadata must not mutate stored content");
    assert.equal((await f.send("DELETE")).status, 204);
    const revoked = await f.send("GET");
    assert.equal(revoked.status, 404);
    assert.doesNotMatch(await revoked.text(), /og:title/);
  }
});

test("legacy snapshots gain previews without corrupting Unicode at chunk boundaries", async () => {
  const prefix = "<!doctype html><html><head><title>Old &amp; safe | Milagre Designs</title></head><body>";
  const html = prefix + "a".repeat(CHUNK_BYTES - new TextEncoder().encode(prefix).length - 1) + "🌿".repeat(20) + "</body></html>";
  const f = await fixture();
  const bytes = new TextEncoder().encode(html);
  f.storage.put("meta", { hash: "legacy", chunks: 2 });
  f.storage.put("html:0", bytes.slice(0, CHUNK_BYTES));
  f.storage.put("html:1", bytes.slice(CHUNK_BYTES));
  const rendered = await (await f.send("GET")).text();
  assert.ok(rendered.includes('<meta property="og:title" content="Old &amp; safe">'));
  assert.equal(rendered.replace(/<meta (?:property|name)="(?:og:|twitter:|description)[^>]*>/g, "").replace(/<link rel="canonical"[^>]*>/g, ""), html);
});

test("the public preview image supports GET and HEAD without accessing snapshot storage", async () => {
  const env = {
    PUBLIC_ORIGIN: "https://share.milagre.cloud",
    previewImage: new Uint8Array([137, 80, 78, 71]).buffer,
    page: () => assert.fail("image must not open a page Durable Object"),
  };
  const image = await routeRequest(new Request("https://share.milagre.cloud/og.png"), env);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), new Uint8Array([137, 80, 78, 71]));
  const head = await routeRequest(new Request("https://share.milagre.cloud/og.png", { method: "HEAD" }), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await routeRequest(new Request("https://share.milagre.cloud/og.png", { method: "PUT" }), env)).status, 405);
  assert.equal((await routeRequest(new Request("https://wrong.test/og.png"), env)).status, 404);
});

test("robots.txt blocks every crawler from every path", async () => {
  const env = { PUBLIC_ORIGIN: "https://share.milagre.cloud", page: () => assert.fail("robots.txt must not open a page Durable Object") };
  const robots = await routeRequest(new Request("https://share.milagre.cloud/robots.txt"), env);
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get("content-type"), /^text\/plain/);
  assert.equal(await robots.text(), "User-agent: *\nDisallow: /\n");
  assert.equal(await (await routeRequest(new Request("https://share.milagre.cloud/robots.txt", { method: "HEAD" }), env)).text(), "");
  assert.equal((await routeRequest(new Request("https://share.milagre.cloud/robots.txt", { method: "PUT" }), env)).status, 405);
});

test("active quota is durable, replacement charges are net, and refunds are idempotent", () => {
  const storage = memory();
  const options = { storage, limits: { bytes: 100 } };
  let quota = createQuotaService(options);
  assert.equal(quota.reserve("a", "1", 80), true);
  assert.equal(quota.reserve("a", "1", 80), true);
  assert.equal(quota.reserve("b", "1", 21), false);
  assert.equal(quota.commit("a", "1"), true);
  quota = createQuotaService(options);
  assert.equal(quota.reserve("a", "2", 90), true);
  assert.equal(quota.commit("a", "2"), true);
  assert.equal(storage.get("activeBytes"), 90);
  assert.equal(quota.reserve("a", "3", 30), true);
  assert.equal(storage.get("activeBytes"), 90, "old charge remains until the smaller revision is stored");
  assert.equal(quota.commit("a", "3"), true);
  assert.equal(quota.commit("a", "3"), true);
  assert.equal(storage.get("activeBytes"), 30);
  quota.release("a");
  quota.release("a");
  assert.equal(storage.get("activeBytes"), 0);
  assert.equal(quota.reserve("a", "4", 10), false, "a late upload cannot resurrect a released page");
  assert.equal(quota.reserve("b", "1", 100), true);
  assert.equal(quotaLimits({}).bytes, 20 * 1024 ** 3);
  assert.throws(() => quotaLimits({ MAX_TOTAL_BYTES: "NaN" }), /Invalid/);
});

test("aborts fence delayed reservations and stale commits cannot change later revisions", () => {
  const storage = memory();
  const quota = createQuotaService({ storage, limits: { bytes: 100 } });
  quota.abort("page", "1");
  assert.equal(quota.reserve("page", "1", 80), false);
  assert.equal(quota.reserve("page", "2", 20), true);
  assert.equal(quota.commit("page", "2"), true);
  assert.equal(quota.reserve("page", "3", 90), true);
  quota.abort("page", "3");
  assert.equal(storage.get("activeBytes"), 20);
  assert.equal(quota.reserve("page", "4", 40), true);
  assert.equal(quota.commit("page", "4"), true);
  assert.equal(quota.reserve("page", "3", 90), false);
  assert.equal(quota.commit("page", "2"), false);
  quota.abort("page", "2");
  assert.equal(storage.get("activeBytes"), 40);
});

test("simultaneous pages cannot reserve beyond the one global byte cap", async () => {
  const quota = createQuotaService({ storage: memory(), limits: { bytes: 100 } });
  assert.deepEqual(await Promise.all([quota.reserve("one", "1", 60), quota.reserve("two", "1", 60)]), [true, false]);
});

async function lifecycle(options = {}) {
  const quotaStorage = options.quotaStorage ?? memory();
  const quota = createQuotaService({ storage: quotaStorage, limits: { bytes: 1000000 } });
  let time = 1000;
  let alarm;
  const f = await fixture({
    quota,
    now: () => time,
    setAlarm: async (value) => {
      alarm = value;
    },
    deleteAlarm: async () => {
      alarm = undefined;
    },
    ...options,
  });
  return {
    ...f,
    quota,
    quotaStorage,
    time: (value) => {
      time = value;
    },
    alarm: () => alarm,
  };
}

test("identical republishing renews 30 days, reading does not, and expiry deletes and refunds", async () => {
  const f = await lifecycle();
  assert.equal((await f.send("PUT")).status, 201);
  const charge = f.quotaStorage.get("activeBytes");
  assert.ok(charge > 0);
  assert.equal(f.alarm(), 1000 + PAGE_TTL_MS);
  f.time(2000);
  await f.send("HEAD");
  assert.equal(f.alarm(), 1000 + PAGE_TTL_MS);
  assert.equal((await f.send("PUT")).status, 200);
  assert.equal(f.alarm(), 2000 + PAGE_TTL_MS);
  assert.equal(f.quotaStorage.get("activeBytes"), charge);
  f.time(1000 + PAGE_TTL_MS);
  await f.service.alarm();
  assert.equal((await f.send("HEAD")).status, 200, "an old alarm cannot expire a renewed page");
  f.time(2000 + PAGE_TTL_MS);
  await f.service.alarm();
  assert.equal(f.quotaStorage.get("activeBytes"), 0);
  assert.deepEqual(f.storage.keys("html:"), []);
  assert.equal((await f.send("GET")).status, 404);
  assert.equal((await f.send("PUT")).status, 410);
  assert.equal(f.alarm(), undefined);
});

test("expiry is enforced on reads and streams even before the cleanup alarm runs", async () => {
  const f = await lifecycle({ render: () => "x".repeat(CHUNK_BYTES * 2) });
  await f.send("PUT");
  const reader = (await f.send("GET")).body.getReader();
  await reader.read();
  f.time(1000 + PAGE_TTL_MS);
  await assert.rejects(reader.read(), /Snapshot revoked/);
  assert.equal((await f.send("HEAD")).status, 404);
  assert.equal(f.quotaStorage.get("activeBytes"), 0);
});

test("lost reservation acknowledgement is aborted by a durable alarm after restart", async () => {
  const f = await lifecycle();
  f.settings.quota = {
    ...f.quota,
    reserve: (...args) => {
      f.quota.reserve(...args);
      throw Error("lost reply");
    },
  };
  const interrupted = createPageService(f.settings);
  assert.equal((await interrupted.fetch(f.request("PUT"), f.id)).status, 503);
  assert.ok(f.quotaStorage.get("activeBytes") > 0);
  assert.ok(f.storage.get("pending"));
  const restarted = createPageService({ ...f.settings, quota: f.quota });
  await restarted.alarm();
  assert.equal(f.quotaStorage.get("activeBytes"), 0);
  assert.equal(f.storage.get("pending"), undefined);
  assert.equal((await restarted.fetch(f.request("PUT"), f.id)).status, 201);
});

test("failed local storage restores the prior allocation and leaves its page readable", async () => {
  const f = await lifecycle();
  await f.send("PUT");
  const charge = f.quotaStorage.get("activeBytes");
  const put = f.settings.storage.put;
  f.settings.storage.put = (key, value) => {
    if (key === "meta" && value.hash !== f.storage.get("meta")?.hash) throw Error("disk write failed");
    put(key, value);
  };
  assert.equal((await f.send("PUT", { title: "A much larger replacement" })).status, 503);
  await f.service.alarm();
  assert.equal(f.quotaStorage.get("activeBytes"), charge);
  assert.equal(await (await f.send("GET")).text(), "<html>Page</html>");
});

test("lost commit acknowledgement is recovered without another charge", async () => {
  const f = await lifecycle();
  let dropped = false;
  f.settings.quota = {
    ...f.quota,
    commit: (...args) => {
      const result = f.quota.commit(...args);
      if (!dropped) {
        dropped = true;
        throw Error("lost commit reply");
      }
      return result;
    },
  };
  const interrupted = createPageService(f.settings);
  assert.equal((await interrupted.fetch(f.request("PUT"), f.id)).status, 503);
  const charge = f.quotaStorage.get("activeBytes");
  await createPageService(f.settings).alarm();
  assert.equal(f.quotaStorage.get("activeBytes"), charge);
  assert.equal((await f.send("PUT")).status, 200);
  assert.equal(f.quotaStorage.get("activeBytes"), charge);
});

test("failed refunds retry after restart, and a lost refund reply cannot release twice", async () => {
  for (const lostReply of [false, true]) {
    const f = await lifecycle();
    await f.send("PUT");
    f.settings.quota = {
      ...f.quota,
      release: (id) => {
        if (lostReply) f.quota.release(id);
        throw Error("quota offline");
      },
    };
    const interrupted = createPageService(f.settings);
    assert.equal((await interrupted.fetch(f.request("DELETE"), f.id)).status, 503);
    assert.deepEqual(f.storage.keys("html:"), []);
    assert.equal(f.storage.get("meta").releasePending, true);
    assert.ok(f.alarm());
    const restarted = createPageService({ ...f.settings, quota: f.quota });
    await restarted.alarm();
    assert.equal(f.quotaStorage.get("activeBytes"), 0);
    assert.equal((await restarted.fetch(f.request("DELETE"), f.id)).status, 204);
    assert.equal(f.quotaStorage.get("activeBytes"), 0);
  }
});

test("legacy inventory blocks uploads until complete, accounts surviving HTML and schedules expiry", async () => {
  const quotaStorage = memory();
  quotaStorage.put("total", { pages: 999, bytes: 1000000 });
  const f = await lifecycle({ quotaStorage });
  f.storage.put("meta", { hash: "legacy", chunks: 1 });
  f.storage.put("html:0", new TextEncoder().encode("legacy"));
  assert.equal(f.quota.available("new-page"), 0);
  await f.service.migrate();
  await f.service.migrate();
  assert.equal(quotaStorage.get("activeBytes"), 6, "inventory is idempotent");
  assert.equal(f.alarm(), 1000 + PAGE_TTL_MS);
  f.quota.finishMigration();
  assert.equal(f.quota.available("new-page"), 999994);
  await f.send("DELETE");
  assert.equal(quotaStorage.get("activeBytes"), 0);
});

test("expiry retries its refund after a quota outage without serving or retaining the content", async () => {
  const f = await lifecycle();
  await f.send("PUT");
  const charge = f.quotaStorage.get("activeBytes");
  const interrupted = createPageService({
    ...f.settings,
    quota: {
      ...f.quota,
      release: () => {
        throw Error("quota offline");
      },
    },
  });
  f.time(1000 + PAGE_TTL_MS);
  await assert.rejects(interrupted.alarm(), /quota offline/);
  assert.equal(f.storage.get("meta").deleted, true);
  assert.deepEqual(f.storage.keys("html:"), []);
  assert.equal(f.quotaStorage.get("activeBytes"), charge, "space remains charged until the refund succeeds");
  assert.equal(f.alarm(), 1000 + PAGE_TTL_MS + 60000);
  await createPageService(f.settings).alarm();
  assert.equal(f.quotaStorage.get("activeBytes"), 0);
  assert.equal((await f.send("GET")).status, 404);
});

test("rejected uploads drain their input without decoding or reserving it", async () => {
  const f = await fixture();
  await f.send("DELETE");
  let pulled = 0;
  const body = new ReadableStream(
    {
      pull(controller) {
        if (++pulled <= 12) controller.enqueue(new Uint8Array(1024 * 1024));
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request(f.request("PUT"), { method: "PUT", body, duplex: "half" });
  assert.equal((await f.service.fetch(request, f.id)).status, 410);
  assert.equal(pulled, 13, "forwarding completes before the DO response ends its request lifetime");
  assert.equal(request.bodyUsed, true);
  assert.equal(f.reservations.length, 0);
});

function memoryBucket() {
  const objects = new Map();
  const deleted = [];
  return {
    objects,
    deleted,
    head: async (key) => (objects.has(key) ? { size: objects.get(key).bytes.length, type: objects.get(key).type, etag: '"e"' } : null),
    get: async (key, range) => {
      const object = objects.get(key);
      if (!object) return null;
      const bytes = range ? object.bytes.subarray(range.offset, range.offset + range.length) : object.bytes;
      return { body: new Blob([bytes]).stream() };
    },
    put: async (key, body, { size, sha256, type }) => {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      const { createHash } = await import("node:crypto");
      if (bytes.length !== size || createHash("sha256").update(bytes).digest("hex") !== sha256) throw Error("mismatch");
      objects.set(key, { bytes, type });
    },
    delete: async (keys) => {
      for (const key of keys) {
        objects.delete(key);
        deleted.push(key);
      }
    },
  };
}

async function filesFixture() {
  const { createHash } = await import("node:crypto");
  let clock = 1_000_000;
  const quotaStorage = memory();
  const quota = createQuotaService({ storage: quotaStorage, limits: { bytes: 1_000_000 } });
  const bucket = memoryBucket();
  const alarms = [];
  const f = await fixture({
    validate: validateDesignPageSnapshot,
    render: renderDesignPage,
    quota,
    bucket,
    now: () => clock,
    setAlarm: async (time) => alarms.push(time),
  });
  const file = (bytes) => ({ bytes, hash: createHash("sha256").update(bytes).digest("hex") });
  const upload = (item, headers = {}) =>
    f.service.fetch(
      new Request(`https://share.milagre.cloud/api/pages/${f.id}/files/${item.hash}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${f.secret}`, "Content-Type": "image/png", "Content-Length": String(item.bytes.length), ...headers },
        body: item.bytes,
      }),
      f.id,
    );
  const snapshot = (assets) => ({
    schemaVersion: 1,
    kind: "artifacts",
    title: "Media",
    artifacts: [
      {
        title: "Media",
        html: assets.map((asset) => `<img src="assets/${asset.name}">`).join(""),
        width: 1280,
        height: 800,
        assets: assets.map((asset) => ({ name: asset.name, hash: asset.hash, size: asset.bytes.length, type: "image/png" })),
      },
    ],
  });
  return { ...f, quota, quotaStorage, bucket, alarms, file, upload, snapshot, tick: (ms) => (clock += ms), active: () => quotaStorage.get("activeBytes") };
}

test("an Artifact page's files upload before the snapshot that names them, count toward the quota and go with the page", async () => {
  const f = await filesFixture();
  const a = { name: "a.png", ...f.file(new Uint8Array(3000).fill(1)) };
  const b = { name: "b.png", ...f.file(new Uint8Array(2000).fill(2)) };

  // The snapshot can't name a file the service doesn't have.
  const early = await f.send("PUT", f.snapshot([a]));
  assert.equal(early.status, 409);
  assert.deepEqual(await early.json(), { missing: [a.hash] });

  assert.equal((await f.upload(a)).status, 201);
  assert.equal((await f.upload(a)).status, 200, "an upload retried is kept once");
  assert.equal(f.active(), 3000);
  assert.equal((await f.send("PUT", f.snapshot([a]))).status, 201);
  const charged = f.active();
  assert.ok(charged > 3000, "the page's HTML is charged with its file");
  const page = await f.send("GET", undefined, { Authorization: "" });
  const html = await page.text();
  assert.match(html, new RegExp(`/s/${f.id}/files/${a.hash}`), "the page points at its file");
  assert.match(page.headers.get("content-security-policy"), /media-src https:\/\/share\.milagre\.cloud/);

  // Sharing again with another file: the one it no longer names goes, and its bytes are refunded.
  assert.equal((await f.upload(b)).status, 201);
  assert.equal((await f.send("PUT", f.snapshot([b]))).status, 200);
  assert.deepEqual(f.bucket.deleted, [`pages/${f.id}/${a.hash}`]);
  assert.ok(f.active() < charged);
  assert.deepEqual([...f.bucket.objects.keys()], [`pages/${f.id}/${b.hash}`]);

  // Revoked: every file goes and the whole allocation returns.
  assert.equal((await f.send("DELETE")).status, 204);
  assert.equal(f.bucket.objects.size, 0);
  assert.equal(f.active(), 0);
  assert.equal((await f.upload(b)).status, 410, "a revoked page takes no more files");
});

test("a file uploaded for a publication that never came is removed after an hour, refunding its bytes", async () => {
  const f = await filesFixture();
  const a = { name: "a.png", ...f.file(new Uint8Array(500).fill(3)) };
  assert.equal((await f.upload(a)).status, 201);
  assert.equal(f.active(), 500);
  assert.equal(f.alarms.at(-1), 1_000_000 + 60 * 60 * 1000, "the alarm is set for when it lapses");
  await f.service.alarm();
  assert.equal(f.bucket.objects.size, 1, "not before");
  f.tick(60 * 60 * 1000);
  await f.service.alarm();
  assert.equal(f.bucket.objects.size, 0);
  assert.equal(f.active(), 0);
});

test("an upload is refused without its length, over the size limit, past the quota or when its bytes don't match their hash", async () => {
  const f = await filesFixture();
  const a = { name: "a.png", ...f.file(new Uint8Array(10).fill(4)) };
  const missingLength = new Request(`https://share.milagre.cloud/api/pages/${f.id}/files/${a.hash}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${f.secret}`, "Content-Type": "image/png" },
    body: new Blob([a.bytes]).stream(),
    duplex: "half",
  });
  assert.equal((await f.service.fetch(missingLength, f.id)).status, 411);
  assert.equal((await f.upload(a, { "Content-Length": String(95 * 1024 * 1024 + 1) })).status, 413);
  assert.equal((await f.upload(a, { "Content-Type": "text/html; charset=utf-8" })).status, 415);
  const big = { name: "big.png", ...f.file(new Uint8Array(1_000_001)) };
  assert.equal((await f.upload(big)).status, 429);
  const forged = { bytes: a.bytes, hash: "0".repeat(64) };
  assert.equal((await f.upload(forged)).status, 400);
  assert.equal(f.bucket.objects.size, 0);
  assert.equal(f.active(), 0, "a refused upload holds nothing");
});

test("a page's file is served whole or by byte range, never as a page of the share origin", async () => {
  const { serveFile } = await import("./service.mjs");
  const bucket = memoryBucket();
  bucket.objects.set("k", { bytes: new TextEncoder().encode("0123456789"), type: "video/mp4" });
  bucket.objects.set("doc", { bytes: new TextEncoder().encode("<script>"), type: "text/html" });
  const get = (headers = {}, key = "k", method = "GET") => serveFile(bucket, key, new Request("https://share.milagre.cloud/x", { method, headers }));
  const whole = await get();
  assert.equal(whole.status, 200);
  assert.equal(await whole.text(), "0123456789");
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.equal(whole.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(whole.headers.get("content-disposition"), "inline");
  const part = await get({ Range: "bytes=2-4" });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 2-4/10");
  assert.equal(await part.text(), "234");
  assert.equal(await (await get({ Range: "bytes=7-" })).text(), "789");
  assert.equal(await (await get({ Range: "bytes=-3" })).text(), "789");
  assert.equal((await get({ Range: "bytes=20-" })).status, 416);
  assert.equal((await get({}, "doc")).headers.get("content-disposition"), "attachment");
  assert.equal((await get({}, "k", "HEAD")).headers.get("content-length"), "10");
  assert.equal((await get({}, "gone")).status, 404);
  const routed = await routeRequest(new Request(`https://share.milagre.cloud/s/${"a".repeat(43)}/files/${"b".repeat(64)}`, { method: "POST" }), {
    PUBLIC_ORIGIN: "https://share.milagre.cloud",
    page: async () => new Response(),
  });
  assert.equal(routed.status, 405);
});
