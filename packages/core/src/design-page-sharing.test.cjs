const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createChatArtifacts } = require("./chat-artifacts.cjs");
const { createDesignPageSharing, uploadTimeout } = require("./design-page-sharing.cjs");
const { publicAddress, fetchRaster, embedPageImages } = require("./design-page-images.cjs");
const { publicPageContent } = require("./design-page-content.cjs");
const CHAT = "/project#1";
const document = () => ({ schemaVersion: 1, width: 390, height: 844, nodes: [{ id: "heading", type: "text", width: 300, height: 80, text: "Hello" }] });
function fakeClock() {
  const pending = [];
  return {
    pending,
    timers: {
      setTimeout: (run, ms) => {
        const timer = { run, ms };
        pending.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        if (pending.includes(timer)) pending.splice(pending.indexOf(timer), 1);
      },
    },
    next: async () => {
      const timer = pending.shift();
      assert.ok(timer, "a timer is waiting");
      await timer.run();
      return timer.ms;
    },
  };
}
const settled = () => new Promise((resolve) => setImmediate(resolve));
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "design-page-sharing-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const validateChat = async (chatId) => {
    if (chatId !== CHAT) throw Error("Unknown Chat");
  };
  const hooks = {};
  const artifacts = createChatArtifacts({
    directory: path.join(directory, "artifacts"),
    validateChat,
    onChange: ({ chatId }) => hooks.changed?.(chatId),
  });
  for (const id of ["first", "second"]) await artifacts.showDesign({ chatId: CHAT, id, title: id, document: document() });
  const calls = [];
  let failure = false;
  let capabilities = ["designs", "workspace", "artifacts", "selection"];
  const chat = { title: "My page" };
  const clock = fakeClock();
  const options = {
    directory: path.join(directory, "shares"),
    chatTitle: async () => chat.title,
    artifacts,
    validateChat,
    timers: clock.timers,
    fetch: async (url, options) => {
      if (options.method === "GET" && new URL(url).pathname === "/capabilities")
        return capabilities ? Response.json({ kinds: capabilities }) : new Response("Not found", { status: 404 });
      if (options.method === "GET") return new Response("ok");
      calls.push({ url, ...options });
      if (typeof failure === "number") return new Response("refused", { status: failure });
      if (failure) throw Error("lost acknowledgement");
      if (options.method === "DELETE") return new Response(null, { status: 204 });
      const id = new URL(url).pathname.split("/").at(-1);
      return Response.json({ id, path: `/s/${id}` }, { status: 201 });
    },
  };
  const api = createDesignPageSharing(options);
  hooks.changed = (chatId) => api.changed(chatId);
  return {
    artifacts,
    calls,
    chat,
    clock,
    options,
    api,
    fail: (value) => {
      failure = value;
    },
    workerKinds: (value) => {
      capabilities = value;
    },
    request: { chatId: CHAT, acknowledgePublic: true },
  };
}
test("publishing captures the entire page at current versions and returns no secret", async (t) => {
  const { api, artifacts, calls, request } = await fixture(t);
  await artifacts.apply({ chatId: CHAT, id: "first", expectedVersion: 1, operations: [{ op: "update", id: "heading", patch: { text: "Changed" } }] });
  const result = await api.publish(request);
  const snapshot = JSON.parse(calls[0].body);
  assert.equal(snapshot.designs.length, 2);
  assert.equal(snapshot.designs[0].document.nodes[0].text, "Changed");
  assert.equal(snapshot.chatId, undefined);
  const secret = calls[0].headers.authorization.slice(7);
  assert.equal(result.id, createHash("sha256").update(Buffer.from(secret, "base64url")).digest("base64url"));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.deepEqual(await api.list({ chatId: CHAT }), [result]);
  assert.equal(result.updatedAt, undefined);
});
test("the public page takes the Chat's title, never one the request carries", async (t) => {
  const { api, calls, chat, request } = await fixture(t);
  chat.title = "  Login   flow\n redesign ";
  const named = await api.publish({ ...request, title: "Designs" });
  assert.equal(named.title, "Login flow redesign");
  assert.equal(JSON.parse(calls[0].body).title, "Login flow redesign");
  chat.title = "x".repeat(200);
  assert.equal((await api.publish(request)).title.length, 120);
  chat.title = null;
  assert.equal((await api.publish(request)).title, "Designs", "an untitled Chat's page is called Designs");
});
test("sharing again updates the snapshot behind the same link", async (t) => {
  const { api, artifacts, calls, chat, request } = await fixture(t);
  const first = await api.publish(request);
  assert.equal(first.title, "My page", "the page is named after its Chat");
  await artifacts.apply({ chatId: CHAT, id: "first", expectedVersion: 1, operations: [{ op: "update", id: "heading", patch: { text: "Later" } }] });
  chat.title = "Renamed";
  const second = await api.publish(request);
  assert.equal(second.id, first.id);
  assert.equal(second.url, first.url);
  assert.equal(second.title, "Renamed");
  assert.equal(second.createdAt, first.createdAt);
  assert.ok(second.updatedAt >= first.createdAt);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, calls[0].url);
  assert.equal(calls[1].headers.authorization, calls[0].headers.authorization, "the update reuses the saved capability");
  assert.equal(JSON.parse(calls[1].body).designs[0].document.nodes[0].text, "Later");
  assert.deepEqual(await api.list({ chatId: CHAT }), [second]);
  assert.equal((await api.listAll()).length, 1);
  await api.revoke({ chatId: CHAT, id: first.id });
  assert.deepEqual(await api.list({ chatId: CHAT }), [], "a revoked link is no longer the page's link");
  const fresh = await api.publish(request);
  assert.notEqual(fresh.id, first.id, "after revoking, the next share creates a new link");
  assert.deepEqual(
    (await api.listAll()).map((entry) => [entry.id, !!entry.revoked]),
    [
      [fresh.id, false],
      [first.id, true],
    ],
  );
});
test("several live links from before updates collapse into the newest; failed revocations are kept and retried", async (t) => {
  const { api, calls, options, request } = await fixture(t);
  const newest = await api.publish(request);
  const filename = path.join(options.directory, (await fs.readdir(options.directory))[0]);
  const saved = JSON.parse(await fs.readFile(filename, "utf8"));
  const { randomBytes } = require("node:crypto");
  const older = [1, 2].map((n) => {
    const secret = randomBytes(32);
    const id = createHash("sha256").update(secret).digest("base64url");
    return Object.assign(structuredClone(saved[0]), {
      id,
      secret: secret.toString("base64url"),
      url: `https://share.milagre.cloud/s/${id}`,
      createdAt: saved[0].createdAt - n,
    });
  });
  await fs.writeFile(filename, JSON.stringify([...older, ...saved]));
  assert.deepEqual(
    (await api.list({ chatId: CHAT })).map((entry) => entry.id),
    [newest.id],
  );
  let refuse = older[0].id;
  const deletes = [];
  const flaky = createDesignPageSharing({
    ...options,
    fetch: async (url, init) => {
      if (init.method === "DELETE") deletes.push(url.split("/").at(-1));
      return init.method === "DELETE" && url.endsWith(refuse) ? new Response(null, { status: 503 }) : options.fetch(url, init);
    },
  });
  const first = await flaky.publish(request);
  assert.equal(first.id, newest.id);
  assert.equal(first.olderLinks, 1);
  assert.equal(calls.findLast((call) => call.method === "PUT").url, calls[0].url, "the newest link is the one updated");
  assert.deepEqual(deletes, [older[0].id, older[1].id]);
  assert.deepEqual(
    (await flaky.listAll()).map((entry) => entry.id).toSorted(),
    [newest.id, older[0].id].toSorted(),
    "the unrevoked older link stays manageable",
  );
  assert.deepEqual(
    (await flaky.list({ chatId: CHAT })).map((entry) => entry.id),
    [newest.id],
  );
  refuse = "none";
  const second = await flaky.publish(request);
  assert.equal(second.olderLinks, undefined);
  assert.deepEqual(
    (await flaky.listAll()).map((entry) => entry.id),
    [newest.id],
  );
});
test("a link revoked only on the service is replaced by a new one, but a local revocation is never undone", async (t) => {
  const { api, options, request } = await fixture(t);
  const first = await api.publish(request);
  let gone = first.id;
  const service = createDesignPageSharing({
    ...options,
    fetch: async (url, init) => (init.method === "PUT" && url.endsWith(gone) ? new Response("Snapshot revoked", { status: 410 }) : options.fetch(url, init)),
  });
  const replaced = await service.publish(request);
  assert.notEqual(replaced.id, first.id);
  assert.equal((await service.listAll()).find((entry) => entry.id === first.id).revoked, true);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const uploading = new Promise((resolve) => {
    started = resolve;
  });
  const racing = createDesignPageSharing({
    ...options,
    fetch: async (url, init) => {
      if (init.method === "PUT") {
        started();
        await held;
        return new Response("Snapshot revoked", { status: 410 });
      }
      return options.fetch(url, init);
    },
  });
  gone = replaced.id;
  const publishing = racing.publish(request);
  await uploading;
  await racing.revoke({ chatId: CHAT, id: replaced.id });
  release();
  await assert.rejects(publishing, /revoked while it was updating/);
  assert.deepEqual(await racing.list({ chatId: CHAT }), []);
  assert.equal((await racing.listAll()).length, 2);
});
test("offline publishing creates no pending secret or phantom link", async (t) => {
  const { options, request } = await fixture(t);
  let writes = 0;
  const offline = createDesignPageSharing({
    ...options,
    fetch: async (_url, request) => {
      assert.equal(request.method, "GET");
      return new Response("service missing", { status: 404 });
    },
    embedImages: async () => {
      writes++;
      assert.fail("offline publishing must not fetch images");
    },
  });
  assert.equal((await offline.status()).available, false);
  await assert.rejects(offline.publish(request), /Publishing is unavailable/);
  assert.deepEqual(await offline.listAll(), []);
  assert.equal(writes, 0);
  await assert.rejects(fs.stat(options.directory), { code: "ENOENT" });
});
test("saved publication capabilities survive Chat deletion and remain revocable by the owner", async (t) => {
  const { api, artifacts, options, request } = await fixture(t);
  const share = await api.publish(request);
  await artifacts.removeChat(CHAT);
  const restarted = createDesignPageSharing({
    ...options,
    validateChat: async () => {
      throw Error("Chat deleted");
    },
  });
  await assert.rejects(restarted.list({ chatId: CHAT }), /Chat deleted/);
  await assert.rejects(restarted.revoke({ chatId: CHAT, id: share.id }), /Chat deleted/);
  assert.deepEqual(await restarted.listAll(), [share]);
  await restarted.revokeSaved({ id: share.id });
  assert.equal((await restarted.listAll())[0].revoked, true);
  await assert.rejects(restarted.revokeSaved({ id: "z".repeat(43) }), /not in this computer/);
  assert.equal((await restarted.listAll())[0].revoked, true);
  await restarted.revokeSaved({ id: share.id });
});
test("publication and revocation require exact service acknowledgements", async (t) => {
  const { options, request } = await fixture(t);
  for (const reply of [
    () => new Response(null, { status: 204 }),
    () => Response.json({ id: "wrong", path: "/s/wrong" }),
    () => new Response("not json"),
    () => new Response("x".repeat(5000)),
  ]) {
    const api = createDesignPageSharing({ ...options, fetch: async (_url, request) => (request.method === "GET" ? new Response("ok") : reply()) });
    await assert.rejects(api.publish(request), /did not confirm publication/);
    const [pending] = await api.listAll();
    assert.equal(pending.pending, true);
  }
  const api = createDesignPageSharing(options);
  const share = await api.publish(request);
  const wrongDelete = createDesignPageSharing({ ...options, fetch: async () => new Response("ok", { status: 200 }) });
  await assert.rejects(wrongDelete.revokeSaved({ id: share.id }), /did not confirm revocation/);
  assert.equal((await wrongDelete.listAll())[0].revoked, undefined);
});
test("upload deadlines allow larger snapshots on slow uplinks and remain bounded", () => {
  assert.equal(uploadTimeout(1000), 45000);
  assert.ok(uploadTimeout(8 * 1024 * 1024) >= 280000);
  assert.equal(uploadTimeout(100 * 1024 * 1024), 300000);
});

test("both revoke paths bypass an in-flight upload and preserve concurrent history changes", async (t) => {
  const { options, request } = await fixture(t);
  let releaseUpload;
  let uploadStarted;
  let started = new Promise((resolve) => {
    uploadStarted = resolve;
  });
  let held = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  t.after(() => releaseUpload());
  let hold = false;
  const api = createDesignPageSharing({
    ...options,
    fetch: async (url, init) => {
      if (hold && init.method === "PUT") {
        uploadStarted();
        await held;
      }
      return options.fetch(url, init);
    },
  });
  // An update of a published link is revoked from the global list, and a new pending link from its Chat.
  const first = await api.publish(request);
  hold = true;
  const updating = api.publish(request);
  await started;
  await api.revokeSaved({ id: first.id });
  started = new Promise((resolve) => {
    uploadStarted = resolve;
  });
  const releaseUpdate = releaseUpload;
  held = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  const publishing = api.publish(request);
  releaseUpdate();
  assert.equal((await updating).revoked, true, "a late update acknowledgement cannot undo revocation");
  await started;
  const [pending] = await api.list({ chatId: CHAT });
  assert.equal(pending.pending, true);
  const revoking = api.revoke({ chatId: CHAT, id: pending.id });
  let timer;
  try {
    await Promise.race([
      revoking,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Revocation waited behind upload")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    releaseUpload();
    await Promise.allSettled([publishing, revoking]);
  }
  assert.equal((await publishing).revoked, true, "a late upload acknowledgement cannot undo revocation");
  assert.equal((await api.listAll()).length, 2);
  assert.ok((await api.listAll()).every((entry) => entry.revoked));
});

test("unreadable history is skipped so other pages remain revocable", async (t) => {
  const { api, options, request } = await fixture(t);
  const page = await api.publish(request);
  await fs.writeFile(path.join(options.directory, `${"0".repeat(43)}.json`), "{");
  const warning = t.mock.method(console, "warn", () => {});
  assert.deepEqual(await api.listAll(), [page]);
  await api.revokeSaved({ id: page.id });
  assert.equal((await api.listAll())[0].revoked, true);
  assert.ok(warning.mock.callCount() >= 1);
});

test("public snapshots omit hidden assets and layer labels while keeping visible component geometry", async () => {
  const { validateDesignDocument, designLayout } = require("@milagre/shared/design");
  const original = validateDesignDocument({
    schemaVersion: 1,
    width: 390,
    height: 844,
    tokens: { privateToken: "#fff" },
    nodes: [
      { id: "master", name: "Private library label", type: "frame", component: true, hidden: true, width: 200, height: 100 },
      { id: "label", name: "Internal label", parentId: "master", type: "text", width: 180, height: 40, text: "Visible instance text", fill: "$privateToken" },
      { id: "instance", name: "Internal instance", componentId: "master", type: "frame", x: 20, y: 200, width: 200, height: 100 },
      { id: "hiddenImage", type: "image", hidden: true, width: 100, height: 100, src: "https://example.com/private-image.png" },
    ],
  });
  const snapshot = publicPageContent({
    schemaVersion: 1,
    title: "Page",
    designs: [
      { title: "First", group: "Onboarding", document: original },
      { title: "Second", document: original },
    ],
  });
  assert.equal(snapshot.designs[0].group, "Onboarding", "a design's group names its block on the public page");
  assert.equal("group" in snapshot.designs[1], false);
  const saved = validateDesignDocument(snapshot.designs[0].document);
  assert.equal(saved.nodes.length, 2);
  assert.equal(saved.nodes[1].text, "Visible instance text");
  assert.deepEqual(designLayout(saved).get(saved.nodes[0].id), designLayout(original).get("instance"));
  assert.doesNotMatch(JSON.stringify(snapshot), /Private library|Internal label|Internal instance|privateToken|private-image|componentId|componentSourceId/);
  let downloads = 0;
  await embedPageImages(snapshot, {
    fetchImage: async () => {
      downloads++;
    },
  });
  assert.equal(downloads, 0);
});
test("lost upload acknowledgement remains revocable and retries the same ID after restart", async (t) => {
  const { api, calls, options, request, fail } = await fixture(t);
  fail(true);
  await assert.rejects(api.publish(request), /could not be reached/);
  const [uncertain] = await api.list({ chatId: CHAT });
  assert.equal(uncertain.pending, true);
  fail(false);
  const restarted = createDesignPageSharing(options);
  const result = await restarted.publish(request);
  assert.equal(result.id, uncertain.id);
  assert.equal(result.pending, undefined);
  assert.equal(calls[1].url, calls[0].url);
  await restarted.revoke({ chatId: CHAT, id: result.id });
  assert.deepEqual(await restarted.list({ chatId: CHAT }), []);
  assert.equal((await restarted.listAll())[0].revoked, true);
  const count = calls.length;
  await restarted.revoke({ chatId: CHAT, id: result.id });
  assert.equal(calls.length, count);
});
test("consent, Chat scope and page kind are enforced before any public request", async (t) => {
  const { api, calls, request } = await fixture(t);
  await assert.rejects(api.publish({ ...request, acknowledgePublic: false }), /Confirm/);
  await assert.rejects(api.publish({ ...request, chatId: "/other#1" }), /Unknown Chat/);
  await assert.rejects(api.revoke({ chatId: CHAT, id: "x".repeat(43) }), /does not belong/);
  await assert.rejects(api.publish({ ...request, kind: "other" }), /Choose the workspace, one design, a selection of designs or the page/);
  await assert.rejects(api.list({ chatId: CHAT, kind: "other" }), /Choose the workspace, one design, a selection of designs or the page/);
  assert.equal(calls.length, 0);
});
test("page capture is ordered with edits", async (t) => {
  const { artifacts } = await fixture(t);
  const update = artifacts.apply({
    chatId: CHAT,
    id: "first",
    expectedVersion: 1,
    operations: [{ op: "update", id: "heading", patch: { text: "Before capture" } }],
  });
  const capture = artifacts.pageSnapshot({ chatId: CHAT, title: "All" });
  const later = artifacts.apply({
    chatId: CHAT,
    id: "second",
    expectedVersion: 1,
    operations: [{ op: "update", id: "heading", patch: { text: "After capture" } }],
  });
  await Promise.all([update, later]);
  const snapshot = await capture;
  assert.equal(snapshot.designs[0].document.nodes[0].text, "Before capture");
  assert.equal(snapshot.designs[1].document.nodes[0].text, "Hello");
});
test("image embedding blocks private addresses and deduplicates downloads", async () => {
  for (const address of ["127.0.0.1", "10.0.0.2", "172.16.0.1", "169.254.169.254", "192.168.1.1", "::1", "::ffff:127.0.0.1", "2001:db8::1", "2002:7f00:1::"])
    assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress("8.8.8.8"), true);
  assert.equal(publicAddress("2606:4700:4700::1111"), true);
  assert.equal(publicAddress("2001:4860:4860::8888"), true);
  assert.equal(publicAddress("2001:0db8::1"), false);
  assert.equal(publicAddress("192.0.78.24"), true);
  await assert.rejects(
    fetchRaster("https://image.example/x", { lookup: async () => [{ address: "127.0.0.1", family: 4 }], request: () => assert.fail("no private socket") }),
    /private network/,
  );
  const doc = document();
  doc.nodes = ["one", "two"].map((id) => ({ id, type: "image", width: 20, height: 20, src: "https://example.com/image" }));
  let downloads = 0;
  const result = await embedPageImages(
    { schemaVersion: 1, title: "All", designs: [{ title: "One", document: doc }] },
    {
      fetchImage: async () => {
        downloads++;
        return "data:image/png;base64,iVBORw0KGgo=";
      },
    },
  );
  assert.equal(downloads, 1);
  assert.match(result.designs[0].document.nodes[0].src, /^data:/);
  assert.match(doc.nodes[0].src, /^https:/, "original saved designs stay untouched");
});
test("malformed asynchronous image redirects reject publication without crashing the host", async () => {
  const { EventEmitter } = require("node:events");
  const request = (_url, _options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = () => queueMicrotask(() => callback({ statusCode: 302, headers: { location: "https://[" }, destroy() {} }));
    return req;
  };
  await assert.rejects(fetchRaster("https://example.com/image", { lookup: async () => [{ address: "8.8.8.8", family: 4 }], request }), /invalid redirect/);
});

test("image downloads identify themselves and name the failing host", async () => {
  const { EventEmitter } = require("node:events");
  let headers;
  const request = (_url, options, callback) => {
    headers = options.headers;
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = () => queueMicrotask(() => callback({ statusCode: 403, headers: {}, destroy() {} }));
    return req;
  };
  await assert.rejects(
    fetchRaster("https://cdn.example.com/logo.png", { lookup: async () => [{ address: "8.8.8.8", family: 4 }], request }),
    /cdn\.example\.com could not be downloaded \(HTTP 403\)/,
  );
  assert.match(headers["user-agent"], /Chrome\/\d+/, "CDN bot rules reject requests that don't look like the browser that renders the design");
  assert.equal(headers["sec-fetch-dest"], "image");
});

test("a transient image failure is retried once, a permanent one is not", async () => {
  const doc = document();
  doc.nodes = [{ id: "one", type: "image", width: 20, height: 20, src: "https://example.com/flaky.png" }];
  const snapshot = { schemaVersion: 1, title: "All", designs: [{ title: "One", document: doc }] };
  let tries = 0;
  const flaky = async () => {
    if (++tries === 1) throw Object.assign(Error("HTTP 503"), { retryable: true });
    return "data:image/png;base64,iVBORw0KGgo=";
  };
  const result = await embedPageImages(snapshot, { fetchImage: flaky });
  assert.equal(tries, 2);
  assert.match(result.designs[0].document.nodes[0].src, /^data:/);
  tries = 0;
  const forbidden = async () => {
    tries++;
    throw Object.assign(Error("HTTP 403"), { retryable: false });
  };
  await assert.rejects(embedPageImages(snapshot, { fetchImage: forbidden }), /HTTP 403/);
  assert.equal(tries, 1);
});

test("an image too large to embed is redrawn at twice the largest size the page draws it", async () => {
  const zlib = require("node:zlib");
  const { resizeImagePng, imageSize } = require("./design-raster.cjs");
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  // 1200 x 1200 RGB noise: far over the 500,000 character src limit as a PNG.
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1200, 0);
  header.writeUInt32BE(1200, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = require("node:crypto").randomBytes(1200 * (1 + 1200 * 3));
  for (let row = 0; row < 1200; row++) rows[row * (1 + 1200 * 3)] = 0;
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const source = `data:image/png;base64,${png.toString("base64")}`;
  assert.ok(source.length > 500_000);
  const doc = document();
  doc.nodes = [
    { id: "small", type: "image", width: 40, height: 40, src: "https://example.com/logo.png" },
    { id: "large", type: "image", width: 150, height: 100, src: "https://example.com/logo.png" },
  ];
  const result = await embedPageImages(
    { schemaVersion: 1, title: "All", designs: [{ title: "One", document: doc }] },
    { fetchImage: async () => source, resize: resizeImagePng },
  );
  const embedded = result.designs[0].document.nodes[0].src;
  assert.equal(embedded, result.designs[0].document.nodes[1].src, "one download serves every use");
  assert.ok(embedded.length <= 500_000);
  assert.deepEqual(imageSize(Buffer.from(embedded.split(",")[1], "base64")), { width: 300, height: 300 }, "covers the 150 x 100 box at 2x, aspect kept");
});

test("the snapshot image deadline also bounds DNS lookup", async () => {
  const controller = new AbortController();
  const pending = fetchRaster("https://example.com/image", {
    signal: controller.signal,
    lookup: () => new Promise(() => {}),
    request: () => assert.fail("expired DNS lookup must not open a socket"),
  });
  controller.abort(Error("Snapshot image deadline"));
  await assert.rejects(pending, /Snapshot image deadline/);
});

test("embedding honors the case-insensitive HTTPS schemes accepted by designs", async () => {
  const doc = document();
  doc.nodes = [{ id: "picture", type: "image", width: 100, height: 100, src: "HTTPS://example.com/picture.png" }];
  const sources = [];
  const result = await embedPageImages(
    { schemaVersion: 1, title: "Page", designs: [{ title: "Design", document: doc }] },
    {
      fetchImage: async (source) => {
        sources.push(source);
        return "data:image/png;base64,iVBORw0KGgo=";
      },
    },
  );
  assert.deepEqual(sources, ["HTTPS://example.com/picture.png"]);
  assert.match(result.designs[0].document.nodes[0].src, /^data:image\/png/);
});

test("Artifact sharing keeps one link per page, separate from Designs", async (t) => {
  const { api, artifacts, calls, request, options } = await fixture(t);
  const designShare = await api.publish(request);
  await artifacts.show({ chatId: CHAT, title: "Explanation", html: "<h1>First explanation</h1>", width: 1280, height: 800 });
  assert.equal((await api.status()).available, true);
  assert.equal((await api.status({ kind: "artifacts" })).available, true);
  const artifactRequest = { ...request, kind: "artifacts" };
  const first = await api.publish(artifactRequest);
  const firstBody = calls.at(-1).body;
  assert.equal(first.kind, "artifacts");
  assert.equal(first.designCount, 1);
  const page = JSON.parse(firstBody);
  assert.equal(page.kind, "artifacts");
  assert.equal(page.designs, undefined);
  assert.equal(page.artifacts.length, 1);
  assert.equal(page.artifacts[0].html, "<h1>First explanation</h1>");
  await artifacts.show({ chatId: CHAT, title: "Explanation", html: "<h1>Revised explanation</h1>" });
  const next = await api.publish(artifactRequest);
  assert.equal(first.id, next.id, "sharing again updates the Artifact link");
  assert.equal(JSON.parse(calls.at(-1).body).artifacts[0].html, "<h1>Revised explanation</h1>");
  assert.deepEqual(
    (await api.list({ chatId: CHAT, kind: "artifacts" })).map((item) => item.id),
    [first.id],
  );
  assert.deepEqual(
    (await api.list({ chatId: CHAT })).map((item) => item.id),
    [designShare.id],
  );
  await assert.rejects(api.revoke({ chatId: CHAT, id: first.id }), /does not belong/);
  await api.revoke({ chatId: CHAT, id: first.id, kind: "artifacts" });
  assert.deepEqual(await api.list({ chatId: CHAT, kind: "artifacts" }), []);
  await api.revokeSaved({ id: designShare.id });
  assert.equal((await api.listAll()).find((item) => item.id === designShare.id).revoked, true);
  assert.equal((await createDesignPageSharing(options).listAll()).length, 2);
});

test("desktop and mobile share links survive idle time and can still be revoked through the host", async (t) => {
  const { createPageService, createQuotaService, routeRequest } = await import("../../../apps/design-share/src/service.mjs");
  const { validateDesignPageSnapshot, renderDesignPage } = await import("@milagre/shared/design-page");
  const memory = () => {
    const values = new Map();
    return {
      get: (key) => structuredClone(values.get(key)),
      put: (key, value) => values.set(key, structuredClone(value)),
      delete: (key) => values.delete(key),
      keys: (prefix) => [...values.keys()].filter((key) => key.startsWith(prefix)),
      transaction: (callback) => callback(),
    };
  };
  const { options, artifacts, request } = await fixture(t);
  await artifacts.show({ chatId: CHAT, title: "Explainer", html: "<p>One page</p>" });
  const quotaStorage = memory();
  const quota = createQuotaService({ storage: quotaStorage, limits: { bytes: 20 * 1024 ** 3 } });
  const pages = new Map();
  let time = 1000;
  const api = createDesignPageSharing({
    ...options,
    fetch: async (url, init) => {
      if (new URL(url).pathname === "/health") return new Response("ok");
      const id = new URL(url).pathname.split("/").at(-1);
      if (!pages.has(id))
        pages.set(
          id,
          createPageService({
            storage: memory(),
            validate: validateDesignPageSnapshot,
            render: renderDesignPage,
            quota,
            quotaId: id,
            now: () => time,
            setAlarm: async () => {},
            deleteAlarm: async () => {},
          }),
        );
      return routeRequest(new Request(url, init), { PUBLIC_ORIGIN: new URL(url).origin, page: (pageId, req) => pages.get(pageId).fetch(req, pageId) });
    },
  });
  for (const scope of [{ kind: "designs" }, { kind: "artifacts" }, { kind: "workspace" }, { kind: "design", designId: "first" }]) {
    const first = await api.publish({ ...request, ...scope });
    time += 365 * 24 * 60 * 60 * 1000;
    const page = pages.get(first.id);
    await page.alarm();
    assert.equal((await page.fetch(new Request(first.url, { method: "HEAD" }), first.id)).status, 200);
    const next = await api.publish({ ...request, ...scope });
    assert.equal(next.id, first.id);
    await api.revoke({ chatId: CHAT, ...scope, id: first.id });
    assert.equal((await page.fetch(new Request(first.url), first.id)).status, 404);
    assert.equal((await api.listAll()).find((share) => share.id === first.id).revoked, true);
    await page.alarm();
  }
  assert.equal(quotaStorage.get("activeBytes"), 0);
});

test("an Artifact page's files are uploaded by hash before the snapshot that names them", async (t) => {
  const { api, artifacts, calls, request } = await fixture(t);
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "share-worktree-"));
  t.after(() => fs.rm(worktree, { recursive: true, force: true }));
  const bytes = Buffer.from("not really a video");
  await fs.writeFile(path.join(worktree, "demo.mp4"), bytes);
  await artifacts.show(
    { chatId: CHAT, title: "Demo", html: '<video src="assets/demo.mp4"></video>', assets: [{ name: "demo.mp4", path: path.join(worktree, "demo.mp4") }] },
    { roots: [worktree] },
  );
  await api.publish({ ...request, kind: "artifacts" });
  const hash = createHash("sha256").update(bytes).digest("hex");
  const [file, page] = calls;
  assert.match(file.url, new RegExp(`/api/pages/[A-Za-z0-9_-]{43}/files/${hash}$`));
  assert.equal(file.method, "PUT");
  assert.equal(file.headers["content-type"], "video/mp4");
  assert.equal(Buffer.from(await file.body.arrayBuffer()).toString(), bytes.toString());
  const snapshot = JSON.parse(page.body);
  assert.deepEqual(snapshot.artifacts[0].assets, [{ name: "demo.mp4", hash, size: bytes.length, type: "video/mp4" }]);
  assert.equal(snapshot.artifacts[0].html, '<video src="assets/demo.mp4"></video>', "the service points the page at its files");
});

const edit = (artifacts, id, version, text) =>
  artifacts.apply({ chatId: CHAT, id, expectedVersion: version, operations: [{ op: "update", id: "heading", patch: { text } }] });
const puts = (calls) => calls.filter((call) => call.method === "PUT" && !call.url.includes("/files/"));

test("a new workspace link is live: agent saves republish it once, under the same link, after a quiet moment", async (t) => {
  const { api, artifacts, calls, clock, request } = await fixture(t);
  await artifacts.show({ chatId: CHAT, title: "Explainer", html: "<p>Page</p>" });
  await settled();
  assert.equal(clock.pending.length, 1, "a save with no live link only arms a cheap check");
  await clock.next();
  assert.equal(calls.length, 0);
  const share = await api.publish({ ...request, kind: "workspace" });
  assert.equal(share.kind, "workspace");
  assert.equal(share.live, true);
  assert.equal(share.designCount, 3);
  const first = JSON.parse(calls[0].body);
  assert.equal(first.kind, "workspace");
  assert.equal(first.page.html, "<p>Page</p>");
  await edit(artifacts, "first", 1, "One");
  await edit(artifacts, "first", 2, "Two");
  await settled();
  assert.deepEqual(
    clock.pending.map((timer) => timer.ms),
    [3000],
    "saves in a row share one update",
  );
  await clock.next();
  assert.equal(puts(calls).length, 2);
  assert.equal(calls[1].url, calls[0].url);
  assert.equal(calls[1].headers.authorization, calls[0].headers.authorization);
  assert.equal(JSON.parse(calls[1].body).designs[0].document.nodes[0].text, "Two");
  const [updated] = await api.list({ chatId: CHAT, kind: "workspace" });
  assert.equal(updated.id, share.id);
  assert.ok(updated.updatedAt >= share.createdAt);
  assert.equal(clock.pending.length, 0);
  api.changed(CHAT);
  await clock.next();
  assert.equal(puts(calls).length, 2, "nothing new to publish sends nothing");
});

test("links from before live updates stay frozen", async (t) => {
  const { api, artifacts, calls, clock, options, request } = await fixture(t);
  const frozen = await api.publish(request);
  assert.equal(frozen.live, undefined, "the old every-design kind is never live");
  await artifacts.show({ chatId: CHAT, title: "Explainer", html: "<p>Page</p>" });
  await api.publish({ ...request, kind: "artifacts" });
  const filename = path.join(options.directory, (await fs.readdir(options.directory))[0]);
  const saved = JSON.parse(await fs.readFile(filename, "utf8"));
  for (const entry of saved) delete entry.live;
  await fs.writeFile(filename, JSON.stringify(saved));
  await edit(artifacts, "first", 1, "Later");
  await artifacts.show({ chatId: CHAT, title: "Explainer", html: "<p>Later</p>" });
  await settled();
  await clock.next();
  assert.equal(puts(calls).length, 2);
  await assert.rejects(api.setPaused({ chatId: CHAT, id: frozen.id, paused: true }), /never updates on its own/);
  const oldPage = saved.find((entry) => entry.kind === "artifacts");
  const fresh = await api.publish({ ...request, kind: "artifacts" });
  assert.notEqual(fresh.id, oldPage.id, "sharing a page again after its frozen link makes a new link");
  assert.equal(fresh.live, true);
  assert.ok(!calls.some((call) => call.method === "DELETE" && call.url.endsWith(oldPage.id)), "the frozen link stays published");
  assert.ok(
    (await api.listAll()).some((entry) => entry.id === oldPage.id && !entry.revoked),
    "and stays in Published pages",
  );
});

test("pausing stops updates and resuming publishes the current state at once", async (t) => {
  const { api, artifacts, calls, clock, request } = await fixture(t);
  const share = await api.publish({ ...request, kind: "workspace" });
  const paused = await api.setPaused({ chatId: CHAT, id: share.id, paused: true });
  assert.equal(paused.paused, true);
  assert.deepEqual(await api.list({ chatId: CHAT, kind: "workspace" }), [paused]);
  await edit(artifacts, "first", 1, "While paused");
  await settled();
  await clock.next();
  assert.equal(puts(calls).length, 1);
  const resumed = await api.setPaused({ chatId: CHAT, id: share.id, paused: false });
  assert.equal(resumed.paused, undefined);
  assert.equal(puts(calls).length, 2);
  assert.equal(JSON.parse(calls.at(-1).body).designs[0].document.nodes[0].text, "While paused");
  assert.ok(resumed.updatedAt);
  await assert.rejects(api.setPaused({ chatId: CHAT, id: share.id, paused: "no" }), /pause or resume/);
  await assert.rejects(api.setPaused({ chatId: "/other#1", id: share.id, paused: true }), /Unknown Chat/);
});

test("a failed update marks the link stale and retries with a growing backoff until one succeeds", async (t) => {
  const { api, artifacts, calls, clock, fail, options, request } = await fixture(t);
  const share = await api.publish({ ...request, kind: "workspace" });
  fail(true);
  await edit(artifacts, "first", 1, "Offline");
  await settled();
  await clock.next();
  let [current] = await api.list({ chatId: CHAT, kind: "workspace" });
  assert.equal(current.stale, true);
  assert.match(current.lastError, /could not be reached/);
  assert.deepEqual(
    clock.pending.map((timer) => timer.ms),
    [15000],
  );
  fail(503);
  await clock.next();
  [current] = await api.list({ chatId: CHAT, kind: "workspace" });
  assert.match(current.lastError, /refused this request \(503\)/);
  assert.deepEqual(
    clock.pending.map((timer) => timer.ms),
    [30000],
  );
  fail(false);
  const startup = fakeClock();
  const resumed = createDesignPageSharing({ ...options, timers: startup.timers });
  await resumed.resumeStale();
  assert.deepEqual(
    startup.pending.map((timer) => timer.ms),
    [0],
    "a host start retries stale live links",
  );
  await startup.next();
  [current] = await api.list({ chatId: CHAT, kind: "workspace" });
  assert.equal(current.id, share.id);
  assert.equal(current.stale, undefined);
  assert.equal(current.lastError, undefined);
  assert.equal(JSON.parse(puts(calls).at(-1).body).designs[0].document.nodes[0].text, "Offline");
  const count = calls.length;
  await clock.next();
  assert.equal(calls.length, count, "the pending retry finds nothing left to publish");
  assert.equal(clock.pending.length, 0);
});

test("a link revoked on the service during an automatic update is marked revoked and left alone", async (t) => {
  const { api, artifacts, clock, fail, request } = await fixture(t);
  const share = await api.publish({ ...request, kind: "workspace" });
  fail(410);
  await edit(artifacts, "first", 1, "Gone");
  await settled();
  await clock.next();
  assert.equal((await api.listAll()).find((entry) => entry.id === share.id).revoked, true);
  assert.deepEqual(await api.list({ chatId: CHAT, kind: "workspace" }), []);
  assert.equal(clock.pending.length, 0);
});

test("one design is shared alone, follows only its own saves and stops once it is deleted", async (t) => {
  const { api, artifacts, calls, clock, request } = await fixture(t);
  await assert.rejects(api.publish({ ...request, kind: "design" }), /Choose the design/);
  const share = await api.publish({ ...request, kind: "design", designId: "first" });
  assert.deepEqual([share.kind, share.designId, share.title, share.designCount, share.live], ["design", "first", "first", 1, true]);
  const snapshot = JSON.parse(calls[0].body);
  assert.equal(snapshot.kind, undefined);
  assert.equal(snapshot.designs.length, 1);
  assert.deepEqual(await api.list({ chatId: CHAT, kind: "design", designId: "second" }), []);
  assert.deepEqual(
    (await api.list({ chatId: CHAT, kind: "design", designId: "first" })).map((entry) => entry.id),
    [share.id],
  );
  await edit(artifacts, "second", 1, "Elsewhere");
  await settled();
  await clock.next();
  assert.equal(puts(calls).length, 1, "another design's save leaves the link as it is");
  await edit(artifacts, "first", 1, "Mine");
  await settled();
  await clock.next();
  assert.equal(puts(calls).length, 2);
  await artifacts.deleteDesign({ chatId: CHAT, id: "first" });
  await settled();
  await clock.next();
  const [gone] = await api.list({ chatId: CHAT, kind: "design", designId: "first" });
  assert.equal(gone.stale, true);
  assert.equal(gone.lastError, "This design was deleted.");
  assert.equal(clock.pending.length, 0, "a deleted design is not retried");
  await edit(artifacts, "second", 2, "Again");
  await settled();
  await clock.next();
  assert.equal(puts(calls).length, 2);
  await assert.rejects(api.revoke({ chatId: CHAT, id: share.id, kind: "design", designId: "second" }), /does not belong/);
  await api.revoke({ chatId: CHAT, id: share.id, kind: "design", designId: "first" });
});

test("a selection is shared in its order as its own link, follows its designs' saves and outlives a deleted one", async (t) => {
  const { api, artifacts, calls, clock, request } = await fixture(t);
  await assert.rejects(api.publish({ ...request, kind: "selection" }), /Choose the designs/);
  await assert.rejects(api.publish({ ...request, kind: "selection", designIds: ["first", "first"] }), /each design once/);
  await assert.rejects(api.publish({ ...request, kind: "selection", designIds: ["Bad id"] }), /Choose the designs/);
  const scope = { kind: "selection", designIds: ["second", "first"] };
  const share = await api.publish({ ...request, ...scope });
  assert.deepEqual([share.kind, share.designIds, share.designCount, share.live], ["selection", ["second", "first"], 2, true]);
  const snapshot = JSON.parse(puts(calls).at(-1).body);
  assert.equal(snapshot.kind, "selection");
  assert.deepEqual(
    snapshot.designs.map((design) => design.title),
    ["second", "first"],
  );
  assert.deepEqual(await api.list({ chatId: CHAT, kind: "selection", designIds: ["first", "second"] }), [], "another order is another link");
  assert.deepEqual(
    (await api.list({ chatId: CHAT, ...scope })).map((entry) => entry.id),
    [share.id],
  );
  assert.equal((await api.publish({ ...request, ...scope })).id, share.id, "sharing the same selection again keeps its link");
  await edit(artifacts, "first", 1, "Picked");
  await settled();
  await clock.next();
  assert.equal(JSON.parse(puts(calls).at(-1).body).designs[1].document.nodes[0].text, "Picked");
  await artifacts.deleteDesign({ chatId: CHAT, id: "second" });
  await settled();
  await clock.next();
  const [current] = await api.list({ chatId: CHAT, ...scope });
  assert.equal(current.stale, undefined);
  assert.equal(current.designCount, 1, "the deleted design drops out and the rest stays published");
  await assert.rejects(api.revoke({ chatId: CHAT, id: share.id, kind: "design" }), /does not belong/);
  await api.revoke({ chatId: CHAT, id: share.id, ...scope });
});

test("a presentation is published only to a Worker that lists selection, since an older one would store a canvas", async (t) => {
  const { api, calls, request, workerKinds } = await fixture(t);
  const scope = { kind: "selection", designIds: ["first"] };
  for (const kinds of [null, ["designs", "workspace", "artifacts"]]) {
    workerKinds(kinds);
    assert.deepEqual(await api.status({ ...scope, chatId: CHAT }), {
      available: false,
      reason: "The sharing service can't publish presentations yet. Try again after it is updated.",
    });
    await assert.rejects(api.publish({ ...request, ...scope }), /can't publish presentations yet/);
    assert.equal((await api.status({ kind: "design", chatId: CHAT })).available, true, "other kinds still publish");
  }
  assert.equal(puts(calls).length, 0, "nothing reached the old Worker");
  workerKinds(["designs", "workspace", "artifacts", "selection"]);
  await api.publish({ ...request, ...scope });
  assert.equal(puts(calls).length, 1);
});

test("a workspace's page files are uploaded before the snapshot, again on each live update", async (t) => {
  const { api, artifacts, calls, clock, request } = await fixture(t);
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "share-worktree-"));
  t.after(() => fs.rm(worktree, { recursive: true, force: true }));
  const bytes = Buffer.from("poster bytes");
  await fs.writeFile(path.join(worktree, "poster.png"), bytes);
  const page = {
    chatId: CHAT,
    title: "Demo",
    html: '<img src="assets/poster.png">',
    assets: [{ name: "poster.png", path: path.join(worktree, "poster.png") }],
  };
  await artifacts.show(page, { roots: [worktree] });
  await api.publish({ ...request, kind: "workspace" });
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.deepEqual(
    calls.map((call) => call.url.endsWith(`/files/${hash}`)),
    [true, false],
  );
  assert.deepEqual(JSON.parse(calls[1].body).page.assets, [{ name: "poster.png", hash, size: bytes.length, type: "image/png" }]);
  await artifacts.show({ chatId: CHAT, title: "Demo", html: '<p>New</p><img src="assets/poster.png">' });
  await settled();
  await clock.next();
  assert.deepEqual(
    calls.slice(2).map((call) => call.url.endsWith(`/files/${hash}`)),
    [true, false],
  );
  assert.match(JSON.parse(calls.at(-1).body).page.html, /<p>New<\/p>/);
});
