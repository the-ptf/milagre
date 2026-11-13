#!/usr/bin/env node
// Records Node's answers for a *copy* of a real Project, for the Rust `live_copy_matches_node` test.
//
//   node experiments/rust-owner/fixtures/node-cases.cjs <copied-project> <cases.json>
//   MILAGRE_OWNER_COPY=<copied-project> MILAGRE_OWNER_CASES=<cases.json> cargo test -- --ignored live_copy
//
// Node's reads write (CREATE TABLE IF NOT EXISTS, mkdir of content folders, detail compaction sidecars), so this runs
// them on a second throwaway copy and leaves <copied-project> as it was. Never point it at a Project in use.

const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repo = path.resolve(__dirname, "../../..");
// oxlint-disable-next-line no-underscore-dangle -- the one hook that maps a workspace package without node_modules
const resolve = Module._resolveFilename;
// oxlint-disable-next-line no-underscore-dangle
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@milagre/shared/")) return path.join(repo, "packages/shared/src", `${request.slice("@milagre/shared/".length)}.mjs`);
  return resolve.call(this, request, ...rest);
};
const core = (name) => require(path.join(repo, "packages/core/src", name));
const chatDb = core("chat-db.cjs");
const { readProjectState } = core("project-store.cjs");
const { ProjectStates } = core("project-states.cjs");
const { chatPage } = core("chat-pages.cjs");
const { withDetails } = core("project-content.cjs");

async function main() {
  const [source, output] = process.argv.slice(2);
  if (!source || !output) throw new Error("usage: node-cases.cjs <copied-project> <cases.json>");
  if (fs.existsSync(path.join(source, ".milagre", "runtime.lock"))) throw new Error(`${source} has a runtime.lock: copy the Project without it.`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-owner-node-"));
  fs.cpSync(source, dir, { recursive: true });
  try {
    const cases = [];
    const add = (kind, args, value) =>
      cases.push({
        kind,
        args,
        node: JSON.stringify(value === undefined ? null : value)
          .split(dir)
          .join("<project>"),
      });
    const state = await readProjectState(dir);
    add("state", [], state);
    const states = new ProjectStates({ read: readProjectState, save: async () => {}, messages: { directory: (key) => key } });
    const sessions = Object.values(state.sessions).map((session) => session.id);
    for (const chat of sessions) {
      add(
        "chat:messages",
        [chat, {}],
        chatPage(
          chatDb.readChatRows(dir, [chat]).map((row) => row.message),
          chat,
          {},
        ),
      );
      add(
        "chat:messages",
        [chat, { turns: 2, limit: 5 }],
        chatPage(
          chatDb.readChatRows(dir, [chat]).map((row) => row.message),
          chat,
          { turns: 2, limit: 5 },
        ),
      );
    }
    add("previews", [sessions], chatDb.readChatPreviews(dir, sessions));
    const withClient = state.messages.filter((message) => message.clientMessageId).slice(-60);
    const queued = Object.values(state.sessions)
      .flatMap((session) => (session.queued ?? []).map((entry) => entry.clientMessageId))
      .filter(Boolean);
    for (const clientMessageId of [...withClient.map((message) => message.clientMessageId), ...queued, "no-such-client-id"]) {
      const message = await states.findMessage(dir, "clientMessageId", clientMessageId);
      let receipt = message ? { sessionId: message.session_id } : null;
      if (!receipt) {
        const current = await states.get(dir);
        const found = Object.values(current.sessions).find((session) => session.queued?.some((entry) => entry.clientMessageId === clientMessageId));
        receipt = found ? { sessionId: found.id } : null;
      }
      add("chat:send-status", [clientMessageId], receipt);
    }
    const withDetailIds = state.messages
      .filter((message) => message.detailFile)
      .slice(-60)
      .map((message) => message.id);
    for (const id of [...withDetailIds, ...state.messages.slice(-20).map((message) => message.id)]) {
      const message = await states.findMessage(dir, "id", id);
      add("chat:message", [id], await withDetails(dir, message));
    }
    await states.close();
    fs.writeFileSync(output, JSON.stringify({ node: process.version, cases }));
    console.log(`${cases.length} cases written to ${output}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
