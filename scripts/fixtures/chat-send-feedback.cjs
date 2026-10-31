// Shared IPC fixture for send regressions and renderer benchmarks.
module.exports = `
import React from "react";
import { createRoot } from "react-dom/client";
import "/src/styles.css";
const state = { next_id: 4, projects: { 1: { id: 1, name: "shop" } },
  worktrees: { 1: { id: 1, name: "main", path: "/fixture", project_id: 1 } },
  sessions: { 2: { id: 2, worktree_id: 1, agent_name: "Previous chat", provider: "claude", status: "Idle" } },
  messages: [{ id: 3, session_id: 2, role: "user", body: "Previous chat", context: null }], tasks: {} };
if (new URLSearchParams(location.search).has("long")) {
  state.messages = Array.from({ length: 300 }, (_, index) => ({
    id: index + 3, session_id: 2, role: index % 2 ? "assistant" : "user", context: null,
    body: index % 2 ? "Completed the requested change.\\n\\n" + "The component keeps existing messages visible while the request is pending.\\n\\n".repeat(8) : "Previous chat " + index,
    ...(index % 2 ? { steps: Array.from({ length: 8 }, (_, step) => ({
      id: index + "-" + step, kind: "read", title: "Read source and check implementation", status: "done", detail: "Read source file.\\n".repeat(20),
    })) } : {}),
  }));
  state.next_id = 303;
}
// ?queue: an Antigravity chat whose queue Stop held, as chat-host.cjs saves it.
if (new URLSearchParams(location.search).has("queue")) {
  Object.assign(state.sessions[2], {
    provider: "antigravity",
    queueHeld: true,
    queued: [
      { id: "q1", body: "Then add tests for the checkout page", model: "gemini-3.8-flash-high", provider: "antigravity", queuedAt: 1 },
      { id: "q2", body: "And update the docs", files: ["/fixture/notes.txt"], model: "gemini-3.8-flash-high", provider: "antigravity", queuedAt: 2 },
    ],
  });
}
const lean = new URLSearchParams(location.search).has("lean");
function leanState() {
  const copy = structuredClone(state);
  for (const session of Object.values(copy.sessions)) {
    const chat = copy.messages.filter((message) => message.session_id === session.id);
    session.summary = { count: chat.length, ...(chat.length ? { firstId: chat[0].id, lastId: chat.at(-1).id } : {}), titleLine: chat.find((message) => message.role === "user")?.body, clientMessageIds: chat.flatMap(message => message.clientMessageId ? [message.clientMessageId] : []) };
  }
  return { ...copy, messages: [], messagesInChats: true };
}
window.renderedMessageIds = [];
window.transcriptRenders = 0;
window.railItemsRendered = 0;
window.committedRuns = {};
const listeners = new Set();
window.emitAgent = (sessionId, event) => listeners.forEach(listener => listener({ chatId: "/fixture#" + sessionId, event }));
// Read messages independently of a stale summary, as a reconnect can do while a send is pending.
window.preparePageRefresh = () => {
  const snapshot = leanState();
  window.milagre.readState = async () => ({ epoch: "fixture", version: 1, state: snapshot });
  window.refreshPages = () => listeners.forEach(listener => listener({
    chatId: "/fixture#2", event: { type: "message-sent" }, epoch: "fixture", version: 1, base: 0, resync: true,
  }));
};
window.calls = { created: 0, sent: [] };
window.pendingSends = [];
window.milagre = new Proxy({
  getRuntimeConnection: async () => ({ connected: true }),
  getAgentPorts: async () => ({}),
  getRuns: async () => ({ seq: 0, runs: {} }),
  getLinkedWork: async () => ({ delegations: [], negotiations: [], receiveOnly: [] }),
  getCurrentProject: async () => ({ path: "/fixture", name: "shop", state: lean ? leanState() : structuredClone(state) }),
  // ?lean: a host that keeps messages by Chat (chat-pages-v1), paging them like chat:messages does.
  readChatMessages: async (_scope, chatId, { before, turns = 10, limit = 75 } = {}) => {
    window.calls.pages = (window.calls.pages ?? 0) + 1;
    if (window.holdPages) await new Promise(resolve => { window.releasePages = () => { window.holdPages = false; resolve(); }; });
    const chat = state.messages.filter((message) => message.session_id === chatId);
    let end = chat.length;
    const at = before === undefined ? -1 : chat.findIndex((message) => message.id === before);
    if (at >= 0) end = at;
    let start = end;
    let seen = 0;
    while (start > 0 && end - start < limit) {
      start--;
      if (chat[start].role === "user" && ++seen >= turns) break;
    }
    return structuredClone({ messages: chat.slice(start, end), hasMore: start > 0, total: chat.length });
  },
  listBranches: async () => ["main"],
  uploadAttachment: async request => ({ file: { path: "/fixture/uploads/" + request.name } }),
  getPathForFile: file => "/fixture/" + file.name,
  createWorktree: () => {
    window.calls.created++;
    return new Promise((resolve, reject) => {
      window.failCreate = () => reject(new Error("Setup failed"));
      window.finishCreate = () => {
        const id = state.next_id;
        state.worktrees[id] = { id, name: "milagre/chat-" + id, path: "/worktrees/shop/chat-" + id, project_id: 1, base: "main" };
        state.sessions[id + 1] = { id: id + 1, worktree_id: id, agent_name: "milagre/chat-" + id, status: "Created" };
        state.next_id = id + 2;
        resolve({ project: { path: "/fixture", name: "shop", state: structuredClone(state) }, worktreeId: id });
      };
    });
  },
  sendMessage: request => {
    window.calls.sent.push(request);
    const controls = {};
    window.pendingSends.push(controls);
    return new Promise((resolve, reject) => {
      controls.fail = window.failSend = (message = "Disk full") => reject(new Error(message));
      controls.save = window.saveSend = () => {
        const sessionId = request.sessionId ?? state.next_id++;
        state.sessions[sessionId] ??= { id: sessionId, worktree_id: request.worktreeId, agent_name: "Local chat", status: "Created" };
        state.sessions[sessionId].provider = request.provider;
        state.messages.push({ id: state.next_id++, session_id: sessionId, body: request.body, images: request.images, files: request.files, clientMessageId: request.clientMessageId, context: null, role: "user", model: request.model });
        const publish = () => listeners.forEach(listener => listener({ chatId: "/fixture#" + sessionId, event: { type: "message-sent", model: request.model }, state: lean ? leanState() : structuredClone(state) }));
        if (window.holdState) { window.holdState = false; window.releaseState = publish; } else publish();
        controls.ack = window.ackSend = () => resolve({ sessionId });
      };
    });
  },
  sendQueuedNow: async (chatId, id) => void (window.calls.queueSent ??= []).push([chatId, id]),
  removeQueued: async (chatId, id) => {
    (window.calls.queueRemoved ??= []).push([chatId, id]);
    const session = state.sessions[2];
    session.queued = session.queued.filter((item) => item.id !== id);
    listeners.forEach(listener => listener({ chatId, event: { type: "queue-changed" }, state: structuredClone(state) }));
    return true;
  },
  onAgentEvent: callback => { listeners.add(callback); return () => listeners.delete(callback); },
  listEditors: async () => [],
  getCachedUsage: async () => ({ providers: [] }),
  readUsage: async () => ({ providers: [] }),
  getUpdateState: async () => ({ status: "idle" }),
}, { get(target, key) { return target[key] ?? (String(key).startsWith("on") ? () => () => {} : async () => null); } });
localStorage.setItem("milagre-settings", JSON.stringify({ defaultModelId: "claude-opus-5-5" }));
const { default: App } = await import("/src/App");
if (new URLSearchParams(location.search).has("link")) {
  const { LinkWorkspace } = await import("/src/components/LinkWorkspace");
  const { createScopeDrafts } = await import("/src/lib/link-scope");
  const linkState = { next_id: 1, sessions: {}, messages: [], preparations: {} };
  const concurrentLinks = new URLSearchParams(location.search).has("concurrent");
  if (concurrentLinks) {
    for (const id of [1, 2]) linkState.sessions[id] = { id, title: "Shared Chat " + id, worktrees: [], provider: "claude" };
  }
  const opened = { link: { id: "11111111-1111-4111-8111-111111111111", name: "Shared work", projectIds: [], createdAt: "" }, state: linkState, projects: [] };
  const noop = () => {};
  const model = { id: "claude-opus-5-5", name: "Opus", provider: "claude" };
  window.milagre.sendLinkMessage = async request => {
    window.calls.sent.push(request);
    if (concurrentLinks) return new Promise((resolve, reject) => window.pendingSends.push({
      ack: () => resolve({ sessionId: request.sessionId }), fail: () => reject(new Error("Shared send failed")),
    }));
    if (window.calls.sent.length === 1) throw new Error("Milagre host is disconnected. Your command was not sent.");
    return { sessionId: 1 };
  };
  const root = createRoot(document.getElementById("root"));
  const drafts = createScopeDrafts();
  const renderLink = (selected = undefined) => root.render(<LinkWorkspace initialSessionId={selected}
    opened={opened} state={linkState} agents={{ runs: {} }} drafts={drafts}
    preferences={{ models: [model], selectedModel: model, modelForChat: () => model, showModel: noop, onModelChange: noop, cliStatus: {}, onModelPickerOpen: noop, onUpdateCli: noop,
      capability: { efforts: ["high"], ultracode: false, fastMode: false } }}
    hostConnection={{ connected: true }} saveScopes={[]} ports={{}} linkedWork={{ delegations: [], negotiations: [], receiveOnly: [] }}
    onSwitchProject={noop} onSwitchLink={noop} onLinkProject={noop} onEditLink={noop} onOpenProject={noop}
    onSettings={noop} onOpenAccounts={noop} onCanvasChat={noop}
  />);
  window.pickLinkChat = renderLink;
  renderLink(concurrentLinks ? 1 : undefined);
} else createRoot(document.getElementById("root")).render(<App />);
`;
