// oxlint-disable eslint/no-underscore-dangle -- Fixed Tauri and diagnostic globals.
// Fixed probe for the isolated fixture only. No caller script/path inputs or provider sends.
void (async () => {
  if (window.__fixtureNativeSmoke) return;
  window.__fixtureNativeSmoke = true;
  const bounded = (promise, label, ms = 3000) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`Timed out invoke: ${label}`)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  const invoke = (method, args) => bounded(window.__TAURI__.core.invoke(method, args), method);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const wait = async (fn, label) => {
    const until = Date.now() + 8000;
    let last;
    while (Date.now() < until) {
      try {
        const value = await bounded(Promise.resolve().then(fn), label, Math.max(1, Math.min(3000, until - Date.now())));
        if (value) return value;
      } catch (error) {
        last = error.message || String(error);
      }
      await pause(100);
    }
    throw Error(`Timed out: ${label}${last ? ` (${last})` : ""}`);
  };
  let context;
  const result = { passed: false, phase: 0 };
  const marker = "__rust_fixture_native_smoke__";
  const nativeKey = "milagre.fixture.nativeSmoke";
  const database = () =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open("milagre-outbox-v1", 1);
      request.addEventListener("upgradeneeded", () => {
        request.transaction.abort();
        reject(Error("Production outbox database is not initialized"));
      });
      request.addEventListener("error", () => reject(request.error));
      request.addEventListener("success", () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("queue")) {
          db.close();
          reject(Error("Production outbox queue missing"));
        } else resolve(db);
      });
    });
  const read = (db, key) =>
    new Promise((resolve, reject) => {
      const request = db.transaction("queue").objectStore("queue").get(key);
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
  const write = (db, key, value) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction("queue", "readwrite");
      tx.objectStore("queue").put(value, key);
      tx.addEventListener("complete", resolve);
      tx.addEventListener("error", () => reject(tx.error));
      tx.addEventListener("abort", () => reject(tx.error || Error("Marker write aborted")));
    });
  try {
    context = await wait(() => invoke("native_call", { method: "fixture:smoke-context", args: [] }), "native nonpersistent store");
    result.phase = context.phase;
    await wait(() => window.__rustDiagnostics?.ready && document.querySelector('button[aria-label="Settings"]'), "production renderer");
    await bounded(document.fonts.ready, "fonts");
    const current = await bounded(window.milagre.getCurrentProject(), "project:current");
    if (current?.path !== context.project) throw Error("Renderer connected to a different Project");
    if (Object.keys(current.state?.sessions ?? {}).length !== 2) throw Error("Generated Project sessions missing");
    const dock = document.querySelector("[data-dock-layer]");
    if (!dock || getComputedStyle(dock).display !== "flex") throw Error("Production workspace CSS missing");
    const prefs = await invoke("preferences_read");
    const db = await wait(database, "production outbox store");
    try {
      const local = localStorage.getItem(marker);
      const queuedMarker = await bounded(read(db, marker), "IDB marker");
      const before = await bounded(read(db, "state"), "IDB state");
      const expected = context.phase === 0 ? null : context.nonce;
      if (local !== expected || (prefs[nativeKey] ?? null) !== expected || (queuedMarker ?? null) !== expected)
        throw Error("Storage marker was inherited or lost across reload");
      if (context.phase === 0) {
        localStorage.setItem(marker, context.nonce);
        await invoke("preferences_write", { key: nativeKey, value: context.nonce });
        await bounded(write(db, marker, context.nonce), "IDB write");
      }
      if (
        localStorage.getItem(marker) !== context.nonce ||
        (await invoke("preferences_read"))[nativeKey] !== context.nonce ||
        (await bounded(read(db, marker), "IDB readback")) !== context.nonce
      )
        throw Error("Storage readback failed");
      const after = await bounded(read(db, "state"), "IDB state after");
      if (JSON.stringify(before) !== JSON.stringify(after)) throw Error("Probe changed the outbox state record");
      result.storage = {
        fresh: context.phase === 0,
        reloadPreserved: context.phase === 1,
        localStorage: true,
        nativePreferences: true,
        actualOutboxDatabase: true,
        outboxStateUnchanged: true,
        outboxItems: before?.items?.length ?? 0,
      };
    } finally {
      db.close();
    }
    for (const animation of document.getAnimations()) {
      if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) {
        try {
          animation.finish();
        } catch {}
      }
    }
    result.renderer = {
      ready: true,
      project: current.path,
      chats: document.querySelectorAll("[data-chat-id]").length,
      dockDisplay: getComputedStyle(dock).display,
      width: innerWidth,
      height: innerHeight,
      visibility: document.visibilityState,
      theme: document.documentElement.getAttribute("data-theme"),
      text: document.body.innerText.slice(0, 2000),
    };
    result.passed = true;
  } catch (error) {
    result.error = error.message || String(error);
  }
  result.diagnostics = {
    errors: window.__rustDiagnostics?.errors?.slice(-30),
    calls: window.__rustDiagnostics?.calls?.slice(-50).map(({ method, error, pending }) => ({ method, error, pending })),
  };
  await bounded(window.__TAURI__.core.invoke("smoke_result", { value: JSON.stringify(result) }), "native capture/quit", 35000);
})();
