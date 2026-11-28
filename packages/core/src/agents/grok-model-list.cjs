const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { grokModels } = require("@milagre/shared/grok-models");
const { AcpRpc } = require("./acp-rpc.cjs");
const { grokAcp } = require("./grok-acp.cjs");
const { readConfigOptions } = require("./acp-events.cjs");

/**
 * The models Grok Build's signed-in account offers: an empty ACP session reports them in its `model` option,
 * without a prompt or tools. Null when `grok` doesn't answer (signed out, offline); the model cache asks again on its next read.
 */
async function listGrokModels({ command, args, env, clientVersion = "0.0.0", createRpc = (options) => new AcpRpc(options), timeoutMs = 25_000 }) {
  if (!command) return null;
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-grok-models-"));
  let rpc;
  try {
    const spec = grokAcp.spawn({ command, args, env: env ?? process.env });
    rpc = createRpc({ ...spec, cwd, name: "Grok Build" });
    rpc.on("request", ({ id }) => rpc.respondError(id, "Model discovery cannot run tools."));
    rpc.start();
    const deadline = Date.now() + timeoutMs;
    const request = (method, params) => rpc.request(method, params, { timeoutMs: Math.max(1, deadline - Date.now()) });
    await request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "milagre", title: "Milagre", version: clientVersion },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const session = await request("session/new", { cwd, mcpServers: [] });
    const state = {};
    readConfigOptions(session?.configOptions, state);
    return state.models?.length ? grokModels(state.models) : null;
  } catch {
    return null;
  } finally {
    try {
      await rpc?.close({ descendants: true });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }
}

module.exports = { listGrokModels };
