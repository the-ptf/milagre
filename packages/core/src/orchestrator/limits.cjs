const { pickAccount, roleById } = require("@milagre/shared/orchestrator");
const { providerName } = require("@milagre/shared/providers");

const UNKNOWN_RESET_MS = 60 * 60_000;

/** Picks an account per provider, skipping ones whose task Chats hit a usage limit until they reset. */
function createAccounts({ ports, settings, now }) {
  const limits = new Map();
  const keyOf = (provider, accountId) => `${provider}\n${accountId ?? ""}`;

  function isLimited(provider, accountId) {
    const until = limits.get(keyOf(provider, accountId));
    if (until === undefined) return false;
    if (until > now()) return true;
    limits.delete(keyOf(provider, accountId));
    return false;
  }

  async function chooseAccount(provider, projectPath) {
    const projectAccountId = ports.selectedAccount(provider, projectPath);
    const usage = await ports.accountUsage().catch(() => []);
    const accounts = usage
      .filter((entry) => entry.provider === provider)
      .map((entry) => ({ id: entry.accountId, usedPercent: entry.usedPercent, limited: entry.usedPercent >= 100 || isLimited(provider, entry.accountId) }));
    const picked = pickAccount({ mode: settings().account, accounts, projectAccountId });
    const allLimited = accounts.length > 0 && accounts.every((account) => account.limited);
    const pickedLimited = accounts.some((account) => account.id === picked.accountId && account.limited);
    return { ...picked, limited: allLimited || pickedLimited || isLimited(provider, picked.accountId) };
  }

  /** The role itself when its provider has room, else the first role on another provider that does. */
  async function roleWithRoom(role, projectPath) {
    const account = await chooseAccount(role.provider, projectPath);
    if (!account.limited) return { role, account, reason: null };
    for (const other of settings().roles) {
      if (!other.provider || !other.model || other.provider === role.provider) continue;
      const otherAccount = await chooseAccount(other.provider, projectPath);
      if (!otherAccount.limited)
        return { role: other, account: otherAccount, reason: `${providerName(role.provider)} is at its usage limit, so ${other.name} took it` };
    }
    return { role, account, reason: null };
  }

  function record(provider, accountId, resetsAt) {
    const until = Date.parse(resetsAt ?? "");
    limits.set(keyOf(provider, accountId), Number.isFinite(until) ? until : now() + UNKNOWN_RESET_MS);
  }

  return { chooseAccount, roleWithRoom, record };
}

/** Watches task Chats: a limit on a task's first turn moves it to an account with room; a later one is shown on its card. */
function createLimitWatch({ store, accounts, settings, taskFor, isStarting, restart }) {
  const worked = new Set();
  return {
    forget: (taskId) => worked.delete(taskId),
    observe(chatKey, event) {
      if (event.type !== "turn-completed" && event.type !== "turn-failed" && event.type !== "turn-started") return;
      const task = taskFor(chatKey);
      if (!task) return;
      if (event.type === "turn-started") {
        if (task.limit) store.updateTask(task.id, () => ({ limit: null }));
        return;
      }
      if (event.type === "turn-completed" || !event.limit) {
        worked.add(task.id);
        return;
      }
      accounts.record(event.limit.provider, task.accountId, event.limit.resetsAt);
      store.updateTask(task.id, () => ({ limit: { provider: event.limit.provider, resetsAt: event.limit.resetsAt ?? null } }));
      if (worked.has(task.id) || isStarting(task.id)) return;
      void (async () => {
        const roomy = await accounts.roleWithRoom(roleById(settings().roles, task.role) ?? { provider: event.limit.provider }, task.projectPath);
        if (roomy.account.limited) return;
        await restart(task, { projectPath: task.projectPath, role: roomy.role.id, title: task.title, reason: task.reason.project, roleReason: roomy.reason });
      })().catch((error) => console.warn("[orchestrator] couldn't move a limited task:", error.message));
    },
  };
}

module.exports = { createAccounts, createLimitWatch };
