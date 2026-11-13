// Opt-in checks of the real retained workflow surfaces. No provider run, account
// mutation, terminal creation/input/resize, Git write or attachment send occurs.
// oxlint-disable eslint/no-underscore-dangle -- Explicit smoke diagnostics contract.
(() => {
  let running;
  window.__rustWorkflowSmoke = (selectedChatKey) => (running ??= run(selectedChatKey));
  async function run(selectedChatKey) {
    const checks = [];
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const wait = async (read, label, timeout = 12000) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        window.__rustSettleForCapture?.();
        const result = read();
        if (result) return result;
        await pause(100);
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    const check = async (name, action) => {
      try {
        const result = await action();
        checks.push({ name, status: "passed", ...result });
      } catch (error) {
        checks.push({ name, status: "failed", error: error.message || String(error) });
      }
    };
    const button = (label) => document.querySelector(`button[aria-label="${label}"]`);
    const current = await window.milagre.getCurrentProject();
    const row = document.querySelector('[data-chat-id] button[data-row][aria-current="page"]')?.closest("[data-chat-id]");
    const scopeEnd = selectedChatKey?.lastIndexOf("#") ?? -1;
    const sessionId = scopeEnd > 0 && selectedChatKey.slice(0, scopeEnd) === current?.path ? selectedChatKey.slice(scopeEnd + 1) : row?.dataset.chatId;
    const session = current?.state?.sessions?.[sessionId];
    const worktree = current?.state?.worktrees?.[session?.worktree_id];
    const cwd = worktree?.path || current?.path;
    const chatKey = current?.path && sessionId ? `${current.path}#${sessionId}` : null;

    await check("changes-read-and-panel", async () => {
      if (!cwd) throw new Error("No current Project folder to inspect");
      const request = { cwd, mode: "uncommitted" };
      const files = await window.milagre.git.diffFiles(request);
      if (!files?.isRepo || !Array.isArray(files.files)) throw new Error("Current folder did not return a Git file list");
      const sample = files.files.find((file) => !file.binary);
      let patch;
      if (sample) {
        patch = await window.milagre.git.diffFile({ ...request, path: sample.path, oldPath: sample.oldPath, untracked: sample.untracked });
        if (typeof patch?.patch !== "string" || typeof patch?.binary !== "boolean") throw new Error("Git patch response is invalid");
      }
      const toggle = document.querySelector('[data-panel-toggle="changes"]');
      if (!toggle) throw new Error("Changes panel toggle is missing");
      const alreadyOpen = toggle.getAttribute("aria-pressed") === "true";
      try {
        if (!alreadyOpen) toggle.click();
        const panel = await wait(() => document.querySelector("[data-changes-panel]"), "Changes panel");
        const rect = panel.getBoundingClientRect();
        if (rect.width < 200 || rect.height < 100) throw new Error("Changes panel has invalid geometry");
        return {
          files: files.files.length,
          patchRead: !!sample,
          patchCharacters: patch?.patch.length ?? 0,
          patchTooLarge: patch?.tooLarge ?? false,
          panelVisible: true,
        };
      } finally {
        if (!alreadyOpen && toggle.isConnected && toggle.getAttribute("aria-pressed") === "true") toggle.click();
      }
    });

    await check("terminal-read-only-metadata", async () => {
      if (!chatKey) throw new Error("No selected Chat for terminal metadata");
      const profiles = await window.milagre.terminals.profiles();
      const listed = await window.milagre.terminals.list({ chatId: chatKey });
      if (!Array.isArray(profiles?.shells) || !Array.isArray(listed?.terminals)) throw new Error("Terminal metadata response is invalid");
      let outputRead = false;
      if (listed.terminals[0]) {
        const read = await window.milagre.terminals.read({ terminalId: listed.terminals[0].id, after: 0, limit: 256 });
        if (typeof read?.data !== "string" || typeof read?.offset !== "number") throw new Error("Terminal read response is invalid");
        outputRead = true;
      }
      return {
        profiles: profiles.shells.length,
        terminals: listed.terminals.length,
        outputRead,
        panelTogglePresent: !!document.querySelector('[data-panel-toggle="terminal"]'),
        coverage: "Metadata and existing output only. Interactive terminal opening/input/resize was not exercised.",
      };
    });

    await check("accounts-read-and-settings", async () => {
      const snapshot = await window.milagre.listAccounts(false);
      if (!Array.isArray(snapshot?.providers)) throw new Error("Account snapshot is invalid");
      const settings = button("Settings");
      if (!settings) throw new Error("Settings button is missing");
      settings.click();
      try {
        const navigation = await wait(() => document.querySelector('[aria-label="Settings navigation"]'), "Settings navigation");
        const accounts = [...navigation.querySelectorAll("button")].find((node) => node.textContent.trim() === "Accounts");
        if (!accounts) throw new Error("Accounts settings navigation is missing");
        accounts.click();
        const panel = await wait(() => document.querySelector("[data-accounts-settings]"), "Accounts settings panel");
        await wait(() => panel.querySelector("section") || snapshot.providers.length === 0, "loaded account settings");
        // Counts only. Never store account addresses, labels, keys or credentials.
        return {
          providers: snapshot.providers.length,
          accounts: snapshot.providers.reduce((total, group) => total + (group.accounts?.length || 0), 0),
          panelVisible: true,
          mutationAttempted: false,
        };
      } finally {
        button("Close Settings")?.click();
      }
    });

    await check("attachment-affordances", async () => {
      const input = await wait(() => document.querySelector('input[type="file"][aria-label="Choose attachments"]'), "attachment file input");
      const attach = button("Attach files");
      if (!attach || attach.disabled || !input.multiple) throw new Error("Attachment affordances are unavailable");
      return { buttonEnabled: true, multipleFiles: true, coverage: "Controls inspected. File picker, staging and send were not exercised." };
    });

    if (window.__rustWorkflowBackground === true) {
      await check("download-background-cancellation", async () => {
        const cancelled = await window.__TAURI__.core.invoke("native_call", {
          method: "download:save",
          args: [{ name: "milagre-rust-smoke.txt", size: 4, base64: "dGVzdA==" }],
        });
        if (cancelled !== null) throw new Error("Background download must return cancellation");
        const calls = window.__rustDiagnostics.calls;
        const started = performance.now();
        const blobUrl = URL.createObjectURL(new Blob(["test"]));
        const anchor = document.createElement("a");
        anchor.href = blobUrl;
        anchor.download = "milagre-rust-smoke.txt";
        anchor.click();
        URL.revokeObjectURL(blobUrl);
        const call = await wait(() => calls.find((item) => item.method === "download:save" && item.at >= started && !item.pending), "detached download bridge");
        if (call.error) throw new Error(call.error);
        return {
          cancelled: true,
          detachedAnchorRouted: true,
          bytesWritten: 0,
          scope: "Background native cancellation only. Interactive save dialog was not exercised.",
        };
      });
    } else {
      checks.push({
        name: "download-background-cancellation",
        status: "skipped",
        reason: "Native background flag was not explicitly set; no dialog was opened.",
      });
    }
    window.__rustSettleForCapture?.();
    return { passed: checks.every((entry) => entry.status !== "failed"), checks };
  }
})();
