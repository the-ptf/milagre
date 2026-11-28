const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

const COMMAND = "milagre-secrets";
const MAX_NAMES = 50;

function shimText(execPath, script, platform) {
  if (platform === "win32") return `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${execPath}" "${script}" %*\r\n`;
  const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(execPath)} ${quote(script)} "$@"\n`;
}

/**
 * How an agent reaches its Chat's secrets: a `milagre-secrets` command on its PATH that calls back to this host with a
 * per-Chat token, plus the ambient secrets it opted into. `target(chatId)` says which Project origin and whether the
 * run is unattended; the vault decides what reaches it.
 */
function createSecretsAccess({
  vault,
  dataDir,
  secretsUrl,
  target,
  redactText = (text) => text,
  approve = async () => false,
  execPath = process.execPath,
  platform = process.platform,
}) {
  const bin = path.join(dataDir, "secrets-bin");
  const script = path.join(__dirname, "secrets-run.cjs");
  const tokens = new Map();
  const chatTokens = new Map();
  const ambientLogged = new Set();
  let installed = false;

  function install() {
    if (installed) return;
    fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
    const file = path.join(bin, platform === "win32" ? `${COMMAND}.cmd` : COMMAND);
    const text = shimText(execPath, script, platform);
    let current = null;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch {}
    if (current !== text) {
      const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
      fs.writeFileSync(temporary, text, { mode: 0o700 });
      fs.renameSync(temporary, file);
    }
    installed = true;
  }

  function tokenFor(chatId) {
    if (!chatTokens.has(chatId)) {
      const token = randomBytes(24).toString("hex");
      chatTokens.set(chatId, token);
      tokens.set(token, chatId);
    }
    return chatTokens.get(chatId);
  }

  async function agentEnv(chatId, env = process.env) {
    const next = { ...env };
    try {
      install();
      const key = Object.keys(next).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
      next[key] = [bin, next[key]].filter(Boolean).join(path.delimiter);
      next.MILAGRE_SECRETS_URL = await secretsUrl(tokenFor(chatId));
    } catch (error) {
      console.warn("Secrets command unavailable:", error.message);
      return next;
    }
    if (!(await vault.status()).unlocked) return next;
    try {
      const { fingerprint, secrets } = await vault.ambient({ target: await target(chatId), chatId, record: !ambientLogged.has(chatId) });
      next.MILAGRE_SECRETS_AMBIENT = fingerprint;
      if (secrets.length) ambientLogged.add(chatId);
      for (const secret of secrets) next[secret.name] = secret.value;
    } catch (error) {
      console.warn("Ambient secrets unavailable:", error.message);
    }
    return next;
  }

  async function request(token, body) {
    const chatId = tokens.get(token);
    if (!chatId) throw Object.assign(new Error("This Chat's secrets address is no longer valid. Start a new turn."), { status: 401 });
    if (!(await vault.status()).unlocked) throw Object.assign(new Error("Secrets are locked on this computer."), { status: 423 });
    const where = await target(chatId);
    if (body?.action === "list") return vault.reachable(where);
    if (body?.action !== "run") throw Object.assign(new Error("Unknown action."), { status: 400 });
    const names = Array.isArray(body.names) ? [...new Set(body.names.filter((name) => typeof name === "string"))] : [];
    if (!names.length) throw Object.assign(new Error("Name at least one secret."), { status: 400 });
    if (names.length > MAX_NAMES) throw Object.assign(new Error(`At most ${MAX_NAMES} secrets per command.`), { status: 400 });
    const command = typeof body.command === "string" ? redactText(body.command) : null;
    const asking = (await vault.reachable(where)).secrets.filter((secret) => secret.askEachUse && names.includes(secret.name)).map((secret) => secret.name);
    if (asking.length && !(await approve(chatId, { names: asking, command })))
      throw Object.assign(new Error(`The person didn't allow ${asking.join(", ")} for this command.`), { status: 403 });
    try {
      const executable = typeof body.executable === "string" ? body.executable : (command?.trim().split(/\s+/)[0] ?? null);
      return { secrets: await vault.deliver({ names, target: where, chatId, command: executable, delivery: "on-demand" }) };
    } catch (error) {
      throw Object.assign(error, { status: error.code === "secrets-missing" ? 404 : 500 });
    }
  }

  function forget(chatId) {
    tokens.delete(chatTokens.get(chatId));
    chatTokens.delete(chatId);
    ambientLogged.delete(chatId);
  }

  return { agentEnv, request, forget, tokens: () => [...tokens.keys()], binDir: bin };
}

module.exports = { createSecretsAccess, COMMAND };
