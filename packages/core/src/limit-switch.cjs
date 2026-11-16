const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");

const UNKNOWN_RESET_MS = 60 * 60 * 1000;

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function createLimitSwitch({ file, assign, scope, chats, now = Date.now }) {
  const limited = new Map();
  const key = (provider, accountId) => `${provider}:${accountId}`;

  function limitedUntil(provider, accountId) {
    const until = limited.get(key(provider, accountId));
    if (until === undefined) return undefined;
    if (until > now()) return until;
    limited.delete(key(provider, accountId));
    return undefined;
  }

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

  async function observe(chatId, event, token) {
    const limit = event.type === "turn-failed" ? event.limit : null;
    if (!limit?.accountId) return null;
    const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN;
    limited.set(key(limit.provider, limit.accountId), Number.isFinite(resetsAt) && resetsAt > now() ? resetsAt : now() + UNKNOWN_RESET_MS);
    if (!autoSwitch()) return null;
    const projectPath = projectOfKey(chatId);
    const group = (await scope(projectPath)).providers.find((item) => item.provider === limit.provider);
    if (token && !token.valid()) return { continued: false, cancelled: true };
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
