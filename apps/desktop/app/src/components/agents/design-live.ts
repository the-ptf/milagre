import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { createDesignDraft, designReplay, parsePartialJson, type DesignDraft } from "@milagre/shared/design-draft";
import type { DesignDocument } from "@milagre/shared/design";
import type { ArtifactRef } from "../../model";
import { stateEvents, type AgentEventUpdate } from "../../lib/state-events";
import { readArtifact } from "./ArtifactCanvas";
import { DESIGN_SAVED, type DesignSaved } from "./DesignEditor";

/**
 * The agent at work on the Designs canvas, like a collaborator's cursor in Figma or Pencil. Two sources:
 *
 * - Draft: Claude's design_show / design_apply input as the model writes it (step-draft events, design-drafts.cjs). The
 *   design builds layer by layer as the JSON arrives, then hands over to the saved version when the step completes.
 * - Replay: an agent whose input doesn't stream (Codex, Antigravity), or a Claude call no draft was seen for. When a
 *   design's frame follows the newest version and a new one lands, the change plays back from the version before it,
 *   layer by layer in under two seconds, while the frame holds the old version; then it settles on the saved one.
 *
 * Each running piece of work is a LiveDesign, kept per Chat until its frame shows the saved version.
 */
export type LiveDesign = {
  key: string;
  kind: "draft" | "replay";
  /** A draft's tool: a design_apply draft changes a design the canvas has, never a new one. */
  tool?: "design_show" | "design_apply";
  /** The design worked on, once known: a new design_show names its id only at the end, or not at all. */
  designId: string | null;
  title: string | null;
  group: string | null;
  /** What shows now; null until there is anything to render. */
  document: DesignDocument | null;
  /** The layers the last update added or changed: the cursor goes to the last. */
  changed: string[];
  /** Writing (or playing back), or done and waiting for the frame to show `version`. */
  status: "writing" | "settling";
  version?: number;
  /** The version the frame keeps showing while a replay runs. */
  hold?: number;
};

type Draft = {
  live: LiveDesign;
  tool: "design_show" | "design_apply";
  input: string;
  reader: DesignDraft;
  base: { key: string; document: DesignDocument | null } | null;
  timer: ReturnType<typeof setTimeout> | null;
};

type ChatLive = {
  agent: string;
  designs: LiveDesign[];
  drafts: Map<string, Draft>;
  replays: Map<string, ReturnType<typeof setTimeout>>;
  /** How many views follow the Chat (useLiveDesignFeed): a draft nobody follows keeps its text but isn't read. */
  watched: number;
  /** Design tool calls running that no draft shows (Codex, Antigravity), by step id. */
  running: Set<string>;
  /** The design tool calls already announced to useDesignWorkStarted, by id, for the turn. */
  announced: Set<string>;
};

const chats = new Map<string, ChatLive>();
const listeners = new Set<() => void>();
const EMPTY: LiveDesign[] = [];
// Versions that need no replay: a draft showed them being written, or the user saved them in the editor.
const covered = new Set<string>();
const versionKey = (chatId: string, id: string, version: number) => `${chatId}\n${id}\n${version}`;
// At most every this often a draft renders again.
const DRAFT_RENDER_MS = 100;
// A replay's whole length, and each step's bounds.
const REPLAY_MS = 1800;
const STEP_MIN_MS = 80;
const STEP_MAX_MS = 150;
// A finished piece of work that the frame never confirms is dropped after this long.
const SETTLE_TIMEOUT_MS = 4000;

function chatLive(chatId: string): ChatLive {
  let chat = chats.get(chatId);
  if (!chat) {
    chat = { agent: "Agent", designs: EMPTY, drafts: new Map(), replays: new Map(), watched: 0, running: new Set(), announced: new Set() };
    chats.set(chatId, chat);
  }
  return chat;
}

function emit() {
  for (const listener of listeners) listener();
}

/** Replaces a LiveDesign (or adds it), keeping the Chat's list a new array so React sees the change. */
function put(chatId: string, live: LiveDesign) {
  const chat = chatLive(chatId);
  const index = chat.designs.findIndex((item) => item.key === live.key);
  chat.designs = index === -1 ? [...chat.designs, live] : chat.designs.map((item, at) => (at === index ? live : item));
  emit();
}

function drop(chatId: string, key: string) {
  const chat = chats.get(chatId);
  if (!chat) return;
  const draft = chat.drafts.get(key);
  if (draft?.timer) clearTimeout(draft.timer);
  chat.drafts.delete(key);
  const timer = chat.replays.get(key);
  if (timer) clearTimeout(timer);
  chat.replays.delete(key);
  if (!chat.designs.some((item) => item.key === key)) return;
  chat.designs = chat.designs.filter((item) => item.key !== key);
  if (!chat.designs.length) chat.designs = EMPTY;
  emit();
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// --- Drafts ---

function render(chatId: string, draft: Draft) {
  draft.timer = null;
  const chat = chats.get(chatId);
  // Read once a view follows the Chat: until then the text only gathers (useLiveDesignFeed reads it on mount).
  if (chat?.drafts.get(draft.live.key) !== draft || !chat.watched) return;
  // design_apply builds on the version it names; it's read once its id and version have streamed in.
  if (draft.tool === "design_apply" && !draft.base) {
    const value = parsePartialJson(draft.input) as { id?: unknown; expectedVersion?: unknown } | undefined;
    if (typeof value?.id === "string" && Number.isInteger(value.expectedVersion)) {
      const base: Draft["base"] = { key: `${value.id}:${value.expectedVersion}`, document: null };
      draft.base = base;
      readArtifact(chatId, value.id, value.expectedVersion as number)
        .then((artifact) => {
          if (artifact.format !== "design" || !artifact.document) return false;
          base.document = artifact.document;
          schedule(chatId, draft, true);
          return true;
        })
        .catch(() => drop(chatId, draft.live.key));
    }
  }
  const snapshot = draft.reader.read(draft.input, draft.base?.document ?? null);
  const live = draft.live;
  const designId = live.status === "settling" ? live.designId : (snapshot.designId ?? live.designId);
  const next: LiveDesign = {
    ...live,
    designId,
    title: snapshot.title ?? live.title,
    group: snapshot.group ?? live.group,
    document: snapshot.document,
    changed: snapshot.changed.length ? snapshot.changed : live.changed,
  };
  if (next.document === live.document && next.designId === live.designId && next.title === live.title && next.group === live.group) return;
  draft.live = next;
  put(chatId, next);
}

function schedule(chatId: string, draft: Draft, now = false) {
  if (now) {
    if (draft.timer) clearTimeout(draft.timer);
    render(chatId, draft);
  } else if (!draft.timer) draft.timer = setTimeout(() => render(chatId, draft), DRAFT_RENDER_MS);
}

// --- The agent starting to design ---

const starters = new Set<(chatId: string) => void>();

/** Tells useDesignWorkStarted once per tool call that the agent started designing in the Chat. */
function announce(chat: ChatLive, chatId: string, id: string) {
  if (chat.announced.has(id)) return;
  chat.announced.add(id);
  for (const starter of starters) starter(chatId);
}

/**
 * The design tool a step that just started runs, for an agent whose input doesn't stream: Codex's artifact steps name
 * it, Antigravity's steps say it in their title. An artifact page (artifact_show) isn't a design.
 */
function designToolOf(step: { kind: string; title: string; tool?: string }) {
  if (step.kind === "artifact") return step.tool === "design_show" || step.tool === "design_apply" ? step.tool : null;
  return step.kind === "other" && /^Used\b/.test(step.title) ? (/design_(show|apply)\b/.exec(step.title)?.[0] ?? null) : null;
}

function receive(chatId: string, event: AgentEventUpdate["event"]) {
  if (event.type === "step-draft" && event.offset === 0 && !chats.get(chatId)?.drafts.has(event.id)) chatLive(chatId);
  if (event.type === "step-started" && designToolOf(event.step)) chatLive(chatId);
  const chat = chats.get(chatId);
  if (!chat) return;
  if (event.type === "step-started") {
    if (!designToolOf(event.step) || chat.drafts.has(event.step.id)) return;
    chat.running.add(event.step.id);
    emit();
    announce(chat, chatId, event.step.id);
    return;
  }
  if (event.type === "step-draft") {
    let draft = chat.drafts.get(event.id);
    if (!draft && event.offset === 0) {
      draft = {
        live: { key: event.id, kind: "draft", tool: event.tool, designId: null, title: null, group: null, document: null, changed: [], status: "writing" },
        tool: event.tool,
        input: "",
        reader: createDesignDraft(event.tool),
        base: null,
        timer: null,
      };
      chat.drafts.set(event.id, draft);
      put(chatId, draft.live);
      announce(chat, chatId, event.id);
    }
    if (!draft) return;
    // A piece missed (a window opened mid-call) leaves nothing to build on.
    if (event.offset !== draft.input.length) return drop(chatId, event.id);
    draft.input += event.text;
    schedule(chatId, draft, event.done === true);
    return;
  }
  if (event.type === "step-completed") {
    if (chat.running.delete(event.id)) emit();
    const draft = chat.drafts.get(event.id);
    if (!draft) return;
    const artifact = (event as { artifact?: ArtifactRef }).artifact;
    if (event.status !== "done" || !artifact) return drop(chatId, event.id);
    covered.add(versionKey(chatId, artifact.id, artifact.version));
    // Nobody watched it being written: the saved version just shows when the Chat does.
    if (!chat.watched) return drop(chatId, event.id);
    schedule(chatId, draft, true);
    draft.live = {
      ...draft.live,
      designId: artifact.id,
      title: artifact.title,
      group: artifact.group ?? draft.live.group,
      status: "settling",
      version: artifact.version,
    };
    put(chatId, draft.live);
    setTimeout(() => drop(chatId, event.id), SETTLE_TIMEOUT_MS);
    return;
  }
  if (event.type === "turn-completed" || event.type === "turn-failed" || event.type === "turn-cancelled") {
    for (const draft of chat.drafts.values()) if (draft.live.status === "writing") drop(chatId, draft.live.key);
    chat.announced.clear();
    if (chat.running.size) {
      chat.running.clear();
      emit();
    }
  }
}

// --- Replays ---

function replay(chatId: string, id: string, from: number, to: number) {
  const key = `replay:${id}:${to}`;
  const chat = chatLive(chatId);
  put(chatId, { key, kind: "replay", designId: id, title: null, group: null, document: null, changed: [], status: "writing", hold: from });
  const stop = () => drop(chatId, key);
  void Promise.all([readArtifact(chatId, id, from), readArtifact(chatId, id, to)])
    .then(([before, after]) => {
      if (before.format !== "design" || after.format !== "design" || !before.document || !after.document) return stop();
      const steps = designReplay(before.document, after.document);
      if (!steps.length || !chat.designs.some((item) => item.key === key)) return stop();
      const each = Math.min(STEP_MAX_MS, Math.max(STEP_MIN_MS, REPLAY_MS / steps.length));
      const base: LiveDesign = {
        key,
        kind: "replay",
        designId: id,
        title: after.title,
        group: after.group ?? null,
        document: before.document,
        changed: [],
        status: "writing",
        hold: from,
      };
      put(chatId, base);
      let index = 0;
      const next = () => {
        if (!chat.designs.some((item) => item.key === key)) return;
        const step = steps[index++];
        if (!step) {
          // Played: the frame lets go of the old version and shows the saved one under the last step.
          put(chatId, { ...base, document: steps.at(-1)!.document, changed: steps.at(-1)!.changed, status: "settling", version: to, hold: undefined });
          chat.replays.set(key, setTimeout(stop, SETTLE_TIMEOUT_MS));
          return;
        }
        put(chatId, { ...base, document: step.document, changed: step.changed });
        chat.replays.set(key, setTimeout(next, each));
      };
      // The old version paints first, then the change plays over it.
      chat.replays.set(key, setTimeout(next, 200));
      return steps.length;
    })
    .catch(stop);
}

if (typeof window !== "undefined")
  window.addEventListener(DESIGN_SAVED, (event) => {
    const { chatId, artifact } = (event as CustomEvent<DesignSaved>).detail;
    covered.add(versionKey(chatId, artifact.id, artifact.version));
  });

// --- Hooks ---

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let following = false;

/**
 * Gathers every Chat's design drafts from the first piece, once any Chat's replies are on screen: a Chat opened or a
 * canvas docked mid-call still has the whole draft to build from.
 */
function follow() {
  if (following) return;
  following = true;
  stateEvents.onAgentEvent((update) => {
    // A draft that can't be followed only loses its animation: the other listeners still get the event.
    try {
      receive(update.chatId, update.event);
    } catch (error) {
      console.warn("Milagre couldn't follow a design draft:", error);
    }
  });
}

/** Follows the Chat's design drafts while its replies are on screen. `agent` names the agent for its cursor. */
export function useLiveDesignFeed(chatId: string | null, agent: string) {
  useEffect(() => {
    if (!chatId) return;
    chatLive(chatId).agent = agent;
  }, [chatId, agent]);
  useEffect(() => {
    follow();
    if (!chatId) return;
    const chat = chatLive(chatId);
    chat.watched++;
    // The drafts gathered before the Chat was on screen build now.
    for (const draft of chat.drafts.values()) if (draft.live.status === "writing") schedule(chatId, draft, true);
    return () => {
      chat.watched--;
    };
  }, [chatId]);
}

/**
 * Calls `onStart` each time the agent starts designing in the Chat (a draft begins, or a design tool starts for an agent
 * that doesn't stream its input), once per tool call, and on mount while it is designing.
 */
export function useDesignWorkStarted(chatId: string | null, onStart: () => void) {
  const latest = useRef(onStart);
  latest.current = onStart;
  useEffect(() => {
    if (!chatId) return;
    follow();
    const starter = (id: string) => id === chatId && latest.current();
    starters.add(starter);
    const chat = chats.get(chatId);
    if (chat && (chat.running.size || [...chat.drafts.values()].some((draft) => draft.live.status === "writing"))) latest.current();
    return () => {
      starters.delete(starter);
    };
  }, [chatId]);
}

const designing = (chatId: string | null) => {
  const chat = chatId ? chats.get(chatId) : undefined;
  return !!chat && (chat.designs.length > 0 || chat.drafts.size > 0 || chat.running.size > 0);
};

/** Whether the agent is at work on the Chat's designs: the canvas stays open for it before the Chat has any design. */
export function useDesignWorkActive(chatId: string | null) {
  return useSyncExternalStore(subscribe, () => designing(chatId));
}

/** Whether a new design's placeholder frame is on the canvas: until one is, an empty canvas says the agent is at work. */
export function useDraftFrameShown(chatId: string) {
  return useSyncExternalStore(subscribe, () =>
    (chats.get(chatId)?.designs ?? EMPTY).some((live) => live.kind === "draft" && live.tool !== "design_apply" && !!live.document),
  );
}

/** Every piece of work going on in the Chat's designs, and the agent's name. */
export function useLiveDesigns(chatId: string | null): { designs: LiveDesign[]; agent: string } {
  const designs = useSyncExternalStore(subscribe, () => (chatId ? (chats.get(chatId)?.designs ?? EMPTY) : EMPTY));
  return { designs, agent: (chatId && chats.get(chatId)?.agent) || "Agent" };
}

/**
 * The work going on in one design's frame, and the version the frame should load: the one a replay holds while it
 * plays. A new version the frame follows starts a replay unless a draft showed it being written, the user saved it,
 * motion is reduced or the window can't be seen.
 */
export function useLiveDesign(chatId: string, design: ArtifactRef, following: boolean): { live: LiveDesign | null; hold: number | null } {
  // Only this design's work: the other frames don't render again as it changes.
  const live = useSyncExternalStore(subscribe, () => latestFor(chats.get(chatId)?.designs ?? EMPTY, design.id));
  const seen = useRef(design.version);
  useLayoutEffect(() => {
    const previous = seen.current;
    seen.current = design.version;
    if (design.version <= previous || !following || design.format !== "design") return;
    if (covered.has(versionKey(chatId, design.id, design.version))) return;
    if (reducedMotion() || document.visibilityState !== "visible") return;
    if (chats.get(chatId)?.designs.some((item) => item.designId === design.id)) return;
    replay(chatId, design.id, previous, design.version);
  }, [chatId, design.id, design.version, design.format, following]);
  return { live, hold: live?.hold ?? null };
}

const latestFor = (designs: LiveDesign[], id: string) => {
  for (let index = designs.length - 1; index >= 0; index--) if (designs[index]!.designId === id) return designs[index]!;
  return null;
};

/** The frame showed the saved version: the work is done. */
export function finishLiveDesign(chatId: string, key: string) {
  drop(chatId, key);
}
