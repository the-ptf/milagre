// oxlint-disable eslint/no-underscore-dangle -- Explicit bounded native smoke diagnostics.
// Production React controls only. The native JSON plan supplies text and any exact approval.
void (async () => {
  if (window.__chatNativeSmoke) return;
  window.__chatNativeSmoke = true;
  let context;
  let off;
  const stage = { phase: 0, passed: false, sendClicks: 0, permissionClicks: 0, events: [] };
  const expires = Date.now() + 145000;
  const bounded = async (promise, label) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), Math.max(1, Math.min(10000, expires - Date.now())));
      }),
    ]).finally(() => clearTimeout(timer));
  };
  const wait = async (check, label) => {
    while (Date.now() < expires) {
      const found = await bounded(Promise.resolve().then(check), label);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error(`Timed out: ${label}`);
  };
  const button = (label) => document.querySelector(`button[aria-label="${label}"]`);
  try {
    context = await wait(async () => {
      try {
        return await window.__TAURI__.core.invoke("native_call", { method: "chat-desktop:smoke-context", args: [] });
      } catch (error) {
        if (error?.code === "SMOKE_STORE_NOT_READY") return null;
        throw error;
      }
    }, "confirmed nonpersistent store");
    stage.phase = context.phase;
    stage.mode = context.plan.mode;
    const { project, model, plan } = context;
    const chatId = `${project}#${plan.sessionId}`;
    await wait(() => window.__rustDiagnostics?.ready && window.milagre, "production renderer bootstrap");
    const bridge = window.milagre;
    await wait(() => document.querySelector("[data-dock-layer]"), "mounted production workspace");
    button("Expand sidebar")?.click();
    const row = await wait(() => document.querySelector(`[data-chat-id="${plan.sessionId}"] button[data-row]`), "saved Chat sidebar row");
    row.click();
    stage.navigation = "production sidebar row";
    await wait(
      () => row.getAttribute("aria-current") === "page" && document.querySelector('[data-prompt-editor][contenteditable="true"]'),
      "selected Chat and mounted composer",
    );
    await wait(async () => (await bridge.getCurrentProject())?.path === project, "dedicated Project selected");
    const read = () => bounded(bridge.readChatMessages(project, plan.sessionId, { turns: 100, limit: 500 }), "saved Chat page");
    const before = await read();
    stage.before = { total: before.total, ids: before.messages.map((message) => message.id) };
    const callsBefore = window.__rustDiagnostics.calls.length;
    let terminal;
    let permission;
    let unexpectedPermission;
    off = bridge.onAgentEvent(({ chatId: target, event, seq }) => {
      if (target !== chatId || !event) return;
      if (stage.events.length < 128) stage.events.push({ type: event.type, seq, requestId: event.requestId });
      if (["turn-completed", "turn-failed", "turn-cancelled"].includes(event.type)) terminal = event;
      if (event.type === "permission-request") {
        if (!plan.permission || event.tool !== plan.permission.tool || event.files?.length !== 1 || event.files[0] !== plan.permission.path || permission)
          unexpectedPermission = event;
        else permission = event;
      }
    });
    if (plan.mode === "send" && context.phase === 0) {
      stage.step = "configured-model";
      const catalog = await bounded(bridge.getModels(project), "configured model catalog");
      const advertised = catalog.claude?.find((item) => item.id === model);
      if (!advertised) throw Error("Configured Claude model missing from owner catalog");
      const trigger = await wait(() => document.querySelector("[data-model-name]")?.closest("button"), "model picker trigger");
      trigger.click();
      (await wait(() => document.querySelector('[data-model-picker] button[aria-label="Claude"]'), "Claude picker tab")).click();
      const choice = await wait(
        () => [...document.querySelectorAll("[data-model-picker] button")].find((node) => node.textContent.includes(advertised.name)),
        "configured model row",
      );
      choice.click();
      await wait(() => document.querySelector("[data-model-name]")?.textContent === advertised.name, "configured model selected");
      document.querySelector("[data-model-name]").closest("button").click();
      await wait(() => !document.querySelector("[data-model-picker]"), "model picker closed");
      if (document.querySelector("[data-model-name]").closest("button").dataset.permissionMode !== "ask")
        throw Error("Native smoke requires the existing Chat in Ask mode");
      stage.step = "composer";
      const editor = await wait(() => document.querySelector('[data-prompt-editor][contenteditable="true"]'), "production composer");
      if (editor.textContent.trim()) throw Error("Composer already contains a draft; refusing to replace it");
      editor.focus();
      editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: plan.body }));
      await wait(() => editor.textContent === plan.body && button("Send") && !button("Send").disabled, "entered draft and enabled Send");
      stage.sendClicks++;
      button("Send").click();
      const sent = await wait(
        () => window.__rustDiagnostics.calls.slice(callsBefore).find((call) => call.method === "chat:send" && !call.pending),
        "production send acknowledgement",
      );
      if (sent.error) throw Error(sent.error);
      if (plan.permission) {
        stage.step = "permission";
        await wait(() => {
          if (unexpectedPermission) throw Error("Unexpected native permission request; no answer sent");
          return permission;
        }, "exact Write permission request");
        const card = await wait(() => {
          const cards = [...document.querySelectorAll('[data-slot="step-approval"], [aria-label="Tool approval"]')].filter((node) =>
            [...node.querySelectorAll("button")].some((item) => item.textContent.trim() === "Allow once"),
          );
          if (cards.length > 1) throw Error("Multiple visible permission cards; no answer sent");
          return cards[0];
        }, "single pending permission card");
        if (!card.textContent.includes(plan.permission.path)) {
          const details = [...card.querySelectorAll('button[aria-expanded="false"]')].find((node) => node.textContent.includes("Details"));
          if (details) details.click();
        }
        await wait(() => card.textContent.includes(plan.permission.path), "exact file visible in permission details");
        const label = plan.permission.decision === "allow" ? "Allow once" : "Deny";
        const answer = await wait(
          () => [...card.querySelectorAll("button")].find((node) => node.textContent.trim() === label && !node.disabled),
          "permission answer button",
        );
        stage.permission = {
          requestId: permission.requestId,
          tool: permission.tool,
          files: permission.files,
          decision: plan.permission.decision,
          button: label,
        };
        stage.permissionClicks++;
        answer.click();
      }
      stage.step = "terminal";
      await wait(() => {
        if (unexpectedPermission) throw Error("Unexpected native permission request; no answer sent");
        return terminal;
      }, "native terminal event");
      if (terminal.type !== "turn-completed") throw Error(`Native turn ended as ${terminal.type}`);
      if (!stage.events.some((event) => event.type === "text-delta")) throw Error("No streamed text event observed");
      if (plan.permission && !stage.events.some((event) => event.type === "permission-resolved" && event.requestId === permission.requestId))
        throw Error("Permission answer has no resolved event");
    }
    stage.step = "saved-and-visible";
    const after = await read();
    stage.after = {
      total: after.total,
      ids: after.messages.map((message) => message.id),
      users: after.messages.filter((message) => message.role === "user").length,
      assistants: after.messages.filter((message) => message.role === "assistant").length,
    };
    if (plan.mode === "send") {
      if (context.phase === 0 && after.total !== before.total + 2) throw Error("Send did not create exactly one user and one assistant message");
      if (!after.messages.some((message) => message.role === "user" && message.body === plan.body)) throw Error("Saved user text missing");
    }
    const lastReply = after.messages.findLast((message) => message.role === "assistant" && message.body?.trim());
    if (!lastReply) throw Error("Saved Chat has no assistant reply to inspect");
    const visible = plan.expectedText || lastReply.body.slice(0, 80);
    if (!lastReply.body.includes(visible)) throw Error("Saved reply does not contain expectedText");
    await wait(() => document.body.innerText.includes(visible), "saved assistant reply in production Chat");
    stage.visibleText = visible;
    const state = await bounded(bridge.readState(project), "owner state");
    stage.epoch = state.epoch;
    stage.nativeId = state.state.sessions[String(plan.sessionId)].native_session_id;
    stage.sendCalls = window.__rustDiagnostics.calls.slice(callsBefore).filter((call) => call.method === "chat:send").length;
    if (stage.sendCalls !== (plan.mode === "send" && context.phase === 0 ? 1 : 0)) throw Error("Unexpected send/replay count");
    for (const animation of document.getAnimations())
      if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) {
        try {
          animation.finish();
        } catch {}
      }
    stage.rendererErrors = window.__rustDiagnostics.errors.map(({ method, code, message }) => ({ method, code, message }));
    stage.step = "complete";
    stage.passed = true;
  } catch (error) {
    stage.error = error.message || String(error);
  } finally {
    off?.();
  }
  await window.__TAURI__.core.invoke("smoke_result", { value: JSON.stringify(stage) });
})();
