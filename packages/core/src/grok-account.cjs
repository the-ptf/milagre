const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Grok's account is the one `grok login` signed in to (docs/providers.md). Grok Build keeps its session token in
// `auth.json` under its home (`GROK_HOME`, else `~/.grok`) and falls back to `XAI_API_KEY`, so checking sends no
// request and starts no process, and never reads the token.

const grokHome = (env = process.env) => env.GROK_HOME || path.join(os.homedir(), ".grok");

function signedIn(env = process.env, { stat = fs.statSync } = {}) {
  if (typeof env.XAI_API_KEY === "string" && env.XAI_API_KEY.trim()) return true;
  try {
    const file = stat(path.join(grokHome(env), "auth.json"));
    return file.isFile() && file.size > 0;
  } catch {
    return false;
  }
}

function inspectGrokAccount({ env = process.env, stat } = {}) {
  if (signedIn(env, { stat })) return { state: "ready" };
  return { state: "signed-out", message: "Run `grok login` in a terminal to sign in." };
}

async function grokLoggedOut(_command, { env } = {}) {
  return !signedIn(env ?? process.env);
}

module.exports = { grokHome, grokLoggedOut, inspectGrokAccount };
