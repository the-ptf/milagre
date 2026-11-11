// Local opt-in smoke sequence. It only views existing saved data and captures the
// actual WKWebView. No provider turns, state edits or alternate HTML are created.
// oxlint-disable eslint/no-underscore-dangle -- Capture diagnostics contract.
(() => {
  if (!window.__rustCapturePlan || window.__rustComparisonCapture) return;
  window.__rustComparisonCapture = (async () => {
    const result = { passed: false, source: "Installed Rust app, real production React renderer, existing shared daemon", captures: [], errors: [] };
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const wait = async (read, label, timeout = 180000) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const value = await read();
        if (value) return value;
        await pause(100);
      }
      throw new Error(`Capture timed out waiting for ${label}`);
    };
    try {
      const plan = window.__rustCapturePlan;
      if (!Array.isArray(plan) || plan.length < 1 || plan.length > 3) throw new Error("Capture plan needs 1 to 3 saved surfaces");
      const panels = new Set();
      for (const entry of plan) {
        if (!["chat", "designs", "artifacts"].includes(entry.panel) || panels.has(entry.panel) || !/^\/.+#\d+$/.test(entry.chatKey)) {
          throw new Error("Capture plan needs unique chat/designs/artifacts panels and existing local Chat keys");
        }
        panels.add(entry.panel);
      }
      // Ordinary smoke awaits workflows. The optional provider probe must finish
      // before the view-only sequence, so the two never switch Chats concurrently.
      await wait(() => window.__rustOrdinarySmokeComplete, "ordinary smoke and retained workflows");
      if (window.__rustLiveChatSmoke) {
        const live = await window.__rustLiveChatSmoke;
        if (!live.passed) throw new Error(`Live Chat probe failed: ${live.error || live.stage}`);
      }
      for (const entry of plan) {
        const split = entry.chatKey.lastIndexOf("#");
        const projectPath = entry.chatKey.slice(0, split);
        const sessionId = Number(entry.chatKey.slice(split + 1));
        const saved = await window.milagre.readState(projectPath);
        const session = saved?.state?.sessions?.[sessionId];
        if (!session) throw new Error(`Saved capture Chat does not exist: ${entry.chatKey}`);
        await window.__TAURI__.event.emit("native-event", { channel: "notification:open-chat", payload: entry.chatKey });
        const expectedTitle = session.title?.trim() || session.generatedTitle?.trim();
        await wait(
          () => {
            const selected = document.querySelector(
              `[data-chat-key="${CSS.escape(entry.chatKey)}"] [data-row][aria-current="page"],` +
                `[data-chat-scope="${CSS.escape(projectPath)}"] [data-chat-id="${sessionId}"] [data-row][aria-current="page"]`,
            );
            return selected || (expectedTitle && document.querySelector("[data-chat-identity-title]")?.textContent?.trim() === expectedTitle);
          },
          "requested saved Chat selection",
          20000,
        );
        await pause(1000);
        window.__comparisonCapture = entry;
        const state = await window.__rustPrepareComparison();
        // smoke_result(label) resolves only after the native snapshot callback
        // has encoded and privately written this exact surface's PNG.
        const capture = await window.__TAURI__.core.invoke("smoke_result", { label: entry.panel, value: JSON.stringify({ ...entry, state }) });
        if (capture?.ok !== true) throw new Error(`Native ${entry.panel} capture did not complete`);
        result.captures.push({ ...entry, state, capture });
      }
      result.passed = result.captures.length === plan.length;
    } catch (error) {
      result.errors.push(error.message || String(error));
    }
    const combined = { ...window.__rustSmokeResult, comparison: result };
    window.__rustSmokeResult = combined;
    await window.__TAURI__.core.invoke("smoke_result", { value: JSON.stringify(combined) });
    return result;
  })();
})();
