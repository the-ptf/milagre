// Optional real-provider verification, injected deliberately by the Rust smoke launcher.
// An absent config does nothing. A configured run sends exactly once to an empty QA Chat.
// oxlint-disable eslint/no-underscore-dangle -- Explicit smoke diagnostics contract.
(() => {
  if (!window.__rustLiveChatProbe || window.__rustLiveChatSmoke) return;
  const { projectPath, sessionId, worktreeId, provider, model } = window.__rustLiveChatProbe;
  window.__rustLiveChatSmoke = (async () => {
    const started = Date.now();
    const expires = started + 90000;
    const body = "Rust migration bridge verification. Do not use tools or modify files. Reply exactly RUST_BRIDGE_OK.";
    const chatKey = `${projectPath}#${sessionId}`;
    const result = {
      passed: false,
      stage: "configuration",
      chatKey,
      projectPath,
      sessionId,
      worktreeId,
      provider,
      model,
      clientMessageId: `rust-bridge-probe-${crypto.randomUUID()}`,
      sendAttempts: 0,
      acknowledged: false,
      storedUserCount: 0,
      storedAssistantCount: 0,
      assistantExactMatch: false,
      events: { count: 0, types: {}, firstSeq: null, lastSeq: null, toolSteps: 0 },
    };
    let unsubscribe;
    let terminalFailure;
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const bounded = async (operation, label) => {
      const remaining = expires - Date.now();
      if (remaining <= 0) throw new Error(`Live Chat probe exceeded 90 seconds at ${label}; no resend was attempted`);
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(operation),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Live Chat probe exceeded 90 seconds at ${label}; no resend was attempted`)), remaining);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const wait = async (read, label) => {
      while (true) {
        const value = await bounded(read, label);
        if (value) return value;
        await bounded(() => pause(100), label);
      }
    };
    const selectedRow = () => {
      const scope = CSS.escape(projectPath);
      const id = CSS.escape(String(sessionId));
      return document.querySelector(
        `[data-chat-key="${CSS.escape(chatKey)}"] [data-row][aria-current="page"],` +
          `[data-chat-scope="${scope}"] [data-chat-id="${id}"] [data-row][aria-current="page"]`,
      );
    };
    try {
      if (
        typeof projectPath !== "string" ||
        !projectPath.startsWith("/") ||
        !Number.isSafeInteger(sessionId) ||
        sessionId < 1 ||
        !Number.isSafeInteger(worktreeId) ||
        worktreeId < 1 ||
        typeof provider !== "string" ||
        !provider.trim() ||
        typeof model !== "string" ||
        !model.trim()
      )
        throw new Error("Live Chat probe requires an explicit local Project, existing QA Chat, Worktree, provider and model");

      result.stage = "bridge-ready";
      // The ordinary smoke visits other Chats. Finish it first so the final screenshot stays on this QA Chat.
      await wait(() => window.__rustOrdinarySmokeComplete && window.__rustDiagnostics?.ready && window.milagre, "production smoke and bridge");
      const bridge = window.milagre;
      for (const method of ["sendMessage", "readChatMessages", "readState", "getRuns", "getCurrentProject", "onAgentEvent"]) {
        if (typeof bridge[method] !== "function") throw new Error(`Production bridge is missing ${method}`);
      }
      result.stage = "open-qa-chat";
      document.querySelector('button[aria-label="Expand sidebar"]')?.click();
      await bounded(() => window.__TAURI__.event.emit("native-event", { channel: "notification:open-chat", payload: chatKey }), "opening QA Chat");
      await wait(async () => (await bridge.getCurrentProject())?.path === projectPath, "QA Project selection");
      // Production deliberately omits a Chat with no messages from its sidebar. Its first send makes the row appear.
      result.selectedChatVisibleBeforeSend = Boolean(selectedRow());

      result.stage = "validate-empty-qa-chat";
      const [initial, state, runs] = await bounded(
        () => Promise.all([bridge.readChatMessages(projectPath, sessionId, { turns: 20, limit: 100 }), bridge.readState(projectPath), bridge.getRuns()]),
        "QA Chat preflight",
      );
      const session = state?.state?.sessions?.[sessionId];
      if (!session || session.archived || session.worktree_id !== worktreeId || !state.state.worktrees?.[worktreeId])
        throw new Error("QA Chat does not match an active session in the configured Worktree");
      if (!Array.isArray(initial?.messages) || initial.messages.length !== 0 || initial.total !== 0 || initial.hasMore) {
        throw new Error("Refusing to send: the configured QA Chat is not empty");
      }
      if (!runs?.runs || typeof runs.runs !== "object" || runs.runs[chatKey] || session.backgroundTasks?.length) {
        throw new Error("Refusing to send: the configured QA Chat is running or its idle state could not be verified");
      }
      result.initialMessageCount = initial.total;
      unsubscribe = bridge.onAgentEvent(({ chatId, event, seq }) => {
        if (chatId !== chatKey || !event || typeof event.type !== "string") return;
        const type = event.type;
        result.events.count++;
        result.events.types[type] = (result.events.types[type] || 0) + 1;
        if (Number.isSafeInteger(seq)) {
          result.events.firstSeq ??= seq;
          result.events.lastSeq = seq;
        }
        if (type === "step-started" && event.step?.kind !== "thinking") result.events.toolSteps++;
        if (["turn-failed", "turn-cancelled", "permission-request", "question-request"].includes(type)) terminalFailure = type;
      });

      result.stage = "send-once";
      // A timeout can leave the accepted operation running. Never retry this call or test idempotency with a second send.
      const sent = await bounded(() => {
        result.sendAttempts++;
        return bridge.sendMessage({
          projectPath,
          sessionId,
          worktreeId,
          provider,
          model,
          clientMessageId: result.clientMessageId,
          body,
          prompt: body,
          images: [],
          files: [],
          permissionMode: "ask",
          effort: "low",
        });
      }, "single Chat send");
      if (sent?.sessionId !== sessionId) throw new Error("The send acknowledgement named a different Chat");
      result.acknowledged = true;

      result.stage = "select-sent-qa-chat";
      await bounded(() => window.__TAURI__.event.emit("native-event", { channel: "notification:open-chat", payload: chatKey }), "selecting the sent QA Chat");
      await wait(selectedRow, "selected QA Chat row after its first message");
      result.selectedChatVisible = true;

      result.stage = "verify-saved-reply";
      while (true) {
        const page = await bounded(() => bridge.readChatMessages(projectPath, sessionId, { turns: 20, limit: 100 }), "saved Chat messages");
        if (!Array.isArray(page?.messages)) throw new Error("Chat page has no message array");
        const users = page.messages.filter((message) => message.role === "user" && message.clientMessageId === result.clientMessageId);
        const assistants = page.messages.filter((message) => message.role === "assistant" && message.id > (users[0]?.id ?? Infinity));
        result.storedUserCount = users.length;
        result.storedAssistantCount = assistants.length;
        result.totalSavedMessages = page.total;
        result.userBodyMatches = users.length === 1 && users[0].body === body;
        result.assistantExactMatch = assistants.some(
          (message) => message.body?.trim() === "RUST_BRIDGE_OK" && !["failed", "cancelled"].includes(message.outcome),
        );
        if (users.length > 1) throw new Error("More than one saved user message has the single send identity");
        if (terminalFailure) throw new Error(`The real provider emitted ${terminalFailure}; no response or resend was automated`);
        if (result.events.toolSteps) throw new Error("The real provider started a tool step despite the tool-free probe instruction");
        if (result.userBodyMatches && result.assistantExactMatch && result.events.types["message-sent"] && result.events.types["turn-completed"]) break;
        if (result.events.types["turn-completed"] && assistants.length)
          throw new Error("The saved assistant reply did not match the requested verification token");
        await bounded(() => pause(600), "provider reply");
      }
      result.stage = "capture-qa-chat";
      await wait(selectedRow, "QA Chat remaining selected");
      await bounded(() => pause(500), "rendering the saved reply");
      window.__rustSettleForCapture?.();
      result.passed = true;
      result.stage = "complete";
    } catch (error) {
      result.error = String(error?.message || error).slice(0, 600);
    } finally {
      unsubscribe?.();
      result.elapsedMs = Date.now() - started;
    }
    // Counts, event names and match booleans are evidence. Do not copy the Chat transcript into diagnostics.
    const combined = { ...window.__rustSmokeResult, liveChat: result };
    window.__rustSmokeResult = combined;
    try {
      await window.__TAURI__.core.invoke("smoke_result", { value: JSON.stringify(combined) });
    } catch (error) {
      result.persistenceError = String(error?.message || error).slice(0, 300);
    }
    return result;
  })();
})();
