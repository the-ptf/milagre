import { test } from "node:test";
import assert from "node:assert/strict";
import type { Artifact } from "@milagre/shared/artifact";
import type { Client } from "./client.ts";
import { designFontCache, loadCanvasDesign } from "./design-font-cache.ts";

type Source = Pick<Client, "url" | "call">;
type CanvasRequest = { chatId: string; id: string; version?: number; fonts?: { have: string[] } };
const request = { chatId: "/p#1", id: "home" };
const artifact = (extra = {}) => ({ format: "design", id: "home", version: 2, html: "<head></head>", ...extra }) as Artifact;
function source(call: (method: string, args: [CanvasRequest]) => Promise<Artifact>, url = "mac"): Source {
  return { url, call } as Source;
}

test("canvas fonts survive sheet closes, are advertised, and active designs retain evicted CSS", async () => {
  const fonts = designFontCache("cache-test");
  const calls: CanvasRequest[] = [];
  const client = source(async (_method, [req]) => {
    calls.push(req);
    return artifact({ fontKey: req.id, ...(req.fonts!.have.includes(req.id) ? {} : { fontCss: `css-${req.id}` }) });
  });
  const first = await loadCanvasDesign(client, request, fonts);
  const held = await loadCanvasDesign(client, request, designFontCache("cache-test"));
  assert.equal(held.format === "design" && held.fontCss, "css-home");
  assert.deepEqual(calls[1]!.fonts!.have, ["home"]);
  for (let i = 0; i < 9; i++) await loadCanvasDesign(client, { ...request, id: `font-${i}` }, fonts);
  assert.equal(fonts.size, 8);
  assert.equal(fonts.has("home"), false);
  assert.equal(first.format === "design" && first.fontCss, "css-home");
});

test("late replies keep their original Computer's cache and switching back starts empty", async () => {
  let finish!: (value: Artifact) => void;
  const old = designFontCache("old-mac");
  const pending = loadCanvasDesign(
    source(() => new Promise((resolve) => (finish = resolve))),
    request,
    old,
  );
  const current = designFontCache("new-mac");
  finish(artifact({ fontKey: "old", fontCss: "old-css" }));
  await pending;
  assert.equal(old.get("old"), "old-css");
  assert.equal(current.size, 0);
  assert.equal(designFontCache("old-mac").size, 0);
});

test("missing font CSS retries once at the response version; full and fontless responses pass through", async () => {
  const calls: CanvasRequest[] = [];
  const full = artifact();
  const client = source(async (_method, [req]) => {
    calls.push(req);
    return req.fonts ? artifact({ fontKey: "missing", version: 3 }) : full;
  });
  assert.equal(await loadCanvasDesign(client, request, new Map()), full);
  assert.deepEqual(calls[1], { ...request, version: 3 });
  assert.equal(calls.length, 2);
  const plain = source(async () => full);
  assert.equal(await loadCanvasDesign(plain, request, new Map()), full);
});

test("only an unsupported fonts argument triggers remembered old-Mac fallback, reset by a new client", async () => {
  const calls: CanvasRequest[] = [];
  const call = async (_method: string, [req]: [CanvasRequest]) => {
    calls.push(req);
    if (req.fonts) throw Error("Invalid arguments: input Unrecognized key: fonts");
    return artifact();
  };
  const client = source(call);
  await loadCanvasDesign(client, request, new Map());
  await loadCanvasDesign(client, request, new Map());
  assert.deepEqual(
    calls.map((req) => !!req.fonts),
    [true, false, false],
  );
  await loadCanvasDesign(source(call), request, new Map());
  assert.deepEqual(
    calls.slice(-2).map((req) => !!req.fonts),
    [true, false],
  );
  for (const message of ["HTTP 429", "Mac busy", "Invalid arguments: id invalid", "This design is no longer available."]) {
    let count = 0;
    await assert.rejects(
      loadCanvasDesign(
        source(async () => {
          count++;
          throw Error(message);
        }),
        request,
        new Map(),
      ),
      { message },
    );
    assert.equal(count, 1);
  }
});

test("a failing plain fallback does not permanently mark a host unsupported", async () => {
  const calls: CanvasRequest[] = [];
  const client = source(async (_method, [req]) => {
    calls.push(req);
    throw Error(req.fonts ? "Invalid arguments: fonts not allowed" : "Temporarily unavailable");
  });
  for (let i = 0; i < 2; i++) await assert.rejects(loadCanvasDesign(client, request, new Map()), /Temporarily unavailable/);
  assert.deepEqual(
    calls.map((req) => !!req.fonts),
    [true, false, true, false],
  );
});
