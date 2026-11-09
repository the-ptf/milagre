const fs = require("node:fs/promises");
const { AcpRpc } = require("./acp-rpc.cjs");
const { antigravityAcp, makeTempDir } = require("./antigravity-acp.cjs");
const { readConfigOptions } = require("./acp-events.cjs");

/** An empty ACP session exposes this account's models without a prompt, tools or authentication request. */
async function queryAntigravityModels({
  command,
  args,
  harness,
  env,
  clientVersion = "0.0.0",
  createRpc = (options) => new AcpRpc(options),
  timeoutMs = 25_000,
}) {
  const tmpdir = await makeTempDir(antigravityAcp.tempRoot, "models");
  let rpc;
  try {
    const spec = antigravityAcp.spawn({ command, args, harness, env, tmpdir });
    rpc = createRpc({ ...spec, cwd: tmpdir, name: "Antigravity" });
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
    const session = await request("session/new", { cwd: tmpdir, mcpServers: [] });
    const state = {};
    readConfigOptions(session?.configOptions, state);
    return { offered: state.models, current: state.model };
  } finally {
    try {
      await rpc?.close({ descendants: true });
    } finally {
      await fs.rm(tmpdir, { recursive: true, force: true });
    }
  }
}

module.exports = { queryAntigravityModels };
