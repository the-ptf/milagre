import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, localEndpoint, type RelayRuntime, type RouteView } from "./client.ts";
import { RelayTransportError, type RelayResponse, type RelayTransport } from "./relay-transport.ts";
import { retryKind } from "@milagre/shared/send-retry";

test("recent scopes strip the computer's own hidden flags so the phone keeps its own visibility", async () => {
  const link = { id: "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7", name: "Checkout", projectIds: ["shop", "api"], hidden: true };
  const client = createClient({ address: "http://127.0.0.1:8787", token: "token" }, async (_url, init) => {
    const { method } = JSON.parse(init?.body as string);
    const result =
      method === "link:list"
        ? [link]
        : method === "project:registry"
          ? [
              { id: "shop", path: "/shop" },
              { id: "api", path: "/api" },
            ]
          : [{ path: "/shop", name: "shop", hidden: true }];
    return new Response(JSON.stringify({ v: 1, result }));
  });
  const recent = await client.recentScopes();
  assert.equal(recent.length, 2);
  assert.equal(recent[0]?.hidden, undefined);
  assert.equal(recent[1]?.hidden, undefined);
});

/** A fetcher whose answers the test releases one at a time, so requests can be held open. */
function heldFetcher(answers: Record<string, () => Response>) {
  const waiting: { method: string; release: () => void }[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    const { method } = JSON.parse(init?.body as string);
    return new Promise<Response>((resolve) => waiting.push({ method, release: () => resolve(answers[method]!()) }));
  }) as typeof fetch;
  const release = (method: string) => waiting.filter((item) => item.method === method).forEach((item) => item.release());
  return { fetcher, release, methods: () => waiting.map((item) => item.method) };
}
const answer = (result: unknown, status = 200) => new Response(JSON.stringify({ v: 1, result }), { status });
const refusal = (message: string, status = 500) => new Response(JSON.stringify({ v: 1, error: { message } }), { status });

test("recent scopes settle all three requests before failing, so a limiter counts them as one job", async () => {
  const held = heldFetcher({
    "project:recent": () => refusal("Disk error"),
    "link:list": () => answer([]),
    "project:registry": () => answer([]),
  });
  const client = createClient({ address: "http://127.0.0.1:8787", token: "token" }, held.fetcher);
  let outcome = "pending";
  const read = client.recentScopes().then(
    () => (outcome = "resolved"),
    (error: Error) => (outcome = error.message),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(held.methods().sort(), ["link:list", "project:recent", "project:registry"]);
  held.release("project:recent");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outcome, "pending", "one failed request does not end the read while its siblings are out");
  held.release("link:list");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outcome, "pending");
  held.release("project:registry");
  await read;
  assert.equal(outcome, "Disk error");
});

test("a Mac that doesn't list Links from mobile still answers its Projects, once every request settled", async () => {
  const held = heldFetcher({
    "project:recent": () => answer([{ path: "/shop", name: "shop" }]),
    "link:list": () => refusal("link:list is not available from mobile", 403),
    "project:registry": () => answer([]),
  });
  const client = createClient({ address: "http://127.0.0.1:8787", token: "token" }, held.fetcher);
  let result: unknown = "pending";
  const read = client.recentScopes().then((value) => (result = value));
  await new Promise((resolve) => setImmediate(resolve));
  held.release("link:list");
  held.release("project:recent");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result, "pending", "the registry is still out");
  held.release("project:registry");
  await read;
  assert.deepEqual(result, [{ path: "/shop", name: "shop" }]);
  // Any other failure of the Links is the read's failure.
  const broken = heldFetcher({
    "project:recent": () => answer([]),
    "link:list": () => refusal("Disk error"),
    "project:registry": () => answer([]),
  });
  const failing = createClient({ address: "http://127.0.0.1:8787", token: "token" }, broken.fetcher);
  const failed = assert.rejects(failing.recentScopes(), /Disk error/);
  await new Promise((resolve) => setImmediate(resolve));
  ["project:recent", "link:list", "project:registry"].forEach(broken.release);
  await failed;
});

test("a retired client starts no request, even one that was waiting on a transport", async () => {
  let fetched = 0;
  const client = createClient({ address: "http://127.0.0.1:8787", token: "token" }, async () => {
    fetched++;
    return answer({ ok: true });
  });
  assert.deepEqual(await client.call("daemon:status"), { ok: true });
  client.retire();
  await assert.rejects(client.call("daemon:status"), /replaced/);
  await assert.rejects(client.preview("/a"), /replaced/);
  await assert.rejects(client.recentScopes(), /replaced/);
  assert.equal(fetched, 1);
  client.live("/a", { onSignal() {}, onStatus() {} }).close();

  let opened = 0;
  const runtime = {
    transport: async () => {
      opened++;
      return {
        request: async () => ({ status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ v: 1, result: 1 })) }),
        live: () => ({ close() {} }),
      };
    },
    files: { find: async () => null, write: async () => "" },
  } as unknown as RelayRuntime;
  const relay = { url: "wss://relay.example", hostId: "h".repeat(22), key: "k".repeat(43) };
  const relayed = createClient({ address: "relay://x", token: "token", relay }, fetch, 1000, runtime);
  relayed.retire();
  await assert.rejects(relayed.call("daemon:status"), /replaced/);
  await assert.rejects(relayed.chatLists(["/a"]), /replaced/);
  assert.equal(opened, 0, "the relay's transport is never created for a retired client");
});

test("only the latest chat-lists answer stays cached, and the cache is bounded", async () => {
  const sent: (string | null)[] = [];
  const client = createClient({ address: "http://127.0.0.1:8787", token: "token" }, async (url, init) => {
    const headers = init?.headers as Record<string, string>;
    sent.push(headers["If-None-Match"] ?? null);
    const lists = String(url).includes("chat-lists");
    const etag = lists ? `"${String(url).length}-${String(url)}"` : '"preview"';
    if (headers["If-None-Match"] === etag) return new Response(null, { status: 304, headers: { etag } });
    return new Response(JSON.stringify({ v: 1, result: {} }), { headers: { etag } });
  });
  await client.chatLists(["/a"]);
  await client.chatLists(["/a"]);
  assert.deepEqual(sent, [null, sent[1]], "the same batch revalidates");
  assert.notEqual(sent[1], null);
  await client.chatLists(["/a", "/b"]);
  await client.chatLists(["/a", "/b", "/c"]);
  // The first batch's entry was dropped when a different one was cached: asking it again sends no validator.
  await client.chatLists(["/a"]);
  assert.equal(sent.at(-1), null);
  // Other routes keep theirs, and many distinct routes do not grow the cache forever.
  await client.preview("/p");
  await client.preview("/p");
  assert.equal(sent.at(-1), '"preview"');
  for (let i = 0; i < 300; i++) await client.preview(`/p${i}`);
  await client.preview("/p");
  assert.equal(sent.at(-1), null, "the oldest routes were evicted");
});

test("endpoint accepts HTTPS and emulator loopback, rejecting plaintext remote and credential/path tricks", () => {
  assert.equal(localEndpoint("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
  assert.equal(localEndpoint("http://10.0.2.2:8787"), "http://10.0.2.2:8787");
  assert.equal(localEndpoint("https://my-computer.example.com/"), "https://my-computer.example.com");
  for (const input of [
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com?token=x",
    "http://127.0.0.1.evil.com:8787",
    "http://user@127.0.0.1",
    "http://127.0.0.1/path",
    "http://127.0.0.1?token=x",
  ])
    assert.throws(() => localEndpoint(input), /HTTPS|address/);
});

test("one send carries token/version and is never retried after a network failure", async () => {
  let calls = 0;
  const client = createClient({ address: "http://127.0.0.1:8787", token: "token" }, async (_url, init) => {
    calls++;
    // oxlint-disable-next-line no-unsafe-optional-chaining -- test stub; init is always passed by the code under test
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer token");
    assert.deepEqual(JSON.parse(init?.body as string), { v: 1, method: "chat:send", args: [{ body: "hello" }] });
    throw new Error("offline");
  });
  await assert.rejects(client.call("chat:send", [{ body: "hello" }]), (error) => {
    assert.match((error as Error).message, /Connection lost.*Check the Chat before sending again/);
    // The send may have reached the Mac: only a caller that dedupes may try it again.
    assert.equal(retryKind(error), "unknown");
    return true;
  });
  assert.equal(calls, 1);
});

test("errors and incompatible responses are explicit, and timeouts abort the fetch", async () => {
  const response = (body: unknown, status = 200) =>
    createClient({ address: "http://127.0.0.1:8787", token: "token" }, async () => new Response(JSON.stringify(body), { status }));
  await assert.rejects(response({ v: 1, error: { message: "Wrong token" } }, 401).call("daemon:status"), /Wrong token/);
  await assert.rejects(response({ v: 9, result: {} }).call("daemon:status"), /Incompatible/);
  const client = createClient(
    { address: "http://127.0.0.1:8787", token: "token" },
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    10,
  );
  await assert.rejects(client.call("daemon:status"), (error) => retryKind(error) === "unknown" && /Connection lost/.test((error as Error).message));
});

test("slow Worktree and page-sharing calls get the desktop deadline instead of the normal request timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [method, args, deadline] of [
    ["worktree:create", [{ projectPath: "/p", baseBranch: "main", prompt: "Preview" }], 330000],
    ["worktree:remove", ["/wt/x", { force: false }], 330000],
    ["artifact:share-page", [{ chatId: "/p#1", title: "Designs", acknowledgePublic: true }], 420000],
    ["artifact:revoke-page-share", [{ chatId: "/p#1", id: "page" }], 120000],
    ["artifact:revoke-saved-page-share", [{ id: "page" }], 120000],
  ] as const) {
    let signal: AbortSignal | null | undefined;
    const client = createClient(
      { address: "http://127.0.0.1:8787", token: "token" },
      (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init?.signal;
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const pending = assert.rejects(client.call(method, [...args]), /Connection lost/);
    t.mock.timers.tick(30000);
    assert.equal(signal?.aborted, false, `${method} can still be working after 30 seconds`);
    t.mock.timers.tick(deadline - 30000);
    assert.equal(signal?.aborted, true);
    await pending;
  }
});

test("HTTPS sends authenticate once, refuse redirects and reject a changed response origin", async () => {
  const client = createClient({ address: "https://computer.example.com", token: "private-token" }, async (_url, init) => {
    assert.equal(init?.redirect, "error");
    // oxlint-disable-next-line no-unsafe-optional-chaining -- test stub; init is always passed by the code under test
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer private-token");
    const response = new Response(JSON.stringify({ v: 1, result: {} }));
    Object.defineProperty(response, "url", { value: "https://other.example.com/rpc" });
    return response;
  });
  await assert.rejects(client.call("daemon:status"), /redirect/);
});

test("a Cloudflare Access token goes on every request and image, and only over HTTPS", async () => {
  const access = { id: `${"c".repeat(32)}.access`, secret: "Secret_with-mixed".padEnd(43, "z") };
  let seen: Record<string, string> = {};
  const client = createClient(
    { address: "https://mac.example.cloud", token: "token", access },
    async (_url, init) => {
      seen = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ v: 1, result: "ok" }));
    },
    30000,
  );
  assert.equal(await client.call("daemon:status"), "ok");
  assert.equal(seen["CF-Access-Client-Id"], access.id);
  assert.equal(seen["CF-Access-Client-Secret"], access.secret);
  assert.equal(seen.Authorization, "Bearer token");
  assert.equal(client.media("/p", "/p/a.png").headers["CF-Access-Client-Secret"], access.secret);
  assert.throws(() => createClient({ address: "http://127.0.0.1:8797", token: "token", access }, fetch, 30000), /HTTPS/);
});

test("an HTML page from Cloudflare becomes a plain message instead of a JSON parse error", async () => {
  const page = (status: number) =>
    createClient(
      { address: "https://mac.example.cloud", token: "token" },
      async () => new Response("<!doctype html><title>Error</title>", { status, headers: { "Content-Type": "text/html" } }),
    );
  await assert.rejects(page(502).call("daemon:status"), /isn't answering/);
  await assert.rejects(page(530).call("daemon:status"), /isn't answering/);
  await assert.rejects(page(401).call("daemon:status"), /access was refused/);
  await assert.rejects(page(200).call("daemon:status"), /Unexpected response/);
});

test("an unchanged snapshot comes back as a 304 and reuses the last one", async () => {
  const sent: (string | undefined)[] = [];
  let calls = 0;
  const client = createClient({ address: "http://127.0.0.1:8787", token: "token" }, async (_url, init) => {
    // oxlint-disable-next-line no-unsafe-optional-chaining -- test stub; init is always passed by the code under test
    sent.push((init?.headers as Record<string, string>)["If-None-Match"]);
    return ++calls === 1
      ? new Response(JSON.stringify({ v: 1, result: { project: "p" } }), { headers: { etag: '"abc"' } })
      : new Response(null, { status: 304, headers: { etag: '"abc"' } });
  });
  const first = await client.snapshot("/p");
  assert.equal(await client.snapshot("/p"), first);
  assert.deepEqual(sent, [undefined, '"abc"']);
});

const hostId = "H".repeat(21) + "g";
const relayHost = { address: `relay://${hostId}`, token: "a".repeat(64), relay: { url: "wss://relay.milagre.cloud", hostId, key: "K".repeat(42) + "A" } };
type Sent = { method: string; path: string; headers: Record<string, string>; body?: Uint8Array | string };
const reply = (value: unknown, status = 200, headers: Record<string, string> = {}): RelayResponse => ({
  status,
  headers,
  body: new TextEncoder().encode(JSON.stringify(value)),
});
function fakeRelay(answer: (sent: Sent) => Promise<RelayResponse> | RelayResponse) {
  const sent: Sent[] = [];
  const lives: { path: string; onData: (data: string) => void; onStatus: (up: boolean) => void; closed: boolean }[] = [];
  const written = new Map<string, Uint8Array>();
  const transport: RelayTransport = {
    ready: async () => {},
    request: async (method, path, headers, body) => {
      const request = { method, path, headers, body };
      sent.push(request);
      return answer(request);
    },
    live(path, onData, onStatus) {
      const live = { path, onData, onStatus, closed: false };
      lives.push(live);
      return {
        close() {
          live.closed = true;
        },
      };
    },
    close() {},
  };
  const opened: unknown[] = [];
  const runtime: RelayRuntime = {
    transport: async (host) => {
      opened.push(host);
      return transport;
    },
    files: {
      find: async (name) => (written.has(name) ? `file:///cache/relay-media/${name}` : null),
      write: async (name, bytes) => {
        written.set(name, bytes);
        return `file:///cache/relay-media/${name}`;
      },
    },
  };
  return { sent, lives, written, opened, runtime, transport };
}

test("a relay host sends its calls through the relay transport and reads the JSON reply", async () => {
  const relay = fakeRelay(() => reply({ v: 1, result: { running: true } }));
  const client = createClient(
    relayHost,
    async () => {
      throw new Error("a relay host never fetches");
    },
    30000,
    relay.runtime,
  );
  assert.equal(client.url, `relay://${hostId}`);
  assert.deepEqual(await client.call("daemon:status"), { running: true });
  assert.ok(relay.sent[0] !== undefined);
  assert.equal(relay.sent[0].method, "POST");
  assert.equal(relay.sent[0].path, "/rpc");
  assert.deepEqual(JSON.parse(String(relay.sent[0].body)), { v: 1, method: "daemon:status", args: [] });
  assert.equal(relay.sent[0].headers.Authorization, undefined, "the token rides the handshake, not every request");
  assert.deepEqual(relay.opened[0], { relay: relayHost.relay, token: relayHost.token });
});

test("a Mac refusing a relayed call because its queue is full reads as busy once the deadline runs out", async () => {
  const relay = fakeRelay(() => reply({ v: 1, error: { message: "Too many requests" } }, 429));
  const client = createClient(
    relayHost,
    async () => {
      throw new Error("a relay host never fetches");
    },
    600,
    relay.runtime,
  );
  await assert.rejects(client.call("daemon:status"), (error) => {
    assert.equal((error as Error).message, "Your computer is busy right now. Try again in a moment.");
    // The Mac turned it away unread, so it is safe to send again.
    assert.equal(retryKind(error), "unsent");
    return true;
  });
  assert.equal(relay.sent.length, 2, "tried again while the deadline lasted");
});

test("a call a busy Mac turned away goes again and gets the answer once the Mac has room", async () => {
  let tries = 0;
  const relay = fakeRelay(() =>
    ++tries < 3 ? reply({ v: 1, error: { message: "Too many pending requests" } }, 429) : reply({ v: 1, result: ["main", "release"] }),
  );
  const client = createClient(
    relayHost,
    async () => {
      throw new Error("a relay host never fetches");
    },
    30000,
    relay.runtime,
  );
  assert.deepEqual(await client.call("project:branches", ["/p"]), ["main", "release"]);
  assert.equal(tries, 3);
});

test("a relay snapshot answered with 304 reuses the cached one", async () => {
  let calls = 0;
  const relay = fakeRelay(() =>
    ++calls === 1 ? reply({ v: 1, result: { project: "p" } }, 200, { etag: '"abc"' }) : { status: 304, headers: { etag: '"abc"' }, body: new Uint8Array() },
  );
  const client = createClient(relayHost, fetch, 30000, relay.runtime);
  const first = await client.snapshot("/p");
  assert.equal(await client.snapshot("/p"), first);
  assert.deepEqual(
    relay.sent.map((sent) => [sent.method, sent.headers["If-None-Match"]]),
    [
      ["GET", undefined],
      ["GET", '"abc"'],
    ],
  );
  assert.ok(relay.sent[0] !== undefined);
  assert.equal(relay.sent[0].path, "/snapshot?projectPath=%2Fp");
});

test("a refused relay pairing shows its own copy, and any other failure is a lost connection", async () => {
  const refused = createClient(
    relayHost,
    fetch,
    30000,
    fakeRelay(() => {
      throw new RelayTransportError("bad-token", "This phone was paired with an older code. Scan the new one in Settings → Devices.");
    }).runtime,
  );
  await assert.rejects(refused.call("daemon:status"), /paired with an older code/);
  const broken = createClient(
    relayHost,
    fetch,
    30000,
    fakeRelay(() => {
      throw new Error("socket exploded");
    }).runtime,
  );
  await assert.rejects(broken.call("daemon:status"), /Connection lost/);
  const failing = createClient(relayHost, fetch, 30000, fakeRelay(() => reply({ v: 1, error: { message: "The computer could not be reached" } }, 502)).runtime);
  await assert.rejects(failing.call("daemon:status"), /could not be reached/);
  const locked = createClient(relayHost, fetch, 30000, {
    ...fakeRelay(() => reply({ v: 1 })).runtime,
    transport: async () => {
      throw new Error("Could not read this phone's pairing key. Unlock your phone and try again.");
    },
  });
  await assert.rejects(locked.call("daemon:status"), /pairing key/);
});

test("a relay request that never answers times out like a fetch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = createClient(relayHost, fetch, 30000, fakeRelay(() => new Promise<RelayResponse>(() => {})).runtime);
  const pending = assert.rejects(client.call("daemon:status"), /Connection lost/);
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(30000);
  await pending;
});

test("a relay host is refused without a relay runtime, and its pairing must be well formed", () => {
  assert.throws(() => createClient(relayHost, fetch, 30000), /relay/i);
  assert.throws(
    () => createClient({ ...relayHost, relay: { ...relayHost.relay, key: "short" } }, fetch, 30000, fakeRelay(() => reply({ v: 1 })).runtime),
    /Scan the code again/,
  );
});

test("the live socket of a relay host rides the transport and keeps the same signals", async () => {
  const relay = fakeRelay(() => reply({ v: 1 }));
  const client = createClient(relayHost, fetch, 30000, relay.runtime);
  const signals: string[] = [],
    statuses: boolean[] = [];
  const live = client.live("/p q", { onSignal: (signal) => signals.push(signal), onStatus: (open) => statuses.push(open) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(relay.lives[0] !== undefined);
  assert.equal(relay.lives[0].path, "/live?projectPath=%2Fp%20q");
  relay.lives[0].onStatus(true);
  relay.lives[0].onData('{"type":"runs"}');
  relay.lives[0].onData('{"type":"ping"}');
  relay.lives[0].onData("not json");
  relay.lives[0].onData('{"type":"project"}');
  assert.deepEqual(signals, ["runs", "project"]);
  assert.deepEqual(statuses, [true]);
  live.close();
  assert.equal(relay.lives[0].closed, true);
});

test("a live socket closed before the relay transport is ready never opens", async () => {
  const relay = fakeRelay(() => reply({ v: 1 }));
  const client = createClient(relayHost, fetch, 30000, relay.runtime);
  client.live("/p", { onSignal() {}, onStatus() {} }).close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(relay.lives.length, 0);
});

test("relay images are fetched once into the cache folder and come back as file URIs", async () => {
  const png = new Uint8Array([137, 80, 78, 71]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const relay = fakeRelay(async () => {
    await gate;
    return { status: 200, headers: { "content-type": "image/png" }, body: png };
  });
  const client = createClient(relayHost, fetch, 30000, relay.runtime);
  const both = Promise.all([client.mediaFile("/p", "/p/shot.png"), client.mediaFile("/p", "/p/shot.png")]);
  release();
  const [first, second] = await both;
  assert.equal(first, second);
  assert.match(first, /^file:\/\/\/cache\/relay-media\/[a-f0-9]{16}\.png$/);
  assert.equal(relay.sent.length, 1);
  assert.ok(relay.sent[0] !== undefined);
  assert.equal(relay.sent[0].method, "GET");
  assert.equal(relay.sent[0].path, "/media?projectPath=%2Fp&path=%2Fp%2Fshot.png");
  assert.deepEqual([...relay.written.values()], [png]);
  assert.notEqual(await client.mediaFile("/p", "/p/other.png"), first);
  // The same image source each render, so a thumbnail does not reload.
  assert.equal(client.image("/p", "/p/shot.png"), client.image("/p", "/p/shot.png"));
  assert.deepEqual(await client.image("/p", "/p/shot.png"), { uri: first });
  // A new client finds the file already on disk.
  const again = fakeRelay(() => {
    throw new Error("should not fetch");
  });
  again.written.set(first.split("/").pop()!, png);
  assert.equal(await createClient(relayHost, fetch, 30000, again.runtime).mediaFile("/p", "/p/shot.png"), first);
});

test("a relay image that fails to load can be asked for again", async () => {
  let calls = 0;
  const relay = fakeRelay(() =>
    ++calls === 1 ? reply({ v: 1, error: { message: "Not found" } }, 404) : { status: 200, headers: {}, body: new Uint8Array([1]) },
  );
  const client = createClient(relayHost, fetch, 30000, relay.runtime);
  await assert.rejects(client.mediaFile("/p", "/p/a.jpg"), /image/);
  assert.match(await client.mediaFile("/p", "/p/a.jpg"), /\.jpg$/);
  assert.throws(() => client.media("/p", "/p/a.jpg"), /relay/i);
});

test("an HTTP host keeps its authenticated image URL as the image source", () => {
  const client = createClient({ address: "https://mac.example.com", token: "token" }, fetch);
  assert.deepEqual(client.image("/p", "/p/a.png"), client.media("/p", "/p/a.png"));
});

test("relay images load at most 4 at a time, in order, and calls never wait behind them", async () => {
  const held: { path: string; release: () => void }[] = [];
  const relay = fakeRelay((sent) =>
    sent.path.startsWith("/media")
      ? new Promise<RelayResponse>((resolve) => held.push({ path: sent.path, release: () => resolve({ status: 200, headers: {}, body: new Uint8Array([1]) }) }))
      : reply({ v: 1, result: "ok" }),
  );
  const client = createClient(relayHost, fetch, 30000, relay.runtime);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const loads = Array.from({ length: 10 }, (_, i) => client.image("/p", `/p/${i}.png`));
  await settle();
  const media = () => relay.sent.filter((sent) => sent.path.startsWith("/media")).map((sent) => new URLSearchParams(sent.path.split("?")[1]).get("path"));
  assert.deepEqual(media(), ["/p/0.png", "/p/1.png", "/p/2.png", "/p/3.png"]);
  assert.equal(await client.call("daemon:status"), "ok");
  assert.ok(held[0] !== undefined);
  held[0].release();
  await settle();
  assert.deepEqual(media().slice(4), ["/p/4.png"]);
  let most = 0;
  while (held.some((item) => item.release)) {
    const next = held.find((item) => item.release)!;
    const release = next.release;
    next.release = undefined as unknown as () => void;
    release();
    await settle();
    most = Math.max(most, held.filter((item) => item.release).length);
  }
  assert.ok(most <= 4, `at most 4 images in flight, saw ${most}`);
  assert.equal((await Promise.all(loads)).length, 10);
  assert.equal(media().length, 10);
});

test("drawer previews use a separate ETag route and accept full snapshots from an older host", async () => {
  const routes: string[] = [];
  const full = { project: { path: "/p" }, runs: { runs: {} } };
  const client = createClient({ address: "http://127.0.0.1:8787", token: "token" }, async (url) => {
    routes.push(String(url));
    return new Response(JSON.stringify({ v: 1, result: full }));
  });
  assert.deepEqual(await client.preview("/p"), full);
  await client.snapshot("/p");
  assert.ok(routes[0] !== undefined);
  assert.ok(routes[0].endsWith("/snapshot?projectPath=%2Fp&view=chats"));
  assert.ok(routes[1] !== undefined);
  assert.ok(routes[1].endsWith("/snapshot?projectPath=%2Fp"));
});

test("chat lists name their Projects in one encoded route, and a Mac without the route reports it as unsupported", async () => {
  const routes: string[] = [];
  const lists = { "/a b": { project: { path: "/a b" }, runs: { runs: {} }, previewOnly: true }, "/gone": { error: "Not found" } };
  const client = createClient({ address: "http://127.0.0.1:8787", token: "token" }, async (url) => {
    routes.push(String(url));
    return new Response(JSON.stringify({ v: 1, result: lists }));
  });
  assert.deepEqual(await client.chatLists(["/a b", "/gone"]), lists);
  assert.ok(routes[0]?.endsWith("/chat-lists?paths=" + encodeURIComponent(JSON.stringify(["/a b", "/gone"]))));
  const older = createClient(
    { address: "http://127.0.0.1:8787", token: "token" },
    async () => new Response(JSON.stringify({ v: 1, error: { message: "Unknown endpoint" } }), { status: 404 }),
  );
  await assert.rejects(older.chatLists(["/a"]), (error) => (error as { code?: string }).code === "unsupported");
  const busy = createClient(
    { address: "http://127.0.0.1:8787", token: "token" },
    async () => new Response(JSON.stringify({ v: 1, error: { message: "Too many pending requests" } }), { status: 429 }),
  );
  await assert.rejects(busy.chatLists(["/a"]), (error) => (error as { code?: string }).code === undefined);
});

const cloudflareHost = {
  address: "https://mac.example.com",
  token: "a".repeat(64),
  access: { id: `${"a".repeat(32)}.access`, secret: "b".repeat(40) },
};
/** A route view the test can switch, like the supervisor's. */
function lanView(first: RelayTransport | null) {
  const listeners = new Set<() => void>();
  let transport = first;
  const view: RouteView & { switch(next: RelayTransport | null): void } = {
    current: () => transport,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    switch(next) {
      transport = next;
      for (const listener of listeners) listener();
    },
  };
  return { view, listeners };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a Cloudflare computer's requests go through the LAN transport while it is up, and back to HTTPS after", async () => {
  const lan = fakeRelay(() => reply({ v: 1, result: "over-lan" }));
  const { view } = lanView(null);
  const asked: string[] = [];
  const fetcher = (async (url: string) => (asked.push(url), new Response(JSON.stringify({ v: 1, result: "over-https" })))) as unknown as typeof fetch;
  const hosts: unknown[] = [];
  const client = createClient(cloudflareHost, fetcher, 30000, {
    ...lan.runtime,
    lan: (host) => (hosts.push(host), view),
  });
  assert.deepEqual(hosts, [{ id: "https://mac.example.com", token: cloudflareHost.token }]);
  assert.equal(await client.call("daemon:status"), "over-https");
  assert.equal(lan.sent.length, 0);
  view.switch(lan.transport);
  assert.equal(await client.call("daemon:status"), "over-lan");
  assert.equal(lan.sent.length, 1);
  assert.ok(lan.sent[0] !== undefined);
  assert.equal(lan.sent[0].path, "/rpc");
  assert.equal(lan.sent[0].headers.Authorization, undefined, "the LAN handshake carries the token, not each request");
  assert.equal(lan.opened.length, 0, "a Cloudflare computer has no relay to open");
  view.switch(null);
  assert.equal(await client.call("daemon:status"), "over-https");
  assert.equal(asked.length, 2);
  assert.equal(lan.sent.length, 1);
});

test("a relay computer's requests prefer the LAN transport and fall back to the relay", async () => {
  const lan = fakeRelay(() => reply({ v: 1, result: "over-lan" }));
  const relay = fakeRelay(() => reply({ v: 1, result: "over-relay" }));
  const { view } = lanView(lan.transport);
  const client = createClient(relayHost, fetch, 30000, { ...relay.runtime, lan: () => view });
  assert.equal(await client.call("daemon:status"), "over-lan");
  assert.equal(relay.sent.length, 0);
  view.switch(null);
  assert.equal(await client.call("daemon:status"), "over-relay");
  assert.equal(relay.sent.length, 1);
});

test("a client without a LAN route in its runtime behaves as before", async () => {
  const relay = fakeRelay(() => reply({ v: 1, result: "over-relay" }));
  const client = createClient(relayHost, fetch, 30000, relay.runtime);
  assert.equal(await client.call("daemon:status"), "over-relay");
  const live = client.live("/p", { onSignal() {}, onStatus() {} });
  await settle();
  assert.equal(relay.lives.length, 1);
  live.close();
});

test("a request over a LAN that dropped fails with the lost-connection copy", async () => {
  const lan = fakeRelay(() => {
    throw new Error("socket closed");
  });
  const { view } = lanView(lan.transport);
  const client = createClient(cloudflareHost, async () => new Response(JSON.stringify({ v: 1, result: "over-https" })), 30000, {
    ...lan.runtime,
    lan: () => view,
  });
  await assert.rejects(client.call("daemon:status"), /Connection lost/);
});

test("a Cloudflare computer's live stream follows the LAN: the old stream closes and the new one opens", async () => {
  const lan = fakeRelay(() => reply({ v: 1 }));
  const { view, listeners } = lanView(null);
  const sockets: { url: string; closed: boolean }[] = [];
  const create = (url: string) => {
    const socket = { url, closed: false, addEventListener() {}, close: () => void (socket.closed = true) };
    sockets.push(socket);
    return socket;
  };
  const statuses: boolean[] = [];
  const client = createClient(cloudflareHost, fetch, 30000, { ...lan.runtime, lan: () => view });
  const live = client.live("/p", { onSignal() {}, onStatus: (up) => statuses.push(up), create });
  assert.equal(sockets.length, 1, "opened over the tunnel");
  assert.ok(sockets[0] !== undefined);
  assert.equal(sockets[0].url, "wss://mac.example.com/live?projectPath=%2Fp");
  view.switch(lan.transport);
  await settle();
  assert.equal(sockets[0].closed, true, "the tunnel stream closed");
  assert.equal(lan.lives.length, 1, "reopened on the LAN");
  assert.ok(lan.lives[0] !== undefined);
  assert.equal(lan.lives[0].path, "/live?projectPath=%2Fp");
  assert.equal(sockets.length, 1);
  assert.deepEqual(statuses, [false]);
  view.switch(null);
  await settle();
  assert.equal(lan.lives[0].closed, true, "the LAN stream closed when the LAN went away");
  assert.equal(sockets.length, 2, "back on the tunnel");
  live.close();
  assert.ok(sockets[1] !== undefined);
  assert.equal(sockets[1].closed, true);
  assert.equal(listeners.size, 0, "closing the stream stops watching the route");
});

test("a relay computer's live stream reopens on the LAN, and back on the relay, closing each old one", async () => {
  const lan = fakeRelay(() => reply({ v: 1 }));
  const relay = fakeRelay(() => reply({ v: 1 }));
  const { view, listeners } = lanView(null);
  const client = createClient(relayHost, fetch, 30000, { ...relay.runtime, lan: () => view });
  const signals: string[] = [];
  const live = client.live("/p", { onSignal: (signal) => signals.push(signal), onStatus() {} });
  await settle();
  assert.equal(relay.lives.length, 1);
  view.switch(lan.transport);
  await settle();
  assert.ok(relay.lives[0] !== undefined);
  assert.equal(relay.lives[0].closed, true);
  assert.equal(lan.lives.length, 1);
  assert.ok(lan.lives[0] !== undefined);
  lan.lives[0].onData('{"type":"runs"}');
  assert.deepEqual(signals, ["runs"]);
  view.switch(null);
  await settle();
  assert.equal(lan.lives[0].closed, true);
  assert.equal(relay.lives.length, 2);
  assert.ok(relay.lives[1] !== undefined);
  assert.equal(relay.lives[1].closed, false);
  live.close();
  assert.equal(relay.lives[1].closed, true);
  assert.equal(listeners.size, 0);
});

test("a route change that leaves the same transport in place does not reopen the stream", async () => {
  const lan = fakeRelay(() => reply({ v: 1 }));
  const { view } = lanView(lan.transport);
  const client = createClient(cloudflareHost, fetch, 30000, { ...lan.runtime, lan: () => view });
  const live = client.live("/p", { onSignal() {}, onStatus() {} });
  await settle();
  view.switch(lan.transport);
  await settle();
  assert.equal(lan.lives.length, 1);
  assert.ok(lan.lives[0] !== undefined);
  assert.equal(lan.lives[0].closed, false);
  live.close();
});

test("images of a Cloudflare computer load through the LAN transport while it is up", async () => {
  const lan = fakeRelay(() => ({ status: 200, headers: {}, body: new Uint8Array([1, 2, 3]) }));
  const { view } = lanView(lan.transport);
  const client = createClient(
    cloudflareHost,
    async () => {
      throw new Error("the LAN carries images while it is up");
    },
    30000,
    { ...lan.runtime, lan: () => view },
  );
  const source = client.image("/p", "/p/a.png");
  assert.ok(source instanceof Promise, "an image over the LAN is fetched to a file");
  assert.match((await source).uri, /^file:\/\/\/cache\/relay-media\/[a-f0-9]{16}\.png$/);
  assert.ok(lan.sent[0] !== undefined);
  assert.equal(lan.sent[0].path, "/media?projectPath=%2Fp&path=%2Fp%2Fa.png");
  assert.throws(() => client.media("/p", "/p/a.png"), /mediaFile/);
});

test("images of a Cloudflare computer stay URLs while the LAN is down", () => {
  const lan = fakeRelay(() => reply({ v: 1 }));
  const { view } = lanView(null);
  const client = createClient(cloudflareHost, fetch, 30000, { ...lan.runtime, lan: () => view });
  assert.deepEqual(client.image("/p", "/p/a.png"), client.media("/p", "/p/a.png"));
});

test("an image queued behind four others rides the route that is current when it starts, not when it was asked for", async () => {
  const held: (() => void)[] = [];
  const lan = fakeRelay(() => new Promise<RelayResponse>((resolve) => held.push(() => resolve({ status: 200, headers: {}, body: new Uint8Array([1]) }))));
  const relay = fakeRelay(() => ({ status: 200, headers: {}, body: new Uint8Array([2]) }));
  const { view } = lanView(lan.transport);
  const client = createClient(relayHost, fetch, 30000, { ...relay.runtime, lan: () => view });
  const loads = Array.from({ length: 5 }, (_, i) => client.mediaFile("/p", `/p/${i}.png`));
  await settle();
  assert.equal(lan.sent.length, 4);
  view.switch(null);
  assert.ok(held[0] !== undefined);
  held[0]();
  await settle();
  assert.equal(lan.sent.length, 4, "the fifth image must not start on the LAN transport that was replaced");
  assert.equal(relay.sent.length, 1);
  assert.ok(relay.sent[0] !== undefined);
  assert.match(relay.sent[0].path, /%2Fp%2F4\.png/);
  held.slice(1).forEach((release) => release());
  await Promise.all(loads);
});

test("a host that numbers snapshots sends the next one as a patch on the one the app holds", async () => {
  const { diffState } = await import("@milagre/shared/state-patch");
  const sent: (string | undefined)[] = [];
  const v1 = { project: { path: "/p", state: { sessions: { 1: { id: 1, title: "One" } }, messages: [{ id: 1, body: "hi" }] } }, runs: { runs: {} } };
  const v2 = { ...v1, project: { ...v1.project, state: { ...v1.project.state, sessions: { 1: { id: 1, title: "Renamed" } } } } };
  const answers = [
    { epoch: "e", version: 1, snapshot: v1 },
    { epoch: "e", version: 2, base: 1, patch: diffState(v1, v2, 6) },
    // A patch on a snapshot the app doesn't hold: it asks again for the whole one.
    { epoch: "e", version: 9, base: 7, patch: {} },
    { epoch: "e", version: 10, snapshot: v2 },
  ];
  const client = createClient({ address: "http://127.0.0.1:8787", token: "token" }, async (_url, init) => {
    // oxlint-disable-next-line no-unsafe-optional-chaining -- test stub; init is always passed by the code under test
    sent.push((init?.headers as Record<string, string>)["X-Milagre-Snapshot-Since"]);
    return new Response(JSON.stringify({ v: 1, result: answers.shift() }));
  });
  const first = await client.snapshot("/p");
  assert.deepEqual(first, v1);
  const second = await client.snapshot("/p");
  assert.deepEqual(second, v2);
  assert.equal(second.project.state.messages, first.project.state.messages, "what the patch leaves alone is the same object");
  assert.deepEqual(await client.snapshot("/p"), v2);
  assert.deepEqual(sent, ["none", "e:1", "e:2", "none"]);
});

test("the app asks for snapshots without messages and reads a Chat's as pages", async () => {
  const sent: { url: string; pages?: string }[] = [];
  const client = createClient({ address: "http://127.0.0.1:8787", token: "token" }, async (url, init) => {
    // oxlint-disable-next-line no-unsafe-optional-chaining -- test stub; init is always passed by the code under test
    sent.push({ url: String(url), pages: (init?.headers as Record<string, string>)["X-Milagre-Chat-Pages"] });
    const result = String(url).includes("/chat-messages")
      ? { messages: [], hasMore: false, total: 0 }
      : { project: { path: "/p", state: {} }, runs: { runs: {} } };
    return new Response(JSON.stringify({ v: 1, result }));
  });
  await client.snapshot("/p");
  await client.chatMessages("/p", 7, { before: 40, turns: 5 });
  assert.ok(sent[0] !== undefined);
  assert.equal(sent[0].pages, "1");
  assert.ok(sent[1] !== undefined);
  assert.ok(sent[1].url.endsWith("/chat-messages?projectPath=%2Fp&chatId=7&before=40&turns=5"));
});

test("device consent runs before RPC traffic and refusal never sends", async () => {
  let calls = 0;
  let decide!: () => void;
  let reject = false;
  const runtime: RelayRuntime = {
    transport: async () => {
      throw Error("not used");
    },
    files: { find: async () => null, write: async () => "unused" },
    beforeCall: async (method, args) => {
      assert.equal(method, "chat:send");
      assert.deepEqual(args, [{ body: "private draft" }]);
      if (reject) throw Error("permission required");
      await new Promise<void>((resolve) => {
        decide = resolve;
      });
    },
  };
  const client = createClient(
    { address: "http://127.0.0.1:8787", token: "fixture" },
    async () => {
      calls++;
      return new Response(JSON.stringify({ v: 1, result: "sent" }));
    },
    10,
    runtime,
  );
  const sending = client.call("chat:send", [{ body: "private draft" }]);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(calls, 0);
  decide();
  assert.equal(await sending, "sent");
  assert.equal(calls, 1);
  reject = true;
  await assert.rejects(client.call("chat:send", [{ body: "private draft" }]), /permission/);
  assert.equal(calls, 1);
});
