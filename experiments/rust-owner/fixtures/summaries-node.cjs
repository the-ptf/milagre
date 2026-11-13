// Node's real withChatSummaries (packages/core/src/chat-summaries.cjs) over sequences of changes, each made the way
// ProjectStates makes them (new arrays and objects, unchanged messages and sessions kept as the same objects), for
// tests/chat_summaries.rs to compare with the Rust port step by step. Usage: node summaries-node.cjs '<cases JSON>'.
// A case: { seed: state, unloaded: [chat ids], steps: [{ at, ops: [...] }] }. The seed is read as from disk (no
// previous); then each step's ops make `next` from the last state and withChatSummaries(next, last, () => at) runs.
// Ops: append [messages], remove [ids], replace { id, message }, session { id, value } (a new session object, or
// removed with value null), copySessions (an equal new sessions object), unload [chat ids] (their messages leave the
// array and the Chats are tagged unloaded).
"use strict";
const Module = require("node:module");
const path = require("node:path");
const repo = path.resolve(__dirname, "../../..");
// oxlint-disable-next-line no-underscore-dangle -- maps the workspace package without node_modules, as chat-node.cjs
const resolve = Module._resolveFilename;
// oxlint-disable-next-line no-underscore-dangle
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@milagre/shared/")) return path.join(repo, "packages/shared/src", `${request.slice("@milagre/shared/".length)}.mjs`);
  return resolve.call(this, request, ...rest);
};
const { withChatSummaries } = require(path.join(repo, "packages/core/src/chat-summaries.cjs"));
const messageStore = require(path.join(repo, "packages/core/src/message-store.cjs"));

const cases = JSON.parse(process.argv[2]);
const out = cases.map(({ seed, unloaded = [], steps }) => {
  let gone = new Set(unloaded);
  const tagged = (messages) => messageStore.tag(messages, "/nowhere", gone);
  let state = withChatSummaries({ ...seed, messages: tagged([...seed.messages]) }, null, () => 0);
  const results = [state.sessions];
  for (const { at, ops } of steps) {
    // A new state object for the step; each op replaces only what it changes (the rest stays the same objects).
    const next = { ...state };
    for (const op of ops) {
      if (op.append) next.messages = next.messages.concat(op.append);
      if (op.remove) next.messages = next.messages.filter((message) => !op.remove.includes(message.id));
      if (op.replace) next.messages = next.messages.map((message) => (message.id === op.replace.id ? op.replace.message : message));
      if (op.session) {
        const sessions = Object.assign({}, next.sessions);
        if (op.session.value === null) delete sessions[op.session.id];
        else sessions[op.session.id] = op.session.value;
        next.sessions = sessions;
      }
      if (op.copySessions) next.sessions = Object.assign({}, next.sessions);
      if (op.unload) {
        gone = new Set(gone);
        for (const chat of op.unload) gone.add(chat);
        next.messages = next.messages.filter((message) => !op.unload.includes(message.session_id));
      }
    }
    if (next.messages !== state.messages) tagged(next.messages);
    state = withChatSummaries(next, state, () => at);
    results.push(state.sessions);
  }
  return results;
});
process.stdout.write(JSON.stringify(out));
