const { randomUUID } = require("node:crypto");
const { activityContent } = require("@milagre/shared/live-activity");
const { chatTitle } = require("@milagre/shared/chats");
const { projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function device(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw Error("Invalid Live Activity Device");
  return value;
}
function activityMode(value = "all") {
  if (value !== "all" && value !== "questions") throw Error("Invalid Live Activity display mode");
  return value;
}

function createLiveActivity({ snapshot, answer, now = Date.now, newId = randomUUID }) {
  const targets = new Map();
  const drafts = new Map();
  const sending = new Set();
  const completed = new Set();
  const routes = new Map();
  function refresh() {
    const snap = snapshot();
    const runs = snap.runs?.runs ?? snap.runs ?? {};
    const scopes = new Map((snap.projects ?? []).map((p) => [p.path, p.state]));
    for (const link of snap.links ?? []) scopes.set(`milagre-link:${link.linkId}`, link.state);
    const chats = [];
    const seen = new Set();
    for (const [scope, state] of scopes) {
      for (const session of Object.values(state?.sessions ?? {})) {
        const chatId = `${scope}#${session.id}`;
        if (runs[chatId] || !(session.subagents ?? []).some((child) => !child.archived && ["initializing", "running"].includes(child.status))) continue;
        chats.push({
          key: chatId,
          title: chatTitle(
            session,
            (state.messages ?? []).filter((m) => m.session_id === session.id),
          ),
          working: false,
          subagents: session.subagents,
        });
      }
    }
    for (const [chatId, run] of Object.entries(runs)) {
      const state = scopes.get(projectOfKey(chatId));
      const session = state?.sessions?.[sessionIdFromKey(chatId)];
      if (!session) continue;
      const title = chatTitle(
        session,
        (state.messages ?? []).filter((m) => m.session_id === session.id),
      );
      chats.push({ key: chatId, title, working: !run.questions?.length && !run.approvals?.length, subagents: session.subagents });
      for (const [kind, requests] of [
        ["question", run.questions ?? []],
        ["approval", run.approvals ?? []],
      ]) {
        for (const request of requests) {
          const key = JSON.stringify([chatId, run.startedAt, kind, request]);
          seen.add(key);
          if (completed.has(key)) continue;
          let item = targets.get(key);
          if (!item) {
            if (targets.size >= 256) continue;
            item = { target: newId(), source: key, chatId, title, at: now(), kind, request };
            targets.set(key, item);
            routes.set(item.target, { chatId, requestId: request.requestId, at: now() });
            if (routes.size > 512) routes.delete(routes.keys().next().value);
          }
          item.title = title;
        }
      }
    }
    for (const [key, item] of targets)
      if (!seen.has(key)) {
        targets.delete(key);
        for (const draft of drafts.values()) draft.delete(item.target);
      }
    for (const key of completed) if (!seen.has(key)) completed.delete(key);
    return { chats, pending: [...targets.values()] };
  }
  function values(deviceId) {
    device(deviceId);
    const current = refresh();
    const held = drafts.get(deviceId);
    return { ...current, pending: current.pending.map((item) => ({ ...item, answers: held?.get(item.target) ?? {} })), now: now() };
  }
  return {
    state({ deviceId, mode } = {}) {
      return activityContent({ ...values(deviceId), mode: activityMode(mode) });
    },
    open({ deviceId, target } = {}) {
      const item = values(deviceId).pending.find((p) => p.target === target);
      const route = routes.get(target);
      if (!item && (!route || now() - route.at > 600000)) throw Error("This activity has expired. Open the computer to find its Chat.");
      const chatId = item?.chatId ?? route.chatId;
      return {
        projectPath: projectOfKey(chatId),
        sessionId: sessionIdFromKey(chatId),
        answers: item?.answers ?? {},
        requestId: item?.request.requestId ?? route.requestId,
      };
    },
    async choose({ deviceId, target, position, option, mode } = {}) {
      device(deviceId);
      mode = activityMode(mode);
      const busy = `${deviceId}:${target}`;
      if (sending.has(busy)) throw Error("An answer is already being sent.");
      const current = values(deviceId);
      const item = current.pending.find((p) => p.target === target);
      if (!item) throw Error("This Chat is no longer waiting for that question.");
      const content = activityContent({ ...current, pending: [item] });
      const shown = content.question;
      if (!shown.canAnswer) throw Error("Open Chat to answer this question.");
      if (position !== shown.position) throw Error("The question changed. Check Chat before answering.");
      if (!Number.isInteger(option) || !shown.choices.some((c) => c.index === option)) throw Error("Invalid answer choice.");
      const questions = item.request.questions;
      const q = questions[position - 1];
      const answers = { ...item.answers, [q.id]: [q.options[option].label] };
      let held = drafts.get(deviceId);
      if (!held) {
        if (drafts.size >= 32) throw Error("Too many Live Activity Devices.");
        held = new Map();
        drafts.set(deviceId, held);
      }
      if (questions.some((question) => !answers[question.id]?.length)) {
        held.set(target, answers);
        return { status: "draft", content: this.state({ deviceId, mode }) };
      }
      held.set(target, answers);
      sending.add(busy);
      try {
        const summary = questions
          .map((question) => `${question.header || question.question}: ${question.secret ? "[hidden answer]" : answers[question.id].join(", ")}`)
          .join("\n");
        const accepted = await answer({ chatId: item.chatId, requestId: item.request.requestId, answers, summary });
        if (accepted) {
          completed.add(item.source);
          targets.delete(item.source);
          for (const draft of drafts.values()) draft.delete(target);
        }
        return { status: accepted ? "accepted" : "rejected", content: this.state({ deviceId, mode }) };
      } finally {
        sending.delete(busy);
      }
    },
    forget(deviceId) {
      device(deviceId);
      drafts.delete(deviceId);
    },
    clear() {
      targets.clear();
      drafts.clear();
      completed.clear();
      routes.clear();
    },
  };
}
module.exports = { createLiveActivity };
