// How a chat is named, shared by the sidebar and the main process's notifications. Types: chats.d.mts.
export { pullRequestRefs, pullRequestRefsCache, chatPullRequests, createdPullRequestUrl, associatedPullRequest } from "./chat-pull-requests.mjs";
import { chatSummary, summarizeChat } from "./chat-summary.mjs";
import { promptTitle } from "./prompt-parts.mjs";

/** The same status palette for desktop and mobile chat lists. */
export function chatMarkTone(mark) {
  if (mark === "waiting" || mark === "interrupted") return "orange";
  if (mark === "failed") return "red";
  if (mark === "idle") return "ink3";
  return "accent";
}

/** A one-line title of at most 60 characters: a longer line keeps its first 57 and an ellipsis. */
export function shortTitle(line) {
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/** The chat's name: the one the user gave it, else the first line of its first message (from its summary when it has one), with image tokens named. */
export function chatTitle(session, messages = []) {
  if (session.title?.trim()) return session.title.trim();
  if (session.generatedTitle?.trim()) return session.generatedTitle.trim();
  const first = session.summary ? undefined : messages.find((message) => message.role !== "assistant" && message.body.trim());
  // A summary kept before it counted the first message's images has no count: its tokens all count.
  const line = session.summary
    ? promptTitle(session.summary.titleLine ?? "", session.summary.titleImages)
    : promptTitle(first?.body.trim().split("\n")[0] ?? "", first?.images?.length ?? 0);
  if (!line) return session.agent_name;
  return shortTitle(line);
}

/** A legacy handover chat (before in-place handoff) that is still being prepared or holds its brief as a draft: it is a live, provider-locked chat even with no messages. */
export function isHandoverChat(session) {
  return Boolean(session?.handoverPending) || session?.handoverDraft !== undefined;
}

/** A Chat a Routine's Run created and keeps out of the lists: hidden, and not waiting on an approval or question. */
export function isHiddenRunChat(session, waiting = false) {
  return session?.routine?.hidden === true && !waiting;
}

/**
 * The chat lists show a chat once it has a message, or while a handover prepares it; a worktree's empty starter chat stays
 * out. A hidden Run Chat stays out too, unless `waiting` says it waits on an approval or question.
 */
export function isListedChat(session, messageCount, waiting = false) {
  if (isHiddenRunChat(session, waiting)) return false;
  return messageCount > 0 || isHandoverChat(session);
}

/** Sorts pinned chats first, in their manual order; 0 for two unpinned chats, so the list's own order decides those. */
export function comparePins(a, b) {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
  return a.pinned ? (a.pin_order ?? 0) - (b.pin_order ?? 0) : 0;
}

/** The `pin_order` that puts a chat at `index` among pinned chats whose orders are `orders`, lowest first. */
export function pinOrderAt(orders, index) {
  const before = orders[index - 1],
    after = orders[index];
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return after - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

let nextPreviewId = -2;

/** A local message preview. It is never written into the Project's persisted state. */
export function createPendingChat({ state, worktreeId, sessionId = null, body, images = [], files = [], model, provider, context = null, clientMessageId }) {
  const id = nextPreviewId--;
  const session = state.sessions[sessionId] ?? {
    id,
    worktree_id: worktreeId,
    agent_name: state.worktrees?.[worktreeId]?.name || "New Chat",
    status: "Created",
    provider,
  };
  const message = {
    id,
    session_id: session.id,
    body,
    role: "user",
    context,
    images,
    files,
    model,
    clientMessageId: clientMessageId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${-id}`,
  };
  const messages = state.messages.filter((item) => item.session_id === session.id);
  return {
    session: { ...session, title: chatTitle(session, [...messages, message]) },
    message,
    startedAt: Date.now(),
    sortId: state.next_id,
    targetSessionId: sessionId,
  };
}

/**
 * Remembers the clientMessageId of a send that failed before the host answered, with what was put back in the
 * composer. The host may have saved that message and lost only the answer, so the same text sent again reuses the id
 * and the host recognises it instead of running it twice. Keyed by the composer (a Chat, or the new-Chat view).
 */
export function createResendMemory() {
  const failed = new Map();
  const signature = (body, attachments) => JSON.stringify([body, ...attachments]);
  return {
    /** Keeps `clientMessageId` for the next send of the same body and attachments from `key`. */
    remember(key, clientMessageId, body, attachments = []) {
      failed.set(key, { clientMessageId, signature: signature(body, attachments) });
    },
    /** The id to resend with, or undefined for a fresh message. Anything that differs from the failed send forgets it. */
    reuse(key, body, attachments = []) {
      const entry = failed.get(key);
      if (!entry) return undefined;
      if (entry.signature === signature(body, attachments)) return entry.clientMessageId;
      failed.delete(key);
      return undefined;
    },
    /** The send went through. */
    forget(key) {
      failed.delete(key);
    },
  };
}

/** The saved Chat may arrive over the live connection before the send response does. */
export function pendingChatSessionId(state, pending) {
  if (!pending) return null;
  const canonical = state.messages.find((message) => message.clientMessageId === pending.message.clientMessageId);
  if (canonical) return canonical.session_id;
  // A message sent while a turn that can't be steered runs waits in its Chat's queue.
  const queued = Object.values(state.sessions).find((session) => session.queued?.some((item) => item.clientMessageId === pending.message.clientMessageId));
  if (queued) return queued.id;
  // A window that holds no messages (chat-pages-v1) has each Chat's last sends in its summary.
  const summarized = Object.values(state.sessions).find((session) => session.summary?.clientMessageIds?.includes(pending.message.clientMessageId));
  if (summarized) return summarized.id;
  // Older hosts omit clientMessageId. Only use their persisted input after the send response
  // confirms its target; existing inputs and messages tagged by another client cannot match.
  if (pending.acceptedSessionId == null) return null;
  return (
    state.messages.find(
      (message) =>
        !message.clientMessageId &&
        message.session_id === pending.acceptedSessionId &&
        message.id >= pending.sortId &&
        message.role === "user" &&
        message.body === pending.message.body,
    )?.session_id ?? null
  );
}

/**
 * The open Chat's messages with a pending send's preview after them. The page of messages and the summary that names
 * the saved send (pendingChatSessionId) arrive separately, so a page that already holds the saved copy shows it alone.
 */
export function withPreview(messages, pending) {
  const id = pending.message.clientMessageId;
  return id && messages.some((message) => message.clientMessageId === id) ? messages : [...messages, pending.message];
}

/** A display projection shared by desktop's sidebar and the phone's drawer; canonical input replaces its preview. */
export function withPendingChat(state, pending) {
  if (!pending || pendingChatSessionId(state, pending) !== null) return state;
  const message = { ...pending.message, id: pending.sortId };
  const messages = [...state.messages, message];
  const session = state.sessions[pending.session.id] ?? pending.session;
  // The host may keep every saved message off the client. Extend its summary rather than replacing the Chat's
  // history with this one input, and keep settings that changed since the send began (pins, title, etc.).
  const saved = chatSummary(
    session,
    state.messages.filter((item) => item.session_id === session.id),
  );
  const summary = {
    ...summarizeChat([message]),
    ...saved,
    count: saved.count + 1,
    firstId: saved.firstId ?? pending.sortId,
    lastId: pending.sortId,
    lastAt: pending.startedAt,
    ...(message.model ? { lastModel: message.model } : {}),
    clientMessageIds: [...(saved.clientMessageIds ?? []), ...(message.clientMessageId ? [message.clientMessageId] : [])].slice(-5),
  };
  return { ...state, sessions: { ...state.sessions, [session.id]: { ...session, summary } }, messages };
}
