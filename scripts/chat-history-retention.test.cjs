const test = require("node:test");
const { execFileSync } = require("node:child_process");

test("obsolete expanded windows and history projections are collected while a recent Chat stays cached", () => {
  execFileSync(
    process.execPath,
    [
      "--expose-gc",
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { setImmediate } from 'node:timers/promises';
    import { ChatWindowCache } from '@milagre/shared/chat-window-cache';
    import { chatHistory } from '@milagre/shared/chat-history';
    const cache = new ChatWindowCache({ maxChats: 8, maxBytes: 8*1024*1024, turns: 20 });
    function visit(index) {
      const messages = Array.from({ length: 1000 }, (_, id) => ({ id, session_id: index, role: id%2 ? 'assistant' : 'user', body: 'Message '+id, context: null }));
      const projection = chatHistory(messages);
      const refs = [new WeakRef(messages), new WeakRef(projection)];
      const key = 'chat-'+index;
      cache.retain(key);
      cache.set(key, { messages, hasMore: false, total: 1000 });
      cache.release(key);
      return refs;
    }
    const refs = Array.from({ length: 30 }, (_, i) => visit(i)).flat();
    for(let i=0;i<4;i++) { await setImmediate(); global.gc(); }
    assert.equal(refs.filter(ref => ref.deref()).length, 0, 'old expanded arrays/projections must not stay alive');
    assert.equal(cache.get('chat-29').messages.length, 40);
    assert.equal([...cache].length, 8);
  `,
    ],
    { cwd: require("node:path").resolve(__dirname, ".."), stdio: "pipe" },
  );
});
