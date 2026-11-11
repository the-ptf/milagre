const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { AcpRpc } = require("./agents/acp-rpc.cjs");
const { AGENT_NAME, tokenFile, hasToken } = require("./agents/antigravity-install.cjs");
const { antigravityAcp, antigravitySpawn, isSubscriptionError, signInUrl } = require("./agents/antigravity-acp.cjs");

// Antigravity Accounts (docs/adr/0015-provider-accounts.md, docs/adr/0006-antigravity-over-acp.md). A profile is a
// GEMINI_HOME directory; Antigravity keeps its token in <home>/antigravity-acp/acp_token.json (file storage,
// never the keychain). Antigravity's ACP server reads every path from GEMINI_HOME (its paths.py):
//   <home>/config/skills, <home>/antigravity-cli/skills   user skills (read only)
//   <home>/antigravity-acp/                                settings, tokens, trusted workspaces
//   <home>/antigravity-acp/conversations, .../brain        session history and per-session artifacts

const SUBSCRIPTION_MESSAGE = "This Google account needs an eligible Antigravity subscription.";
const INITIALIZE_TIMEOUT_MS = 90_000;
// The two skill folders Antigravity reads under its home, shared from the user's ~/.gemini when present.
const SKILL_FOLDERS = [path.join("config", "skills"), path.join("antigravity-cli", "skills")];
// History that must be shared so switching Accounts can resume a Chat.
const HISTORY_FOLDERS = [path.join(AGENT_NAME, "conversations"), path.join(AGENT_NAME, "brain")];

// Errors whose message is meant for the user; anything else becomes a generic message.
const userError = (message, extra = {}) => Object.assign(new Error(message), { forUser: true }, extra);
const link = (target, at) => fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
const exists = (file) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

/**
 * Prepares a profile's shared folders. Skills are linked from the user's own ~/.gemini only when they exist
 * there; nothing is ever created or written under ~/.gemini. `history` is the profile whose conversations
 * this one shares (the default profile), or null for the default profile itself.
 */
function prepareAntigravityProfile(dir, { home = os.homedir(), history = null } = {}) {
  fs.mkdirSync(path.join(dir, AGENT_NAME), { recursive: true, mode: 0o700 });
  for (const folder of SKILL_FOLDERS) {
    const source = path.join(home, ".gemini", folder);
    const target = path.join(dir, folder);
    if (!fs.existsSync(source) || exists(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    link(source, target);
  }
  if (!history) return;
  for (const folder of HISTORY_FOLDERS) {
    const source = path.join(history, folder);
    const target = path.join(dir, folder);
    if (exists(target)) continue;
    fs.mkdirSync(source, { recursive: true, mode: 0o700 });
    link(source, target);
  }
}

// The `email` claim of an id_token JWT, when the token file has one. Only that claim leaves this function:
// the token file holds secrets and nothing else from it is ever returned or logged.
function tokenEmail(home) {
  try {
    const token = JSON.parse(fs.readFileSync(tokenFile(home), "utf8"))?.id_token;
    if (typeof token !== "string") return undefined;
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload?.email === "string" && payload.email.length <= 200 ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

/** Signed in when the profile holds a token; no process is started. Antigravity reports no plan. */
function inspectAntigravityAccount({ env }) {
  const home = env?.GEMINI_HOME;
  if (!home) return { state: "error", message: "Could not check this account. Try Refresh." };
  if (!hasToken(home)) return { state: "signed-out" };
  const email = tokenEmail(home);
  return { state: "ready", ...(email ? { email } : {}) };
}

// Google's loopback OAuth URL, redirecting to a local port, is the only link a sign-in may open.
function validSignInUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password)
      return false;
    const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
    return redirect.protocol === "http:" && redirect.hostname === "127.0.0.1" && /^\d+$/.test(redirect.port) && redirect.pathname === "/" && !redirect.search;
  } catch {
    return false;
  }
}

// The computer's default browser, without a shell: the URL is one argument.
function openInBrowser(url, { platform = process.platform, execFileImpl = execFile } = {}) {
  const [file, args] =
    platform === "darwin"
      ? ["/usr/bin/open", [url]]
      : platform === "win32"
        ? [path.join(process.env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  const child = execFileImpl(file, args, { timeout: 30_000, windowsHide: true }, () => {});
  child?.unref?.();
}

// Antigravity opens the sign-in link itself through Python's webbrowser, which honors BROWSER. Milagre opens
// the link instead, so BROWSER names a helper that does nothing. webbrowser splits BROWSER on os.pathsep, so
// the path must not contain one; a plain path to an executable (no "%s") is run as `<path> <url>`.
function noBrowserHelper(dir, platform = process.platform) {
  const file = path.join(dir, platform === "win32" ? "milagre-no-browser.cmd" : "milagre-no-browser");
  if (file.includes(platform === "win32" ? ";" : ":")) return null;
  fs.writeFileSync(file, platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  return file;
}

/**
 * Signs a profile in: starts Antigravity with the profile's environment, `initialize`, then
 * `authenticate { methodId: "oauth-personal" }`. A signed-in profile answers at once and nothing is opened;
 * otherwise the agent prints Google's sign-in link (stderr, possibly stdout), Milagre checks it and opens it
 * in the computer's browser, and `authenticate` answers once the browser's callback reached the agent.
 * Returns { done, cancel }: `done` resolves when the profile holds a token, and rejects with a message meant
 * for the user. `cancel` stops the agent; the agent and its temporary directory are always cleaned up.
 */
function signInAntigravity({
  command,
  args,
  harness,
  env,
  openUrl = openInBrowser,
  onUrl = () => {},
  spawnImpl,
  tempRoot = antigravityAcp.tempRoot,
  clientVersion = "0.1.0",
  initializeTimeoutMs = INITIALIZE_TIMEOUT_MS,
}) {
  const home = env?.GEMINI_HOME;
  if (!home) throw new Error("This account has no profile directory.");
  fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const tmpdir = fs.mkdtempSync(path.join(tempRoot, `sign-in-${process.pid}-`));
  const spec = antigravitySpawn({ command, args, harness, env, tmpdir });
  const browser = noBrowserHelper(home);
  if (browser) spec.env.BROWSER = browser;
  let fail;
  const failed = new Promise((_, reject) => {
    fail = reject;
  });
  failed.catch(() => {});
  let opened = false;
  const rpc = new AcpRpc({
    command: spec.command,
    args: spec.args,
    cwd: tmpdir,
    env: spec.env,
    name: "Antigravity",
    ...(spawnImpl ? { spawnImpl } : {}),
    onLine(line) {
      const url = signInUrl(line);
      if (!url || opened) return;
      if (!validSignInUrl(url)) {
        fail(userError("Antigravity printed an unexpected sign-in link, so it was not opened."));
        return;
      }
      opened = true;
      onUrl(url);
      openUrl(url);
    },
  });
  let cancelled = false;
  const run = async () => {
    rpc.start();
    await rpc.request(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: { name: "milagre", title: "Milagre", version: clientVersion },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
      { timeoutMs: initializeTimeoutMs },
    );
    // No timeout here: the account manager's five-minute sign-in limit cancels the whole flow.
    await rpc.request("authenticate", { methodId: "oauth-personal" }, { timeoutMs: 0 });
    if (!hasToken(home)) throw userError("Sign-in did not finish. Try again.");
  };
  const done = Promise.race([run(), failed])
    .catch((error) => {
      if (cancelled) throw userError("Sign-in cancelled.", { cancelled: true });
      if (isSubscriptionError(error)) throw userError(SUBSCRIPTION_MESSAGE, { subscription: true });
      // Never forward the agent's own output: it may quote the link or local paths.
      throw error?.forUser ? error : userError("Sign-in did not finish. Try again.");
    })
    .finally(async () => {
      await Promise.resolve(rpc.child ? rpc.close() : undefined).catch(() => {});
      fs.rmSync(tmpdir, { recursive: true, force: true });
    });
  return {
    done,
    cancel() {
      cancelled = true;
      fail(new Error("cancelled"));
    },
  };
}

module.exports = { SUBSCRIPTION_MESSAGE, inspectAntigravityAccount, openInBrowser, prepareAntigravityProfile, signInAntigravity, tokenEmail, validSignInUrl };
