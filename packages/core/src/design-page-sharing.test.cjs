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
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "design-page-sharing-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const validateChat = async (chatId) => {
    if (chatId !== CHAT) throw Error("Unknown Chat");
  };
  const artifacts = createChatArtifacts({ directory: path.join(directory, "artifacts"), validateChat });
  for (const id of ["first", "second"]) await artifacts.showDesign({ chatId: CHAT, id, title: id, document: document() });
  const calls = [];
  let failure = false;
  const options = {
    directory: path.join(directory, "shares"),
    artifacts,
    validateChat,
    fetch: async (url, options) => {
      if (options.method === "GET") return new Response("ok");
      calls.push({ url, ...options });
      if (failure) throw Error("lost acknowledgement");
      if (options.method === "DELETE") return new Response(null, { status: 204 });
      const id = new URL(url).pathname.split("/").at(-1);
      return Response.json({ id, path: `/s/${id}` }, { status: 201 });
    },
  };
  return {
    artifacts,
    calls,
    options,
    api: createDesignPageSharing(options),
    fail: (value) => {
      failure = value;
    },
    request: { chatId: CHAT, title: "My page", acknowledgePublic: true },
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
  const second = await api.publish(request);
  assert.notEqual(second.id, result.id, "a deliberate publication gets a new immutable link");
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
  await artifacts.setEnabled(false);
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

test("both revoke paths bypass a pending upload and preserve concurrent history changes", async (t) => {
  const { options, request } = await fixture(t);
  let releaseUpload;
  let uploadStarted;
  const started = new Promise((resolve) => {
    uploadStarted = resolve;
  });
  const held = new Promise((resolve) => {
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
  const first = await api.publish(request);
  hold = true;
  const publishing = api.publish(request);
  await started;
  const pending = (await api.listAll()).find((entry) => entry.pending);
  const revoking = Promise.all([api.revokeSaved({ id: first.id }), api.revoke({ chatId: CHAT, id: pending.id })]);
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
  const snapshot = publicPageContent({ schemaVersion: 1, title: "Page", designs: [{ title: "First", document: original }] });
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
  assert.equal((await restarted.list({ chatId: CHAT }))[0].revoked, true);
  const count = calls.length;
  await restarted.revoke({ chatId: CHAT, id: result.id });
  assert.equal(calls.length, count);
});
test("consent, Chat scope and Designs OFF are enforced before any public request", async (t) => {
  const { api, artifacts, calls, request } = await fixture(t);
  await assert.rejects(api.publish({ ...request, acknowledgePublic: false }), /Confirm/);
  await assert.rejects(api.publish({ ...request, chatId: "/other#1" }), /Unknown Chat/);
  await assert.rejects(api.revoke({ chatId: CHAT, id: "x".repeat(43) }), /does not belong/);
  await artifacts.setEnabled(false);
  await assert.rejects(api.publish(request), /Designs are off/);
  await assert.rejects(api.list({ chatId: CHAT }), /Designs are off/);
  await assert.rejects(artifacts.pageSnapshot(request), /Designs are off/);
  assert.equal(calls.length, 0);
});
test("page capture is ordered with edits", async (t) => {
  const { artifacts, options } = await fixture(t);
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
  assert.equal(options.artifacts, artifacts);
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

test("Artifact sharing freezes one live page, separates history and works while Designs is off", async (t) => {
  const { api, artifacts, calls, request, options } = await fixture(t);
  const designShare = await api.publish(request);
  await artifacts.show({ chatId: CHAT, title: "Explanation", html: "<h1>First explanation</h1>", width: 1280, height: 800 });
  await artifacts.setEnabled(false);
  assert.equal((await api.status()).available, false);
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
  assert.notEqual(first.id, next.id);
  assert.equal(JSON.parse(firstBody).artifacts[0].html, "<h1>First explanation</h1>");
  assert.equal(JSON.parse(calls.at(-1).body).artifacts[0].html, "<h1>Revised explanation</h1>");
  assert.deepEqual(
    (await api.list({ chatId: CHAT, kind: "artifacts" })).map((item) => item.id),
    [next.id, first.id],
  );
  await artifacts.setEnabled(true);
  assert.deepEqual(
    (await api.list({ chatId: CHAT })).map((item) => item.id),
    [designShare.id],
  );
  await assert.rejects(api.revoke({ chatId: CHAT, id: first.id }), /does not belong/);
  await artifacts.setEnabled(false);
  await api.revoke({ chatId: CHAT, id: first.id, kind: "artifacts" });
  assert.equal((await api.list({ chatId: CHAT, kind: "artifacts" }))[1].revoked, true);
  await api.revokeSaved({ id: designShare.id });
  assert.equal((await api.listAll()).find((item) => item.id === designShare.id).revoked, true);
  assert.equal((await createDesignPageSharing(options).listAll()).length, 3);
});
