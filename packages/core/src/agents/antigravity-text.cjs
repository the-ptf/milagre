const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AcpRpc } = require("./acp-rpc.cjs");
const { antigravityAcp, makeTempDir } = require("./antigravity-acp.cjs");
const { loginMessage } = require("./events.cjs");
const { pickOption } = require("./acp-session.cjs");
const { readConfigOptions } = require("./acp-events.cjs");
const { ANTIGRAVITY_TEXT_FAMILY } = require("@milagre/shared/antigravity-models");

// One-shot text generation through the Antigravity agent (docs/adr/0006-antigravity-over-acp.md), for the calls the
// user never sees: chat titles, commit text, handover briefs. A fresh agent process in an empty temporary
// folder, no tools (mcpServers: []), a fast model, every permission request turned down; the JSON is
// taken from the reply text.

// Gemini 3.8 Flash at Low, resolved to the agent's id from what the session offers (else the catalog's).
const ANTIGRAVITY_TEXT_MODEL = ANTIGRAVITY_TEXT_FAMILY.model;
const ANTIGRAVITY_TEXT_EFFORT = ANTIGRAVITY_TEXT_FAMILY.effort;
const INITIALIZE_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const PROMPT_TIMEOUT_MS = 90_000;

/** The JSON object in a reply (plain or fenced), as text; the whole reply when there is none. */
function extractJson(reply) {
  const text = String(reply ?? "").trim();
  const candidates = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) candidates.push(fenced[1].trim());
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {}
  }
  return text;
}

const refusal = (options) => {
  const option = pickOption(Array.isArray(options) ? options : [], "deny");
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
};

function antigravityModel({
  getCommand,
  outputSchema,
  model = ANTIGRAVITY_TEXT_MODEL,
  effort = ANTIGRAVITY_TEXT_EFFORT,
  config = antigravityAcp,
  createRpc = (options) => new AcpRpc(options),
  clientVersion = "0.0.0",
  timeoutMs = PROMPT_TIMEOUT_MS,
}) {
  return async ({ system, prompt, signal }) => {
    const resolved = await getCommand();
    const command = typeof resolved === "string" ? resolved : resolved?.command;
    signal?.throwIfAborted();
    if (!command) throw new Error(`${config.name} isn't installed.`);
    const root = config.tempRoot;
    let tmpdir = null;
    let cwd = null;
    let rpc = null;
    let sessionId = null;
    const abort = () => void rpc?.close();
    try {
      if (root) tmpdir = await makeTempDir(root, "text");
      cwd = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-antigravity-text-"));
      signal?.throwIfAborted();
      const spawn = config.spawn({
        command,
        args: typeof resolved === "object" ? resolved.args : undefined,
        harness: typeof resolved === "object" ? resolved.harness : undefined,
        env: (typeof resolved === "object" && resolved.env) || process.env,
        tmpdir,
      });
      rpc = createRpc({ command: spawn.command, args: spawn.args, cwd, env: spawn.env, name: config.name });
      let text = "";
      const exited = new Promise((_resolve, reject) => rpc.on("exit", ({ detail } = {}) => reject(new Error(detail || `${config.name} stopped.`))));
      exited.catch(() => {});
      rpc.on("notification", ({ method, params = {} }) => {
        const update = params.update ?? {};
        if (method === "session/update" && update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") text += update.content.text ?? "";
      });
      rpc.on("request", ({ id, method, params }) => {
        try {
          if (method === "session/request_permission") rpc.respond(id, refusal(params?.options));
          else rpc.respondError(id, "Milagre doesn't answer requests in this call.");
        } catch {}
      });
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      rpc.start();
      const run = async () => {
        await rpc.request(
          "initialize",
          {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: "milagre", title: "Milagre", version: clientVersion },
          },
          { timeoutMs: INITIALIZE_TIMEOUT_MS },
        );
        const session = await rpc.request("session/new", { cwd, mcpServers: [] }, { timeoutMs: REQUEST_TIMEOUT_MS });
        sessionId = session?.sessionId;
        const offered = {};
        readConfigOptions(session?.configOptions, offered);
        const value = config.resolveModel ? config.resolveModel({ model, effort, offered: offered.models }) : model;
        try {
          await rpc.request("session/set_config_option", { sessionId, configId: "model", value }, { timeoutMs: REQUEST_TIMEOUT_MS });
        } catch (error) {
          // A model this agent doesn't offer: the session's own model answers instead.
          if (!error.rpcError) throw error;
        }
        const instruction = outputSchema
          ? `Reply with only a JSON object that matches this JSON schema, with no other text and no code fence:\n${JSON.stringify(outputSchema)}`
          : "Reply with only the JSON object asked for, with no other text and no code fence.";
        const blocks = [{ type: "text", text: `${system}\n\n${prompt}\n\n${instruction}\nDo not use any tools.` }];
        await rpc.request("session/prompt", { sessionId, prompt: blocks }, { timeoutMs });
        return extractJson(text);
      };
      return await Promise.race([run(), exited]);
    } catch (error) {
      if (config.isLoginError(error)) throw new Error(loginMessage(config.provider), { cause: error });
      if (signal?.aborted) throw signal.reason ?? new Error(`${config.name} stopped.`);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      // An agent that keeps every session (Kiro) gets this throwaway one deleted, so its history holds only Chats.
      if (config.deleteThrowawaySessions && sessionId && !signal?.aborted)
        await rpc?.request("session/delete", { sessionId }, { timeoutMs: 5_000 }).catch(() => {});
      await rpc?.close();
      if (tmpdir) await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {});
      if (cwd) await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  };
}

module.exports = { ANTIGRAVITY_TEXT_EFFORT, ANTIGRAVITY_TEXT_MODEL, extractJson, antigravityModel };
