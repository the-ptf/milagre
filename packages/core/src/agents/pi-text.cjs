const os = require("node:os");
const { execCommand } = require("./command.cjs");
const { listPiModels } = require("./pi-profile.cjs");
const { resolvePiModel } = require("@milagre/shared/pi-models");

const MAX_BUFFER = 4 * 1024 * 1024;

const price = (model) => (Number(model.cost?.input) || 0) + (Number(model.cost?.output) || 0);

// The Chat's own hosted model when the caller names one. Otherwise a model already in memory answers in seconds
// (loading a 27B model can take a minute), and without a local model the cheapest paid hosted one answers: commit
// text and briefs don't need a large model, and free models (OpenRouter's `:free`) are rate-limited.
function textModel({ local, reported }, { hostedOnly = false, preferred } = {}) {
  const wanted = resolvePiModel(preferred);
  const named = wanted && (reported ?? []).find((model) => model.provider === wanted.provider && model.id === wanted.id);
  if (named) return { provider: named.provider, id: named.id };
  const usable = hostedOnly ? [] : (local ?? []).filter((entry) => entry.capabilities.includes("tools"));
  const nearby = usable.find((entry) => entry.loaded) ?? usable[0];
  if (nearby) return { provider: "ollama", id: nearby.name };
  const byPrice = [...(reported ?? [])].sort((a, b) => price(a) - price(b));
  const hosted = byPrice.find((model) => price(model) > 0) ?? byPrice[0];
  return hosted ? { provider: hosted.provider, id: hosted.id } : null;
}

/** One answer through `pi -p`: no tools, session, extensions or context files. */
function piTextModel({ getCommand, outputSchema, hostedOnly = false, timeoutMs = 120_000, exec = execCommand, list = listPiModels }) {
  return async ({ system, prompt, signal, model: preferred }) => {
    const resolved = await getCommand();
    const command = typeof resolved === "string" ? resolved : resolved?.command;
    signal?.throwIfAborted();
    if (!command) throw new Error("Pi isn't installed.");
    const env = (typeof resolved === "object" && resolved.env) || process.env;
    const model = textModel(await list({ command, profile: env.PI_CODING_AGENT_DIR, env }), { hostedOnly, preferred });
    if (!model) throw new Error("Pi has no model that can answer.");
    const instruction = outputSchema ? `\n\nReply with only a JSON object that matches this JSON schema:\n${JSON.stringify(outputSchema)}` : "";
    const args = [
      "-p",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-mcp",
      "--provider",
      model.provider,
      "--model",
      model.id,
      "--thinking",
      "off",
      "--system-prompt",
      `${system}${instruction}`,
      "--",
      prompt,
    ];
    return new Promise((resolve, reject) => {
      const child = exec(
        command,
        args,
        { cwd: os.tmpdir(), env, encoding: "utf8", timeout: timeoutMs, maxBuffer: MAX_BUFFER, signal },
        (error, stdout, stderr) => {
          if (error) reject(new Error(String(stderr || error.message).trim() || "Pi couldn't answer."));
          else resolve(String(stdout));
        },
      );
      child?.stdin?.end();
    });
  };
}

module.exports = { piTextModel, textModel };
