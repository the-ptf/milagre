const { randomUUID } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { SETUP_FILE } = require("./worktree-setup.cjs");

// These are host approvals, independent of a provider's permission mode. The same pending request travels
// in Chat snapshots to desktop and phone; only the first valid response for that Chat can consume it.
class SetupReview {
  constructor({ read, settings, send, computer = os.hostname() }) {
    Object.assign(this, { read, settings, send, computer });
    this.pending = new Map();
  }

  async review({ chatId, cwd, entry, signal }) {
    const force = entry.status === "started" || entry.status === "failed";
    while (!signal.aborted) {
      const resolved = await this.read(entry.projectPath);
      if (signal.aborted) return { cancelled: true };
      if (!resolved.command) return { ...resolved, skipped: true };
      if (!force && (resolved.source !== "repo" || (await this.settings().isSetupTrusted(entry.projectPath, resolved.command)))) return resolved;
      const decision = await this.ask(
        chatId,
        {
          command: resolved.command,
          cwd,
          setup: {
            projectPath: entry.projectPath,
            source: resolved.source === "repo" ? path.join(entry.projectPath, SETUP_FILE) : "Project settings",
            computer: this.computer,
          },
          description: `${force ? "The previous setup did not finish. Review it before trying again. " : ""}Trust this version allows this exact command for this Project on this Computer. Skip setup continues the Chat without running it.`,
        },
        signal,
      );
      if (signal.aborted || decision === null) return { cancelled: true };
      // The command may change while either client is reviewing it. A decision never approves unseen text.
      const current = await this.read(entry.projectPath);
      if (current.command !== resolved.command || current.source !== resolved.source) continue;
      if (decision === "deny") return { ...current, skipped: true };
      if (decision === "allow-for-chat") await this.settings().trustSetup(entry.projectPath, current.command);
      if (signal.aborted) return { cancelled: true };
      return current;
    }
    return { cancelled: true };
  }

  async ask(chatId, details, signal) {
    if (signal.aborted) return null;
    const requestId = `setup-review-${randomUUID()}`;
    let settle;
    const answer = new Promise((resolve) => {
      settle = resolve;
    });
    const finish = (decision) => {
      if (!this.pending.delete(requestId)) return;
      signal.removeEventListener("abort", abort);
      settle(decision);
    };
    const abort = () => finish(null);
    this.pending.set(requestId, { chatId, finish });
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.send(chatId, {
        type: "permission-request",
        requestId,
        kind: "setup",
        tool: "Worktree setup",
        title: "Run this setup command?",
        allowForChat: true,
        ...details,
      });
      return await answer;
    } finally {
      finish(null);
      await this.send(chatId, { type: "permission-resolved", requestId });
    }
  }

  respond(chatId, requestId, decision) {
    const pending = this.pending.get(requestId);
    if (!pending || pending.chatId !== chatId || !["allow", "allow-for-chat", "deny"].includes(decision)) return false;
    pending.finish(decision);
    return true;
  }
}

module.exports = { SetupReview };
