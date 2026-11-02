const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");

// An account that hit its limit with no reset time stays out of auto-switch choices this long.
const UNKNOWN_RESET_MS = 60 * 60 * 1000;

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Accounts that hit their plan's usage limit, and the move to another one: from the limit card in a Chat, or by
 * itself when auto-switch is on (Settings › Accounts, kept in `file`). A switch assigns the account to the
 * Chat's Project (or Link) with `assign`, then continues the Chat on it.
 * `scope(key)` is the Project's account choices (accounts.scope); `chats` is the ChatHost.
 */
function createLimitSwitch({ file, assign, scope, chats, now = Date.now }) {
  // `${provider}:${accountId}` -> the time, in ms, the account can be used again.
  const limited = new Map();
  const key = (provider, accountId) => `${provider}:${accountId}`;

  function limitedUntil(provider, accountId) {
    const until = limited.get(key(provider, accountId));
    if (until === undefined) return undefined;
    if (until > now()) return until;
    limited.delete(key(provider, accountId));
    return undefined;
  }

  /** The Project's account choices, each limited account marked with the time it resets. */
  function decorate(snapshot) {
    return {
      ...snapshot,
      providers: snapshot.providers.map((group) => ({
        ...group,
        accounts: group.accounts.map((account) => {
          const until = limitedUntil(group.provider, account.id);
          return until === undefined ? account : { ...account, limitedUntil: new Date(until).toISOString() };
        }),
      })),
    };
  }

  /** Moves the Chat's Project to `accountId` for `provider`, then continues the Chat on it. */
  async function switchTo(projectPath, sessionId, provider, accountId, token) {
    if (token && !token.valid()) return { continued: false, label: "another account" };
    const snapshot = await assign(
      projectPath,
      provider,
      accountId,
      token ? { canAssign: token.valid, preserveChat: `${projectPath}#${sessionId}` } : undefined,
    );
    if (!snapshot) return { continued: false, label: "another account" };
    const account = snapshot.providers.find((group) => group.provider === provider)?.accounts.find((item) => item.id === accountId);
    const label = account?.email || account?.label || "another account";
    const continued = (!token || token.valid()) && (await chats.continueAfterLimit(projectPath, Number(sessionId), provider, label, token));
    return { continued, label };
  }

  /** A turn the limit stopped: remember the account, and with auto-switch on, move the Chat to the next ready one. */
  async function observe(chatId, event, token) {
    const limit = event.type === "turn-failed" ? event.limit : null;
    if (!limit?.accountId) return null;
    const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN;
    limited.set(key(limit.provider, limit.accountId), Number.isFinite(resetsAt) && resetsAt > now() ? resetsAt : now() + UNKNOWN_RESET_MS);
    if (!autoSwitch()) return null;
    const projectPath = projectOfKey(chatId);
    const group = (await scope(projectPath)).providers.find((item) => item.provider === limit.provider);
    if (token && !token.valid()) return { continued: false, cancelled: true };
    // Someone already moved the Project to another account.
    if (!group || group.effectiveId !== limit.accountId) return null;
    const next = group.accounts.find(
      (account) => account.id !== limit.accountId && account.state === "ready" && !account.missing && !limitedUntil(limit.provider, account.id),
    );
    return next ? switchTo(projectPath, sessionIdFromKey(chatId), limit.provider, next.id, token) : null;
  }

  function autoSwitch() {
    return read(file)?.autoSwitch === true;
  }
  function setAutoSwitch(value) {
    return saveSetting("autoSwitch", value);
  }
  function resumeAtReset() {
    return read(file)?.resumeAtReset !== false;
  }
  function setResumeAtReset(value) {
    return saveSetting("resumeAtReset", value);
  }
  function saveSetting(name, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ ...read(file), [name]: value === true }));
    fs.renameSync(temp, file);
    return value === true;
  }

  return { limitedUntil, decorate, switchTo, observe, autoSwitch, setAutoSwitch, resumeAtReset, setResumeAtReset };
}

module.exports = { createLimitSwitch, UNKNOWN_RESET_MS };
