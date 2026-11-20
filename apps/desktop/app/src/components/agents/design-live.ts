import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { createDesignDraft, designReplay, parsePartialJson, type DesignDraft } from "@milagre/shared/design-draft";
import type { DesignDocument } from "@milagre/shared/design";
import type { ArtifactRef, Subagent } from "../../model";
import { stateEvents, type AgentEventUpdate } from "../../lib/state-events";
import { readArtifact } from "./ArtifactCanvas";

export type LiveDesign = {
  key: string;
  kind: "draft" | "replay";
  tool?: "design_show" | "design_apply";
  designId: string | null;
  title: string | null;
  group: string | null;
  document: DesignDocument | null;
  changed: string[];
  status: "writing" | "settling";
  version?: number;
  hold?: number;
  by?: string;
  blank?: boolean;
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
  watched: number;
  running: Set<string>;
  announced: Set<string>;
  callers: Map<string, string>;
  crew: readonly Subagent[];
};

const chats = new Map<string, ChatLive>();
const listeners = new Set<() => void>();
const EMPTY: LiveDesign[] = [];
const NO_CREW: readonly Subagent[] = [];
const covered = new Set<string>();
const versionKey = (chatId: string, id: string, version: number) => `${chatId}\n${id}\n${version}`;
const savedBy = new Map<string, string>();
const landed = new Map<string, number>();
const DRAFT_RENDER_MS = 100;
const REPLAY_MS = 1800;
const STEP_MIN_MS = 80;
const STEP_MAX_MS = 150;
const SETTLE_TIMEOUT_MS = 4000;
const LANDED_MS = 10_000;

function chatLive(chatId: string): ChatLive {
  let chat = chats.get(chatId);
  if (!chat) {
    chat = {
      agent: "Agent",
      designs: EMPTY,
      drafts: new Map(),
      replays: new Map(),
      watched: 0,
      running: new Set(),
      announced: new Set(),
      callers: new Map(),
      crew: NO_CREW,
    };
    chats.set(chatId, chat);
  }
  return chat;
}

function emit() {
  for (const listener of listeners) listener();
}

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

function render(chatId: string, draft: Draft) {
  draft.timer = null;
  const chat = chats.get(chatId);
  if (chat?.drafts.get(draft.live.key) !== draft || !chat.watched) return;
  if (!draft.base) {
    const value = parsePartialJson(draft.input) as { id?: unknown; expectedVersion?: unknown; from?: { id?: unknown; version?: unknown } } | undefined;
    const source =
      draft.tool === "design_apply"
        ? typeof value?.id === "string" && Number.isInteger(value.expectedVersion)
          ? { id: value.id, version: value.expectedVersion as number }
          : null
        : typeof value?.from?.id === "string" && /"from"\s*:\s*\{[^{}]*\}/.test(draft.input)
          ? { id: value.from.id, version: Number.isInteger(value.from.version) ? (value.from.version as number) : null }
          : null;
    if (source) {
      const base: Draft["base"] = { key: `${source.id}:${source.version ?? "latest"}`, document: null };
      draft.base = base;
      readArtifact(chatId, source.id, source.version)
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

const starters = new Set<(chatId: string) => void>();

function announce(chat: ChatLive, chatId: string, id: string) {
  if (chat.announced.has(id)) return;
  chat.announced.add(id);
  for (const starter of starters) starter(chatId);
}

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
    if (!designToolOf(event.step)) return;
    if (event.step.agent) chat.callers.set(event.step.id, event.step.agent);
    if (chat.drafts.has(event.step.id)) return;
    chat.running.add(event.step.id);
    emit();
    announce(chat, chatId, event.step.id);
    return;
  }
  if (event.type === "step-draft") {
    let draft = chat.drafts.get(event.id);
    if (!draft && event.offset === 0) {
      draft = {
        live: {
          key: event.id,
          kind: "draft",
          tool: event.tool,
          designId: null,
          title: null,
          group: null,
          document: null,
          changed: [],
          status: "writing",
          ...(event.agent ? { by: event.agent } : {}),
        },
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
    if (event.offset !== draft.input.length) return drop(chatId, event.id);
    draft.input += event.text;
    schedule(chatId, draft, event.done === true);
    return;
  }
  if (event.type === "step-completed") {
    if (chat.running.delete(event.id)) emit();
    const artifact = (event as { artifact?: ArtifactRef }).artifact;
    const caller = chat.callers.get(event.id);
    chat.callers.delete(event.id);
    if (caller && artifact && event.status === "done") savedBy.set(versionKey(chatId, artifact.id, artifact.version), caller);
    const draft = chat.drafts.get(event.id);
    if (!draft) {
      if (artifact?.version === 1 && event.status === "done") landed.set(versionKey(chatId, artifact.id, 1), Date.now());
      return;
    }
    if (event.status !== "done" || !artifact) return drop(chatId, event.id);
    covered.add(versionKey(chatId, artifact.id, artifact.version));
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

function replay(chatId: string, id: string, from: number | null, to: number) {
  const key = `replay:${id}:${to}`;
  const chat = chatLive(chatId);
  const by = savedBy.get(versionKey(chatId, id, to));
  const who = { ...(by ? { by } : {}), ...(from === null ? { blank: true } : { hold: from }) };
  put(chatId, { key, kind: "replay", designId: id, title: null, group: null, document: null, changed: [], status: "writing", ...who });
  const stop = () => drop(chatId, key);
  void Promise.all([from === null ? null : readArtifact(chatId, id, from), readArtifact(chatId, id, to)])
    .then(([before, after]) => {
      if (after.format !== "design" || !after.document) return stop();
      const start = before === null ? { ...after.document, nodes: [] } : before.format === "design" ? before.document : null;
      if (!start) return stop();
      const steps = designReplay(start, after.document);
      if (!steps.length || !chat.designs.some((item) => item.key === key)) return stop();
      const each = Math.min(STEP_MAX_MS, Math.max(STEP_MIN_MS, REPLAY_MS / steps.length));
      const base: LiveDesign = {
        key,
        kind: "replay",
        designId: id,
        title: after.title,
        group: after.group ?? null,
        document: start,
        changed: [],
        status: "writing",
        ...who,
      };
      put(chatId, base);
      let index = 0;
      const next = () => {
        if (!chat.designs.some((item) => item.key === key)) return;
        const step = steps[index++];
        if (!step) {
          put(chatId, { ...base, document: steps.at(-1)!.document, changed: steps.at(-1)!.changed, status: "settling", version: to, hold: undefined });
          chat.replays.set(key, setTimeout(stop, SETTLE_TIMEOUT_MS));
          return;
        }
        put(chatId, { ...base, document: step.document, changed: step.changed });
        chat.replays.set(key, setTimeout(next, each));
      };
      chat.replays.set(key, setTimeout(next, 200));
      return steps.length;
    })
    .catch(stop);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let gathering = false;

function follow() {
  if (gathering) return;
  gathering = true;
  stateEvents.onAgentEvent((update) => {
    try {
      receive(update.chatId, update.event);
    } catch (error) {
      console.warn("Milagre couldn't follow a design draft:", error);
    }
  });
}

export function useLiveDesignFeed(chatId: string | null, agent: string, crew: readonly Subagent[] = NO_CREW) {
  useEffect(() => {
    if (!chatId) return;
    const chat = chatLive(chatId);
    if (chat.agent === agent && chat.crew === crew) return;
    chat.agent = agent;
    chat.crew = crew;
    emit();
  }, [chatId, agent, crew]);
  useEffect(() => {
    follow();
    if (!chatId) return;
    const chat = chatLive(chatId);
    chat.watched++;
    for (const draft of chat.drafts.values()) if (draft.live.status === "writing") schedule(chatId, draft, true);
    return () => {
      chat.watched--;
    };
  }, [chatId]);
}

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

export function useDesignWorkActive(chatId: string | null) {
  return useSyncExternalStore(subscribe, () => designing(chatId));
}

export function useDraftFrameShown(chatId: string) {
  return useSyncExternalStore(subscribe, () =>
    (chats.get(chatId)?.designs ?? EMPTY).some((live) => live.kind === "draft" && live.tool !== "design_apply" && !!live.document),
  );
}

export function useLiveDesigns(chatId: string | null): { designs: LiveDesign[]; agent: string } {
  const designs = useSyncExternalStore(subscribe, () => (chatId ? (chats.get(chatId)?.designs ?? EMPTY) : EMPTY));
  return { designs, agent: (chatId && chats.get(chatId)?.agent) || "Agent" };
}

export function useLiveCrew(chatId: string): { agent: string; crew: readonly Subagent[] } {
  const agent = useSyncExternalStore(subscribe, () => chats.get(chatId)?.agent || "Agent");
  const crew = useSyncExternalStore(subscribe, () => chats.get(chatId)?.crew ?? NO_CREW);
  return { agent, crew };
}

export function useLiveDesign(chatId: string, design: ArtifactRef, following: boolean): { live: LiveDesign | null; hold: number | null } {
  const live = useSyncExternalStore(subscribe, () => latestFor(chats.get(chatId)?.designs ?? EMPTY, design.id));
  const seen = useRef(design.version);
  useLayoutEffect(() => {
    if (design.version !== 1 || !following || design.format !== "design") return;
    const key = versionKey(chatId, design.id, 1);
    const at = landed.get(key);
    landed.delete(key);
    if (at === undefined || Date.now() - at > LANDED_MS || covered.has(key) || reducedMotion() || document.visibilityState !== "visible") return;
    if (chats.get(chatId)?.designs.some((item) => item.designId === design.id)) return;
    replay(chatId, design.id, null, 1);
  }, [chatId, design.id, design.version, design.format, following]);
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

export function finishLiveDesign(chatId: string, key: string) {
  drop(chatId, key);
}
