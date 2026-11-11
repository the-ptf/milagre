// oxlint-disable eslint/no-underscore-dangle -- Fixed fixture diagnostic globals.
// Synthetic DOM events through production components only. No direct send invocation and no request rewriting.
window.__fixtureSendPhase = async (context, { bounded, wait }) => {
  const body = "Rust fixture native composer send";
  const reply = "Scripted isolated reply";
  const bridge = window.milagre;
  const trace = (window.__fixtureSendTrace = {
    phase: context.phase,
    source: "synthetic DOM clicks and beforeinput through production model picker, Settings and composer",
    body,
    reply,
    sendClicks: 0,
    events: [],
  });
  const button = (label) => document.querySelector(`button[aria-label="${label}"]`);
  const exactButton = (root, text) => [...root.querySelectorAll("button")].find((node) => node.textContent.trim() === text);
  const read = async () => {
    const state = await bounded(bridge.readState(context.project), "send state read");
    const messages = state.state?.messages ?? [];
    const users = messages.filter((message) => message.role === "user" && message.body === body);
    if (!users.length) return null;
    if (users.length !== 1) throw Error("Native send created duplicate user messages");
    const page = await bounded(bridge.readChatMessages(context.project, users[0].session_id, { turns: 20, limit: 100 }), "send message page");
    const assistants = page.messages.filter((message) => message.role === "assistant");
    if (assistants.length !== 1 || assistants[0].body !== reply) return null;
    if (page.messages.length !== 2 || page.total !== 2 || page.hasMore) throw Error("Unexpected scripted transcript shape");
    if (state.state.persistence) return null;
    return {
      sessionId: users[0].session_id,
      userId: users[0].id,
      assistantId: assistants[0].id,
      userCount: 1,
      assistantCount: 1,
      pageTotal: page.total,
      ownerReadConfirmed: true,
      persistenceErrorAbsent: true,
      directDiskRead: false,
      summary: state.state.sessions?.[users[0].session_id]?.summary ?? null,
    };
  };
  const listedRow = () => {
    const rows = [...document.querySelectorAll("[data-chat-id] button[data-row]")];
    const sentRows = rows.filter((row) => row.closest("[data-chat-id]").dataset.chatId === String(trace.transcript.sessionId));
    trace.sidebar = { rowCount: rows.length, sentRowCount: sentRows.length, ids: rows.map((row) => row.closest("[data-chat-id]").dataset.chatId) };
    return rows.length === 1 && sentRows.length === 1 ? sentRows[0] : null;
  };
  const requireListed = async () => {
    const row = listedRow();
    if (!row && trace.transcript.summary?.count === 0) throw Error("Sent Chat missing from sidebar: owner summary.count is 0 beside two messages");
    return row ?? (await wait(listedRow, "exactly one listed sent Chat"));
  };
  if (context.phase === 1) {
    trace.transcript = await wait(read, "single transcript after renderer reload");
    trace.stage = "sidebar-after-reload";
    const row = await requireListed();
    trace.automaticSelection = { selected: row.getAttribute("aria-current") === "page", replyVisible: document.body.innerText.includes(reply) };
    row.click();
    trace.sidebarClicks = 1;
    await wait(() => row.getAttribute("aria-current") === "page" && document.body.innerText.includes(reply), "assistant rendered after clicking listed Chat");
    trace.sendCalls = window.__rustDiagnostics.calls.filter((item) => item.method === "chat:send").length;
    if (trace.sendCalls !== 0) throw Error("Renderer replayed a send after reload");
    trace.reloadSurvived = true;
    return trace;
  }
  trace.stage = "settings";
  button("Settings").click();
  const settings = await wait(() => document.querySelector("[data-settings-modal]"), "Settings dialog");
  const chat = await wait(() => exactButton(settings, "Models"), "Models settings navigation");
  chat.click();
  const tldr = await wait(() => settings.querySelector('input[aria-label="TLDR writing"]'), "TLDR checkbox");
  if (tldr.checked) tldr.click();
  await wait(() => JSON.parse(localStorage.getItem("milagre-settings") || "{}").tldrEnabled === false, "private Settings change");
  trace.settings = { tldrEnabled: false, replies: JSON.parse(localStorage.getItem("milagre-settings") || "{}").claudeReplies };
  button("Close Settings").click();
  await wait(() => !document.querySelector("[data-settings-modal]"), "Settings closed");
  trace.stage = "model-picker";
  const trigger = await wait(() => document.querySelector("[data-model-name]")?.closest("button"), "model trigger");
  trigger.click();
  const provider = await wait(() => document.querySelector('[data-model-picker] button[aria-label="Kiro"]'), "advertised Kiro provider");
  provider.click();
  const model = await wait(
    () => [...document.querySelectorAll("[data-model-picker] button")].find((node) => node.textContent.includes("Scripted Rust fixture")),
    "advertised scripted model",
  );
  model.click();
  await wait(() => document.querySelector("[data-model-name]")?.textContent === "Scripted Rust fixture", "scripted model selected");
  document.querySelector("[data-model-name]").closest("button").click();
  await wait(() => !document.querySelector("[data-model-picker]"), "model picker closed");
  trace.model = {
    name: document.querySelector("[data-model-name]").textContent,
    permissionMode: document.querySelector("[data-model-name]").closest("button").dataset.permissionMode,
  };
  if (trace.model.permissionMode !== "ask") throw Error("Fixture requires Ask mode");
  const before = window.__rustDiagnostics.calls.length;
  const unsubscribe = bridge.onAgentEvent(({ chatId, event, seq }) => {
    if (!chatId?.startsWith(`${context.project}#`) || !event || trace.events.length >= 32) return;
    trace.events.push({ chatId, type: event.type, seq });
  });
  try {
    trace.stage = "composer";
    const editor = await wait(() => document.querySelector('[data-prompt-editor][contenteditable="true"]'), "editable composer");
    editor.focus();
    editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: body }));
    await wait(() => editor.textContent === body && button("Send") && !button("Send").disabled, "composer draft and enabled Send");
    trace.stage = "send";
    trace.sendClicks++;
    button("Send").click();
    const call = await wait(
      () => window.__rustDiagnostics.calls.slice(before).find((item) => item.method === "chat:send" && !item.pending),
      "renderer send outcome",
    );
    trace.sendOutcome = { error: call.error ?? null };
    if (call.error) throw Error(`Production renderer send refused: ${call.error}`);
    trace.sendCalls = window.__rustDiagnostics.calls.slice(before).filter((item) => item.method === "chat:send").length;
    if (trace.sendCalls !== 1) throw Error("Renderer made more than one send call");
    trace.transcript = await wait(read, "single owner transcript");
    trace.stage = "sidebar-after-send";
    await requireListed();
    await wait(() => document.body.innerText.includes(reply), "assistant in actual Chat UI");
    trace.sendCalls = window.__rustDiagnostics.calls.slice(before).filter((item) => item.method === "chat:send").length;
    if (trace.sendCalls !== 1) throw Error("Renderer made more than one send call");
    const sequences = trace.events.map((event) => event.seq);
    if (!sequences.length || !sequences.every((seq, index) => Number.isSafeInteger(seq) && (index === 0 || seq > sequences[index - 1])))
      throw Error("Agent events have no strictly increasing sequence");
    if (trace.events.filter((event) => event.type === "turn-completed").length !== 1 || !trace.events.some((event) => event.type === "text-delta"))
      throw Error("Missing single terminal or streamed text event");
    trace.stage = "complete";
    return trace;
  } finally {
    unsubscribe();
  }
};
