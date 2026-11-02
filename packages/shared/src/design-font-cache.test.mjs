import test from "node:test";
import assert from "node:assert/strict";
import { createDesignFontReader, restoreDesignFonts } from "./design-font-cache.mjs";

const request = { chatId: "/p#1", id: "home" };
const artifact = (extra = {}) => ({ format: "design", id: "home", version: 2, html: "<head></head>", ...extra });

test("readers advertise previous fonts; active documents retain evicted CSS", async () => {
  const calls = [];
  const read = createDesignFontReader(async (req) => {
    calls.push(req);
    return artifact({ fontKey: req.id, ...(!req.fonts.have.includes(req.id) ? { fontCss: `css-${req.id}` } : {}) });
  });
  const first = await read(request);
  const second = await read(request);
  assert.deepEqual(calls[1].fonts.have, ["home"]);
  assert.equal(second.fontCss, "css-home");
  for (let i = 0; i < 9; i++) await read({ ...request, id: `font-${i}` });
  await read(request);
  assert.equal(calls.at(-1).fonts.have.length, 8);
  assert.equal(calls.at(-1).fonts.have.includes("home"), false);
  assert.equal(first.fontCss, "css-home");
  const full = restoreDesignFonts(first);
  assert.equal(full.html, "<head><style>css-home</style></head>");
  assert.equal(full.fontKey, undefined);
  assert.equal(restoreDesignFonts(full), full);
});

test("a late reply from one Computer cannot change another reader's cache", async () => {
  let finish;
  const old = createDesignFontReader(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = old(request);
  await Promise.resolve();
  const other = createDesignFontReader(async (req) => {
    assert.deepEqual(req.fonts.have, []);
    return artifact();
  });
  finish(artifact({ fontKey: "old", fontCss: "css" }));
  await pending;
  await other(request);
});

test("missing CSS falls back at the returned version; full responses pass through", async () => {
  const calls = [];
  const full = artifact();
  const read = createDesignFontReader(async (req) => {
    calls.push(req);
    return req.fonts ? artifact({ fontKey: "missing", version: 3 }) : full;
  });
  assert.equal(await read(request), full);
  assert.deepEqual(calls[1], { ...request, version: 3 });
  assert.equal(calls.length, 2);
  assert.equal(restoreDesignFonts(full), full);
});

test("only the optional field's rejection remembers old-host fallback; reconnect resets it", async () => {
  const calls = [];
  const read = createDesignFontReader(async (req) => {
    calls.push(req);
    if (req.fonts) throw Error("Invalid arguments: input Unrecognized key: fonts");
    return artifact();
  });
  await read(request);
  await read(request);
  assert.deepEqual(
    calls.map((req) => !!req.fonts),
    [true, false, false],
  );
  read.reconnect();
  await read(request);
  assert.deepEqual(
    calls.slice(-2).map((req) => !!req.fonts),
    [true, false],
  );
  for (const message of ["HTTP 429", "Mac busy", "Invalid arguments: id invalid", "This design is no longer available."]) {
    let count = 0;
    const retry = createDesignFontReader(async () => {
      count++;
      throw Error(message);
    });
    await assert.rejects(retry(request), { message });
    await assert.rejects(retry(request), { message });
    assert.equal(count, 2, "a rejected request must not poison its queue");
  }
});

test("Electron-wrapped argument rejection falls back, while unrelated wrapped errors do not", async () => {
  const calls = [];
  const read = createDesignFontReader(async (req) => {
    calls.push(req);
    if (req.fonts) throw Error("Error invoking remote method 'computers:invoke': Error: Invalid arguments: input Unrecognized key: fonts");
    return artifact();
  });
  await read(request);
  await read(request);
  assert.deepEqual(
    calls.map((req) => !!req.fonts),
    [true, false, false],
  );
  const failing = createDesignFontReader(async () => {
    throw Error("Error invoking remote method 'computers:invoke': Error: Invalid arguments: id missing");
  });
  await assert.rejects(failing(request), /id missing/);
});

test("a malformed split head is recovered using the returned version", async () => {
  const calls = [];
  const full = artifact();
  const read = createDesignFontReader(async (req) => {
    calls.push(req);
    return req.fonts ? artifact({ html: "<body>legacy</body>", version: 3, fontKey: "held", fontCss: "css" }) : full;
  });
  assert.equal(await read(request), full);
  assert.deepEqual(calls[1], { ...request, version: 3 });
});

test("a failed plain retry and an old generation's fallback cannot disable negotiation", async () => {
  const calls = [];
  const read = createDesignFontReader(async (req) => {
    calls.push(req);
    throw Error(req.fonts ? "Invalid arguments: fonts not allowed" : "Temporarily unavailable");
  });
  for (let i = 0; i < 2; i++) await assert.rejects(read(request), /Temporarily unavailable/);
  assert.deepEqual(
    calls.map((req) => !!req.fonts),
    [true, false, true, false],
  );
  let finish;
  let fallbacks = 0;
  let started;
  const plainStarted = new Promise((resolve) => {
    started = resolve;
  });
  const pending = createDesignFontReader(async (req) => {
    if (req.fonts) throw Error("Invalid arguments: fonts not allowed");
    fallbacks++;
    if (fallbacks > 1) return artifact();
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const first = pending(request);
  await plainStarted;
  pending.reconnect();
  finish(artifact());
  await first;
  await pending(request);
  assert.equal(fallbacks, 2, "a late fallback cannot mark the new connection unsupported");
});
