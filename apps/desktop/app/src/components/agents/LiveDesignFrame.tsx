import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { ARTIFACT_CSP, artifactDocument } from "@milagre/shared/artifact";
import { designLiveParts, type DesignDocument } from "@milagre/shared/design";
import { DESIGN_LIVE_RECEIVER_SCRIPT } from "@milagre/shared/design-draft";
import type { ArtifactRef } from "../../model";
import { AgentCursor } from "./AgentCursor";
import { finishLiveDesign, useDraftFrameShown, useLiveCrew, useLiveDesigns, type LiveDesign } from "./design-live";
import { SUBAGENT_TINTS, subagentPersona } from "./subagent-persona";

const LIVE_DOCUMENT = artifactDocument(
  `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:#fff}*{box-sizing:border-box}#design-root{position:relative;width:100%;height:100%}</style><style id="design-fonts"></style></head><body><main id="design-root"></main><script>${DESIGN_LIVE_RECEIVER_SCRIPT}</script></body></html>`,
);

type Parts = ReturnType<typeof designLiveParts>;

function useParts(document: DesignDocument | null): Parts | null {
  return useMemo(() => {
    if (!document) return null;
    try {
      return designLiveParts(document);
    } catch {
      return null;
    }
  }, [document]);
}

/** One iframe that stays for the whole piece of work and takes each new state of the design as a message. */
function LiveFrame({ parts, appeared, title, onPainted }: { parts: Parts | null; appeared: string[]; title: string; onPainted: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const sent = useRef<{ seq: number; fonts: string | null }>({ seq: 0, fonts: null });
  const painted = useRef(onPainted);
  painted.current = onPainted;
  useEffect(() => {
    const target = frame.current?.contentWindow;
    if (!ready || !parts || !target) return;
    const fontFaces = parts.fontFaces === sent.current.fonts ? undefined : parts.fontFaces;
    sent.current = { seq: sent.current.seq + 1, fonts: parts.fontFaces };
    target.postMessage(
      {
        type: "milagre:live-design",
        seq: sent.current.seq,
        markup: parts.markup,
        background: parts.background,
        width: parts.width,
        height: parts.height,
        fontFaces,
        appeared,
      },
      "*",
    );
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, parts]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== "milagre:live-painted") return;
      painted.current();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <iframe
      ref={frame}
      title={`${title}, being designed`}
      srcDoc={LIVE_DOCUMENT}
      sandbox="allow-scripts"
      {...{ csp: ARTIFACT_CSP }}
      referrerPolicy="no-referrer"
      tabIndex={-1}
      onLoad={() => setReady(true)}
      className="pointer-events-none block size-full border-0 bg-paper"
    />
  );
}

const AGENT_COLORS: Record<string, string> = { Claude: "#D97757", Codex: "#3941FF", Antigravity: "#3186FF" };
const agentColor = (agent: string) => AGENT_COLORS[agent] ?? "var(--color-accent)";

type Persona = { name: string; color: string; ink: string; task?: string };

function usePersona(chatId: string, by: string | undefined): Persona {
  const { agent, crew } = useLiveCrew(chatId);
  return useMemo(() => {
    if (!by) return { name: agent, color: agentColor(agent), ink: "#fff" };
    const persona = subagentPersona(crew, by);
    return persona
      ? { name: persona.name, color: SUBAGENT_TINTS[persona.color], ink: "#1d1d1f", task: persona.task }
      : { name: "Subagent", color: SUBAGENT_TINTS.mint, ink: "#1d1d1f" };
  }, [agent, crew, by]);
}

function cursorAt(parts: Parts | null, changed: string[], fallback: { x: number; y: number }) {
  let box: Parts["bounds"] extends Map<string, infer B> ? B | undefined : never;
  for (let index = changed.length - 1; index >= 0 && !box; index--) box = parts?.bounds.get(changed[index]!);
  if (!parts || !box) return { point: fallback, box: null };
  const x = Math.min(parts.width - 8, Math.max(8, box.x + box.width / 2));
  const y = Math.min(parts.height - 8, Math.max(8, box.y + box.height / 2));
  return { point: { x, y }, box };
}

function LiveWork({
  live,
  persona,
  width,
  height,
  scale,
  onPainted,
  painted,
}: {
  live: LiveDesign;
  persona: Persona;
  width: number;
  height: number;
  scale: number;
  onPainted: () => void;
  painted: boolean;
}) {
  const parts = useParts(live.document);
  const { color, name } = persona;
  const reduced = useReducedMotion();
  const { point, box } = cursorAt(parts, live.changed, { x: Math.min(width - 40, 56), y: Math.min(height - 40, 48) });
  const waiting = !parts?.markup;
  return (
    <>
      <div
        data-slot="live-design-frame"
        data-painted={painted || undefined}
        data-layers={live.document?.nodes.length ?? 0}
        className="absolute inset-0 overflow-hidden rounded-card border-2 bg-paper"
        style={{ borderColor: color, opacity: painted || live.blank ? 1 : 0 }}
      >
        <LiveFrame parts={parts} appeared={live.changed} title={live.title ?? "Design"} onPainted={onPainted} />
      </div>
      {box && painted && (
        <div
          aria-hidden
          data-slot="agent-cursor-target"
          className="pointer-events-none absolute rounded-inline"
          style={{
            left: box.x,
            top: box.y,
            width: box.width,
            height: box.height,
            outline: `${1.5 / scale}px solid ${color}`,
            transition: reduced
              ? undefined
              : "left var(--duration-base) var(--ease-enter), top var(--duration-base) var(--ease-enter), width var(--duration-base) var(--ease-enter), height var(--duration-base) var(--ease-enter)",
          }}
        />
      )}
      <AgentCursor
        x={point.x}
        y={point.y}
        scale={scale}
        color={color}
        ink={persona.ink}
        label={name}
        task={persona.task}
        note={waiting ? "Designing…" : undefined}
      />
      <span role="status" className="sr-only">
        {name} is {live.kind === "replay" && !live.blank ? "changing" : "designing"} {live.title ?? "a design"}
      </span>
    </>
  );
}

export function LiveDesignLayer({
  chatId,
  live,
  shown,
  savedPainted,
  width,
  height,
  scale,
}: {
  chatId: string;
  live: LiveDesign | null;
  shown: number | null;
  /** The saved version decoded as an image or loaded as an iframe. */
  savedPainted: boolean;
  width: number;
  height: number;
  scale: number;
}) {
  const persona = usePersona(chatId, live?.by);
  const layer = useRef<HTMLDivElement>(null);
  const [painted, setPainted] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const placeholder = !!live && live.kind === "draft" && live.status === "settling" && live.version === 1;
  const key = live?.key ?? null;
  const settledHere = !!live && live.status === "settling" && shown === live.version;
  useEffect(() => {
    if (!settledHere || !key || savedPainted) return;
    const fallback = setTimeout(() => setLeaving(key), 450);
    return () => clearTimeout(fallback);
  }, [settledHere, key, savedPainted]);
  const leavingHere = !!key && (leaving === key || (settledHere && savedPainted));
  useEffect(() => {
    if (!leavingHere || !key) return;
    const timer = setTimeout(() => finishLiveDesign(chatId, key), placeholder ? 0 : 220);
    return () => clearTimeout(timer);
  }, [leavingHere, key, chatId, placeholder]);
  if (!live || placeholder) return <div ref={layer} hidden />;
  return (
    <div
      ref={layer}
      data-slot="live-design"
      data-live={live.kind}
      className="pointer-events-none absolute inset-0 z-10 transition-opacity duration-base ease-enter"
      style={{ opacity: leavingHere ? 0 : 1 }}
    >
      <LiveWork
        live={live}
        persona={persona}
        width={width}
        height={height}
        scale={scale}
        painted={painted === live.key}
        onPainted={() => setPainted(live.key)}
      />
    </div>
  );
}

export function LiveDraftFrames({
  chatId,
  designs,
  group,
  orphans,
  scale,
  gap,
  header,
  onSized,
}: {
  chatId: string;
  designs: ArtifactRef[];
  group?: string | null;
  orphans?: (string | null)[];
  scale: number;
  gap: number;
  header: number;
  onSized: () => void;
}) {
  const { designs: lives } = useLiveDesigns(chatId);
  const known = new Set(designs.map((design) => design.id));
  const drafts = lives.filter((live) => {
    if (live.kind !== "draft" || live.tool === "design_apply") return false;
    const shown = live.status === "writing" ? !!live.document && (!live.designId || !known.has(live.designId)) : live.version === 1;
    if (!shown) return false;
    const row = live.group?.trim() || null;
    return orphans ? !orphans.includes(row) : row === (group ?? null);
  });
  if (!drafts.length) return null;
  const frames = drafts.map((live) => (
    <DraftFrame
      key={live.key}
      chatId={chatId}
      live={live}
      scale={scale}
      header={header}
      overlap={live.status === "settling" && !orphans && known.has(live.designId ?? "")}
      onSized={onSized}
    />
  ));
  return orphans ? (
    <div className="flex items-start" style={{ gap }}>
      {frames}
    </div>
  ) : (
    <>{frames}</>
  );
}

function DraftFrame({
  chatId,
  live,
  scale,
  header,
  overlap,
  onSized,
}: {
  chatId: string;
  live: LiveDesign;
  scale: number;
  header: number;
  overlap: boolean;
  onSized: () => void;
}) {
  const persona = usePersona(chatId, live.by);
  const width = live.document?.width ?? 390;
  const height = live.document?.height ?? 844;
  const [painted, setPainted] = useState(false);
  useLayoutEffect(onSized, [width, height, onSized]);
  useEffect(() => {
    if (live.status !== "settling" || overlap) return;
    const timer = setTimeout(() => finishLiveDesign(chatId, live.key), 600);
    return () => clearTimeout(timer);
  }, [live.status, live.key, overlap, chatId]);
  const self = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const element = self.current;
    const frame =
      overlap && live.designId
        ? element?.parentElement?.querySelector<HTMLElement>(`:scope > [data-slot=artifact-frame][data-artifact="${CSS.escape(live.designId)}"]`)
        : null;
    const body = frame?.querySelector<HTMLElement>("[data-design-body]");
    const mine = element?.querySelector<HTMLElement>("[data-draft-body]");
    if (!element || !frame || !body || !mine) {
      if (over) setOver(null);
      return;
    }
    const top = frame.offsetTop + (body.getBoundingClientRect().top - frame.getBoundingClientRect().top) / scale;
    const next = { left: frame.offsetLeft, top: top - (mine.getBoundingClientRect().top - element.getBoundingClientRect().top) / scale };
    if (!over || Math.abs(over.left - next.left) > 0.5 || Math.abs(over.top - next.top) > 0.5) setOver(next);
  });
  return (
    <div
      ref={self}
      data-slot="artifact-draft-frame"
      data-draft={live.key}
      className={`flex shrink-0 flex-col ${over ? "absolute" : "relative"}`}
      style={{ width, ...(over ? { left: over.left, top: over.top, zIndex: 1 } : {}) }}
    >
      <div className="relative shrink-0" style={{ height: header / scale }}>
        <div
          className="absolute bottom-0 left-0 flex origin-bottom-left items-center gap-1 overflow-hidden pb-1.5 text-12 text-ink"
          style={{ width: width * scale, height: header, transform: `scale(${1 / scale})` }}
        >
          <span className="size-1.5 shrink-0 animate-pulse rounded-full" style={{ background: persona.color }} aria-hidden />
          <span className="min-w-0 flex-1 truncate">{live.title ?? "New design"}</span>
          {live.status === "writing" && width * scale >= 200 && <span className="shrink-0 text-ink-3">{persona.name} is designing…</span>}
        </div>
      </div>
      <div data-draft-body className="relative bg-paper" style={{ width, height, borderRadius: 12 }}>
        {!painted && <div className="absolute inset-0 rounded-card border-2 border-dashed border-line bg-surface" />}
        <LiveWork live={live} persona={persona} width={width} height={height} scale={scale} painted={painted} onPainted={() => setPainted(true)} />
      </div>
    </div>
  );
}

export function LiveDesignWaiting({ chatId }: { chatId: string }) {
  const { agent } = useLiveDesigns(chatId);
  if (useDraftFrameShown(chatId)) return null;
  return (
    <div data-slot="artifact-canvas-waiting" role="status" className="pointer-events-none absolute inset-0 grid place-items-center">
      <span className="flex items-center gap-2 text-13 text-ink-3">
        <span className="size-1.5 animate-pulse rounded-full" style={{ background: agentColor(agent) }} aria-hidden />
        {agent} is designing…
      </span>
    </div>
  );
}
