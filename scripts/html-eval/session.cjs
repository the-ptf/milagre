// Real provider session. Generated evidence belongs outside the checkout.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const WORKTREE = path.resolve(__dirname, "../..");
const { createLocalMcpServer } = require("../../packages/core/src/local-mcp-server.cjs");
const { htmlRenderToolDefinitions } = require("../../packages/core/src/html-render.cjs");
const { createChatArtifacts } = require("../../packages/core/src/chat-artifacts.cjs");
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const iso = () => new Date().toISOString();
const SYSTEM_PROMPT = "Responda em português. Visuais inline: use html_preview para conferir, depois html_render para publicar.";

async function runSession({ root, caseSpec, iteration, model, cli, systemPrompt, timeoutMs, maxBudget }) {
  const sessionId = `${caseSpec.id}-r${iteration}`;
  const dir = path.join(root, "sessions", sessionId);
  fs.mkdirSync(dir); // Never overwrite a previous session.
  const cwd = path.join(dir, "cwd"),
    callsDir = path.join(dir, "calls");
  for (const d of [cwd, callsDir]) fs.mkdirSync(d);
  const chatId = `${dir}#1`,
    calls = [],
    events = [];
  let seq = 0,
    result,
    child,
    server,
    timer,
    killTimer,
    timedOut = false,
    spawnError;
  const token = crypto.randomBytes(32).toString("hex");
  const redact = (s) => String(s).replaceAll(token, "<redacted>");
  const configFile = path.join(root, "private", `${sessionId}.mcp.json`);
  const artifacts = createChatArtifacts({
    directory: path.join(dir, "artifacts-store"),
    validateChat: async (id) => {
      if (id !== chatId) throw Error("An existing Chat is required.");
    },
  });
  const meta = {
    sessionId,
    caseId: caseSpec.id,
    repeat: iteration,
    chatId,
    model,
    cli,
    cwd,
    prompt: caseSpec.prompt,
    systemPrompt,
    worktree: WORKTREE,
    startedAt: iso(),
  };
  writeJson(path.join(dir, "session.json"), meta);
  // Preserve the actual tool definition while wrapping only its execution for evidence.
  // oxlint-disable-next-line no-map-spread
  const definitions = htmlRenderToolDefinitions(chatId, artifacts).map((def) => ({
    ...def,
    run: async (args) => {
      const number = ++seq,
        base = path.join(callsDir, `${String(number).padStart(3, "0")}-${def.name}`);
      const record = {
        seq: number,
        tool: def.name,
        startedAt: iso(),
        input: { ...args, html: undefined },
        htmlFile: `${base}.html`,
        htmlChars: (args.html || "").length,
        htmlSha256: sha(args.html || ""),
      };
      fs.writeFileSync(record.htmlFile, args.html || "");
      writeJson(`${base}.input.json`, args);
      try {
        const output = await def.run(args);
        const text = typeof output === "object" && output !== null && "text" in output ? output.text : String(output);
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* Plain tool text. */
        }
        const images = (output?.images || []).map((img, i) => {
          const buf = Buffer.from(img.base64, "base64"),
            file = `${base}${i ? `-${i}` : ""}.png`;
          fs.writeFileSync(file, buf);
          return { file, mime: img.mime, bytes: buf.length, sha256: sha(buf) };
        });
        record.output = { text, parsed, images };
        record.isError = false;
        return output;
      } catch (error) {
        record.isError = true;
        record.error = redact(error.message);
        throw error;
      } finally {
        record.finishedAt = iso();
        calls.push(record);
        calls.sort((a, b) => a.seq - b.seq);
        writeJson(`${base}.output.json`, record.output || { error: record.error });
        writeJson(path.join(dir, "calls.json"), calls);
      }
    },
  }));
  function scrub(value) {
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          k === "data" && typeof v === "string" && value.type === "base64" ? `<image omitted sha256=${sha(v)}>` : scrub(v),
        ]),
      );
    return typeof value === "string" ? redact(value) : value;
  }
  let exit = { code: null, signal: null };
  try {
    server = createLocalMcpServer({
      authenticate: (candidate) =>
        typeof candidate === "string" &&
        Buffer.byteLength(candidate) === Buffer.byteLength(token) &&
        crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(token))
          ? { id: sessionId, revision: 1, tools: () => definitions }
          : undefined,
      toolsFor: () => [],
    });
    const endpoint = await server.listen(0);
    fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { milagre: { type: "http", url: endpoint, headers: { Authorization: `Bearer ${token}` } } } }), {
      mode: 0o600,
      flag: "wx",
    });
    const args = [
      "-p",
      caseSpec.prompt,
      "--model",
      model,
      "--system-prompt",
      systemPrompt,
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      configFile,
      "--allowedTools",
      "mcp__milagre__html_preview,mcp__milagre__html_render",
      "--permission-mode",
      "dontAsk",
      "--disable-slash-commands",
      "--setting-sources",
      "local",
      "--no-session-persistence",
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-budget-usd",
      String(maxBudget),
    ];
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK|ANTHROPIC_)/.test(key) && key !== "CLAUDE_CONFIG_DIR") delete env[key];
    Object.assign(env, { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1" });
    child = spawn(cli, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "",
      stderr = "";
    const consume = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = scrub(JSON.parse(line));
      } catch {
        event = { unparsed: redact(line.slice(0, 2000)) };
      }
      event.receivedAt = iso();
      events.push(event);
      fs.appendFileSync(path.join(dir, "transcript.jsonl"), JSON.stringify(event) + "\n");
      if (event.type === "result") result = event;
    };
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let i;
      while ((i = buffer.indexOf("\n")) !== -1) {
        consume(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
    }, timeoutMs);
    exit = await new Promise((resolve) => {
      child.on("error", (error) => {
        spawnError = redact(error.message);
      });
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    consume(buffer);
    fs.writeFileSync(path.join(dir, "cli-stderr.log"), redact(stderr));
  } catch (error) {
    spawnError = redact(error.message);
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    child?.kill("SIGTERM");
    await server?.close();
    await artifacts.close();
    fs.rmSync(configFile, { force: true });
  }
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  const responseModels = [
    ...new Set(
      events
        .filter((e) => e.type === "assistant")
        .map((e) => e.message?.model)
        .filter(Boolean),
    ),
  ];
  const finalText = events
    .filter((e) => e.type === "assistant")
    .flatMap((e) => (e.message?.content || []).filter((c) => c.type === "text").map((c) => c.text))
    .join("\n\n");
  const final = calls.findLast((c) => c.tool === "html_render" && !c.isError);
  if (final) fs.copyFileSync(final.htmlFile, path.join(dir, "final.html"));
  const record = {
    ...meta,
    finishedAt: iso(),
    exit,
    timedOut,
    error: spawnError,
    init,
    responseModels,
    result,
    finalText,
    wrapperCalls: calls.length,
    finalHtml: final ? path.join(dir, "final.html") : null,
    finalHtmlSha256: final?.htmlSha256,
    status: !timedOut && !spawnError && exit.code === 0 && result && !result.is_error && final ? "completed" : "failed",
  };
  writeJson(path.join(dir, "session.json"), record);
  fs.writeFileSync(path.join(dir, "final-reply.md"), finalText + "\n");
  return {
    sessionId,
    caseId: caseSpec.id,
    repeat: iteration,
    status: record.status,
    timedOut,
    error: spawnError,
    exit,
    calls: calls.length,
    finalHtml: record.finalHtml,
    costUsd: result?.total_cost_usd ?? null,
    durationMs: result?.duration_ms ?? null,
    responseModels,
    sessionFile: path.join(dir, "session.json"),
  };
}
module.exports = { runSession, SYSTEM_PROMPT, sha, writeJson, WORKTREE };
