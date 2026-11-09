const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { kiroModels } = require("@milagre/shared/kiro-models");
const { AcpRpc } = require("./acp-rpc.cjs");
const { kiroAcp } = require("./kiro-acp.cjs");
const { readConfigOptions } = require("./acp-events.cjs");

/**
 * The models kiro-cli's signed-in account offers, with their credit multipliers and efforts: an empty ACP session
 * reports them in its `model` option, without a prompt or tools. Kiro keeps its sessions, so this one is deleted.
 * Null when kiro-cli doesn't answer (signed out, offline); the model cache asks again on its next read.
 */
async function listKiroModels({ command, args, env, clientVersion = "0.0.0", createRpc = (options) => new AcpRpc(options), timeoutMs = 25_000 }) {
  if (!command) return null;
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-kiro-models-"));
  let rpc;
  try {
    const spec = kiroAcp.spawn({ command, args, env: env ?? process.env });
    rpc = createRpc({ ...spec, cwd, name: "Kiro CLI" });
    rpc.on("request", ({ id }) => rpc.respondError(id, "Model discovery cannot run tools."));
    rpc.start();
    // Keep the whole lookup below the desktop/phone bridge's 30-second deadline.
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
    if (typeof session?.sessionId === "string") await request("session/delete", { sessionId: session.sessionId }).catch(() => {});
    return state.models?.length ? kiroModels(state.models) : null;
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

module.exports = { listKiroModels };
