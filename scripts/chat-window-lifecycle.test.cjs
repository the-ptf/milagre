// Simulated hook tests for paging races. Real commit ordering is covered by test-chat-subscription-handoff.cjs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { setImmediate: settle } = require("node:timers/promises");

function fixture(platform) {
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
  let held,
    hold = false,
    requests = 0;
  const read = async (_scope, _id, options) => {
    requests++;
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
      if (id === "./computer-bridge.ts") return { bridgeForKey: () => ({ readChatMessages: read }) };
      if (id === "./state-events.ts") return { stateEvents: { onMessages() {} } };
      return require(id);
    },
  });
  const render = () => {
    cursor = 0;
    const page = platform === "desktop" ? exports.useChatMessages("/p", 1) : exports.useChatPage(client, "/p", 1);
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
    hold: () => {
      hold = true;
    },
    finish: () => {
      hold = false;
      held();
    },
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
