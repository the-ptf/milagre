const os = require("node:os");
const { execCommand } = require("./command.cjs");
const { readOllamaModels, writePiModels } = require("./ollama.cjs");

const MAX_BUFFER = 4 * 1024 * 1024;

// A model already in memory answers in seconds; loading a 27B model can take a minute.
function textModel(entries) {
  const usable = entries.filter((entry) => entry.capabilities.includes("tools"));
  return (usable.find((entry) => entry.loaded) ?? usable[0])?.name ?? null;
}

/** One answer from a local model through `pi -p`: no tools, session, extensions or context files. */
function piTextModel({ getCommand, outputSchema, timeoutMs = 120_000, exec = execCommand }) {
  return async ({ system, prompt, signal }) => {
    const resolved = await getCommand();
    const command = typeof resolved === "string" ? resolved : resolved?.command;
    signal?.throwIfAborted();
    if (!command) throw new Error("Pi isn't installed.");
    const env = (typeof resolved === "object" && resolved.env) || process.env;
    const entries = await readOllamaModels({ env });
    await writePiModels(env.PI_CODING_AGENT_DIR, entries, env);
    const model = textModel(entries);
    if (!model) throw new Error("Ollama has no model that can answer.");
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
      "ollama",
      "--model",
      model,
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

module.exports = { piTextModel };
