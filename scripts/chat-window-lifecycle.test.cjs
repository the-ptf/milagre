// Simulated hook tests for paging races. Real commit ordering is covered by test-chat-subscription-handoff.cjs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { setImmediate: settle } = require("node:timers/promises");

function fixture(platform, { failFirst = false, stallFirst = false } = {}) {
  let cursor = 0;
  const slots = [],
    effects = [];
  const react = {
    useCallback(fn, deps) {
      const at = cursor++,
        old = slots[at];
      if (!old || deps.some((value, i) => value !== old.deps[i])) slots[at] = { fn, deps };
      return slots[at].fn;
    },
    useEffect(fn, deps) {
      const at = cursor++,
        old = slots[at];
      if (!old || deps.some((value, i) => value !== old.deps[i])) {
        old?.cleanup?.();
        slots[at] = { deps };
        effects.push(() => {
          slots[at].cleanup = fn();
        });
      }
    },
    useSyncExternalStore(subscribe, read) {
      const at = cursor++;
      if (slots[at]?.subscribe !== subscribe) {
        slots[at]?.cleanup?.();
        slots[at] = { subscribe, cleanup: subscribe(() => {}) };
      }
      return read();
    },
  };
  const messages = Array.from({ length: 120 }, (_, index) => ({
    id: index + 1,
    session_id: 1,
    role: index % 2 ? "assistant" : "user",
    body: `message ${index + 1}`,
  }));
  let notifyMessages;
  let held,
    abort,
    hold = false,
    requests = 0,
    reconnects = 0;
  const read = async (_scope, _id, options) => {
    requests++;
    if (requests === 1 && failFirst) throw new Error("Read interrupted");
    if (requests === 1 && stallFirst)
      return new Promise((resolve, reject) => {
        held = () => resolve({ messages: [], hasMore: false, total: 0 });
        abort = () => reject(new Error("The request took too long"));
      });
    const end = options.before ? messages.findIndex((m) => m.id === options.before) : messages.length;
    // Force Find to take several pages even when it requests a larger batch.
    const start = Math.max(0, end - 40);
    const page = { messages: messages.slice(start, end), total: messages.length, hasMore: start > 0 };
    if (hold && options.before)
      return new Promise((resolve) => {
        held = () => resolve(page);
      });
    return page;
  };
  const client = { url: "ws://fixture", chatMessages: read };
  const file = platform === "desktop" ? "apps/desktop/app/src/lib/chat-messages.ts" : "apps/mobile/src/chat-pages.ts";
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require(id) {
      if (id === "react") return react;
      if (id === "./offline-cache.ts") return { rememberChat() {} };
      if (id === "./computer-bridge.ts") return { bridgeForKey: () => ({ readChatMessages: read }), isRemoteKey: () => false };
      if (id === "./state-events.ts")
        return {
          stateEvents: {
            onMessages(listener) {
              notifyMessages = listener;
            },
          },
        };
      return require(id);
    },
  });
  const render = () => {
    cursor = 0;
    const page = platform === "desktop" ? exports.useChatMessages("/p", 1) : exports.useChatPage(client, "/p", 1, undefined, reconnects);
    for (const effect of effects.splice(0)) effect();
    return page;
  };
  const unmount = () => {
    for (const slot of slots) slot?.cleanup?.();
    slots.length = 0;
  };
  return {
    render,
    unmount,
    // Desktop learns of a reconnect from the runtime snapshot; the phone from the session's recovery count.
    reconnect: () => (platform === "desktop" ? notifyMessages({ scope: "/p", reset: true }) : void reconnects++),
    hold: () => {
      hold = true;
    },
    finish: () => {
      hold = false;
      held();
    },
    // The phone's client gives up on a request at its own deadline (30 s, after retries while the Mac is busy).
    abort: () => abort(),
    requests: () => requests,
  };
}

for (const platform of ["desktop", "mobile"]) {
  test(`${platform}: leaving/reopening during an earlier-page read cannot lose the intervening messages`, async () => {
    const f = fixture(platform);
    try {
      f.render();
      await settle();
      await f.render().loadEarlier();
      assert.equal(f.render().messages[0].id, 41);
      f.hold();
      const request = f.render().loadEarlier();
      f.unmount();
      await settle();
      assert.equal(f.render().messages[0].id, 81, "expanded history was trimmed while inactive");
      f.finish();
      await request;
      await settle();
      let page = f.render();
      assert.equal(page.messages[0].id, 81, "obsolete page is discarded");
      assert.equal(page.hasMore, true);
      await page.loadEarlier();
      await f.render().loadEarlier();
      page = f.render();
      assert.deepEqual(
        Array.from(page.messages, (m) => m.id),
        Array.from({ length: 120 }, (_, i) => i + 1),
      );
      assert.equal(page.hasMore, false);
    } finally {
      f.unmount();
    }
  });
}

test("desktop: closing Find cancels further page requests without leaving the Chat", async () => {
  const f = fixture("desktop");
  try {
    f.render();
    await settle();
    f.hold();
    const controller = new AbortController();
    const find = f.render().loadAll(controller.signal);
    controller.abort();
    f.finish();
    await find;
    assert.equal(f.requests(), 2, "only the initial page and already in-flight earlier page were requested");
    assert.equal(f.render().hasMore, true);
  } finally {
    f.unmount();
  }
});

for (const platform of ["desktop", "mobile"]) {
  test(`${platform}: reopening retries a failed first page instead of keeping an empty cached Chat`, async () => {
    const f = fixture(platform, { failFirst: true });
    try {
      f.render();
      await settle();
      assert.match(f.render().error, /Read interrupted/);
      f.unmount();
      f.render();
      await settle();
      assert.equal(f.render().messages.length, 40);
      assert.equal(f.render().error, undefined);
    } finally {
      f.unmount();
    }
  });

  test(`${platform}: a stalled first page gives up and retry ignores its late empty answer`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(platform, { stallFirst: true });
    try {
      f.render();
      await settle();
      // The desktop bounds the read itself; the phone leaves that to its client, which rejects at its deadline.
      if (platform === "desktop") t.mock.timers.tick(15_000);
      else f.abort();
      await settle();
      const failed = f.render();
      assert.equal(failed.loading, false);
      assert.match(failed.error, platform === "desktop" ? /read took too long/ : /request took too long/);
      await failed.retry();
      assert.equal(f.render().messages.length, 40);
      if (platform === "desktop") {
        f.finish();
        await settle();
      }
      assert.equal(f.render().messages.length, 40);
      assert.equal(f.render().error, undefined);
    } finally {
      f.unmount();
    }
  });
}

test("desktop: reconnect replaces a stalled pre-disconnect page immediately and ignores its late empty answer", async () => {
  const f = fixture("desktop", { stallFirst: true });
  try {
    f.render();
    await settle();
    assert.equal(f.render().loading, true);
    f.reconnect();
    await settle();
    assert.equal(f.render().messages.length, 40);
    f.finish();
    await settle();
    assert.equal(f.render().messages.length, 40);
  } finally {
    f.unmount();
  }
});

test("desktop: reconnect discards an earlier page requested before the connection changed", async () => {
  const f = fixture("desktop");
  try {
    f.render();
    await settle();
    f.hold();
    const earlier = f.render().loadEarlier();
    f.reconnect();
    await settle();
    assert.equal(f.render().messages.length, 40);
    f.finish();
    await earlier;
    assert.equal(f.render().messages.length, 40, "the old history request cannot modify the restored window");
    await f.render().loadEarlier();
    assert.equal(f.render().messages.length, 80, "history can be requested again after reconnect");
  } finally {
    f.unmount();
  }
});

test("mobile: a reconnect reads a page again whose first read failed, even when the snapshot is unchanged", async () => {
  const f = fixture("mobile", { failFirst: true });
  try {
    f.render();
    await settle();
    assert.match(f.render().error, /Read interrupted/);
    f.reconnect();
    f.render();
    await settle();
    assert.equal(f.render().messages.length, 40);
    assert.equal(f.render().error, undefined);
  } finally {
    f.unmount();
  }
});
