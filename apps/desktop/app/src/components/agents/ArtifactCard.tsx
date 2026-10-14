import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowExpand01Icon,
  ArrowShrink01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Comment01Icon,
  FitToScreenIcon,
  MinusSignIcon,
  Add01Icon,
  PaintBoardIcon,
  File01Icon,
} from "@hugeicons/core-free-icons";
import {
  chosenDesign,
  designActivity,
  designFeedbackMessage,
  designFeedbackText,
  newCommentId,
  parseDesignFeedback,
  resolutionNotes,
  type DesignComment,
} from "@milagre/shared/artifact";
import type { ArtifactRef, ChatStep } from "../../model";
import Tooltip from "../primitives/Tooltip";
import { DESIGNS_EXPANDED, dockLayer, useDockArea, useSidePanelRoom } from "./dock-area";
import { useSidePanel } from "./PanelToggles";
import { DockSlide } from "./DockSlide";
import { ArtifactCanvas, ArtifactFrame, useArtifact, type CanvasHandle, type CanvasView, type DesignPin, type PinControls } from "./ArtifactCanvas";
import { useDesignsEnabled } from "../../lib/designs-enabled";
import { useDesignSharingAvailable } from "../../lib/design-sharing-available";
import { bridgeForKey } from "../../lib/computer-bridge";
import { DESIGN_DELETED, DESIGN_SAVED, type DesignDeleted, type DesignSaved } from "./DesignEditor";
import { DesignPageShareDialog } from "./DesignPageShareDialog";

// Docked width plus the 12px gap to the chat. The chat panes reserve it through --artifact-dock.
const DOCK_WIDTH = 560;
// Narrower than this beside the dock, the chat is no use: the canvas takes the whole workspace instead.
const MIN_CHAT_WIDTH = 420;

/** Whether the element is laid out: false while an ancestor hides it (the diff, settings or canvas in place of the chat). */
function useShown() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [shown, setShown] = useState(true);
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(() => setShown(element.getClientRects().length > 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, shown] as const;
}

type ArtifactsValue = {
  enabled: boolean;
  /** The Chat's key, or null where designs can't be read (a new Chat, a shared Link Chat). */
  chatId: string | null;
  /** The newest version of each design the Chat's replies showed, by id, in the order they were first shown. */
  latest: Map<string, ArtifactRef>;
  open: (ref: ArtifactRef) => void;
  /** Opens the canvas framing these designs together. */
  openAll: (refs: ArtifactRef[]) => void;
  /** Opens the canvas on a sent comment, its bubble open: `key` is "<message id>:<comment index>". */
  openComment: (key: string) => void;
  /** The agent's notes on the comments it resolved, by comment id. */
  resolutions: Map<string, string>;
};
const Artifacts = createContext<ArtifactsValue>({
  enabled: false,
  chatId: null,
  latest: new Map(),
  open: () => {},
  openAll: () => {},
  openComment: () => {},
  resolutions: new Map(),
});

/**
 * The agent's notes on the comments it resolved, by comment id, read again when `moved` (designActivity) changes: the
 * agent resolves comments with a tool call, which the transcript shows as a step.
 */
function useResolutions(chatId: string | null, moved: number) {
  const [resolutions, setResolutions] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    const comments = chatId && window.milagre ? bridgeForKey(chatId).artifacts?.comments : undefined;
    if (!chatId || !comments) return;
    let live = true;
    comments({ chatId })
      .then((comments) => {
        if (live) setResolutions(resolutionNotes(comments));
      })
      // A host from before comments were kept has none to resolve.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [chatId, moved]);
  return resolutions;
}

/** The newest version of each design among a Chat's steps, in the order they were first shown. */
function latestArtifacts(steps: ChatStep[]): Map<string, ArtifactRef> {
  const latest = new Map<string, ArtifactRef>();
  for (const step of steps)
    if (step.kind === "artifact" && step.artifact && (latest.get(step.artifact.id)?.version ?? 0) < step.artifact.version)
      latest.set(step.artifact.id, step.artifact);
  return latest;
}

/**
 * A design at the screen size it was made for, scaled to fit its box whole and centered: a laptop screen fills the
 * card's width, a phone screen its height. A host from before screen sizes sends none; it gets the default.
 */
function ScaledPreview({
  html,
  title,
  width = 1280,
  height = 800,
  pin,
  format,
}: {
  html: string;
  title: string;
  format?: "design" | "html";
  width?: number;
  height?: number;
  /** A comment's spot on the design, as fractions of its screen, marked over the preview. */
  pin?: { x: number; y: number; label: string; resolved?: boolean };
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // A design runs only once its preview scrolls near the view: a long Chat's earlier designs don't all run at once.
  // Seen once, it stays.
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = box.current;
    if (!element || seen) return;
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && setSeen(true), { rootMargin: "400px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);
  const scale = size.width && size.height ? Math.min(size.width / width, size.height / height) : 0;
  return (
    <div ref={box} className="absolute inset-0 bg-canvas">
      {scale > 0 && seen && (
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{
            width,
            height,
            transform: `translate(${(size.width - width * scale) / 2}px, ${(size.height - height * scale) / 2}px) scale(${scale})`,
          }}
        >
          <ArtifactFrame html={html} title={title} preview format={format} />
          {pin && (
            <span
              aria-hidden
              className={`absolute grid size-5 place-items-center rounded-full rounded-bl-none text-[10px] font-medium text-white shadow-raised ${pin.resolved ? "bg-green" : "bg-accent"}`}
              style={{
                left: `${pin.x * 100}%`,
                top: `${pin.y * 100}%`,
                transform: `translateY(-100%) scale(${1 / scale})`,
                transformOrigin: "bottom left",
              }}
            >
              {pin.label}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** A design the agent showed: its first screen, and a button that opens it on the canvas beside the chat. */
const ArtifactCard = memo(function ArtifactCard({ step }: { step: ChatStep & { artifact: ArtifactRef } }) {
  const { chatId, latest, open, enabled } = useContext(Artifacts);
  const { id, version, title } = step.artifact;
  const allowed = enabled && latest.has(id);
  const current = latest.get(id);
  const isHtml = current?.format === "html";
  const { artifact, error } = useArtifact(allowed ? chatId : null, isHtml ? current.id : id, isHtml ? null : version, current?.version);
  const newest = latest.get(id)?.version ?? version;
  if (!allowed) return null;
  return (
    <div data-slot="artifact-card" data-artifact={id} className="my-2 max-w-xl overflow-hidden rounded-[10px] border border-line bg-surface">
      <div className="relative h-56 overflow-hidden border-b border-line bg-white">
        {artifact ? (
          <ScaledPreview html={artifact.html} format={artifact.format} title={`Preview of ${title}`} width={artifact.width} height={artifact.height} />
        ) : (
          <div className="grid size-full place-items-center px-6 text-center text-[12px] text-ink-3">
            {error ?? (chatId ? "Loading design…" : "Open this Chat in its Project to see the design.")}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 px-3 py-2">
        <HugeiconsIcon icon={isHtml ? File01Icon : PaintBoardIcon} size={16} className="shrink-0 text-ink-2" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] text-ink">{title}</div>
          <div className="text-[11px] text-ink-3">
            {isHtml ? "Artifact" : `Design · Version ${version}${newest > version ? ` · version ${newest} is newer` : ""}`}
          </div>
        </div>
        <button
          type="button"
          disabled={!chatId}
          onClick={() => open(step.artifact)}
          className="rounded-[8px] border border-line px-2.5 py-1 text-[12px] text-ink hover:bg-hover disabled:opacity-50"
        >
          Open
        </button>
      </div>
    </div>
  );
});

/**
 * Feedback the user sent from the canvas, shown as what it was instead of the text the agent reads: the design they
 * chose, and each comment beside the spot it was pinned on. A pinned comment opens the canvas on it.
 */
export function DesignFeedbackCard({
  feedback,
  messageId,
}: {
  feedback: { choice: ArtifactRef | null; comments: DesignComment[] };
  messageId: number | string;
}) {
  const { chatId, openComment, enabled, latest } = useContext(Artifacts);
  const choice = feedback.choice && latest.has(feedback.choice.id) ? feedback.choice : null;
  const comments = feedback.comments.filter((comment) => latest.has(comment.design.id));
  if (!enabled || (!choice && !comments.length)) return <FeedbackText feedback={feedback} />;
  const remaining = {
    choice: feedback.choice && !choice ? feedback.choice : null,
    comments: feedback.comments.filter((comment) => !comments.includes(comment)),
  };
  return (
    <div className="flex w-full max-w-md flex-col gap-2">
      <div data-slot="design-feedback" className="w-full max-w-md overflow-hidden rounded-xl border border-line bg-surface text-[13px]">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-[12px] text-ink-2">
          <HugeiconsIcon icon={PaintBoardIcon} size={14} aria-hidden />
          Feedback
        </div>
        {choice && (
          <div data-slot="design-feedback-choice" className="flex w-full items-center gap-2 px-3 py-2">
            <HugeiconsIcon icon={CheckmarkCircle02Icon} size={16} className="shrink-0 text-accent" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              Chose <span className="font-medium">{choice.title}</span>
            </span>
            <span className="text-[11px] text-ink-3">{latest.get(choice.id)?.format === "html" ? "Artifact" : `v${choice.version}`}</span>
          </div>
        )}
        {comments.map((comment) => (
          <FeedbackComment
            key={feedback.comments.indexOf(comment)}
            comment={comment}
            number={feedback.comments.indexOf(comment) + 1}
            // A pinned comment opens on the canvas, where it was left; one without a spot has nowhere to go.
            onOpen={chatId && comment.x !== undefined ? () => openComment(`${messageId}:${feedback.comments.indexOf(comment)}`) : undefined}
          />
        ))}
      </div>
      {(remaining.choice || remaining.comments.length > 0) && <FeedbackText feedback={remaining} />}
    </div>
  );
}

function FeedbackText({ feedback }: { feedback: { choice: ArtifactRef | null; comments: DesignComment[] } }) {
  return (
    <div data-slot="design-feedback-text" className="max-w-full whitespace-pre-wrap break-words rounded-xl bg-field px-3 py-2 text-[13px] text-ink">
      {designFeedbackText(feedback)}
    </div>
  );
}

function FeedbackComment({ comment, number, onOpen }: { comment: DesignComment; number: number; onOpen?: () => void }) {
  const { chatId, resolutions, latest } = useContext(Artifacts);
  const resolved = comment.id ? resolutions.get(comment.id) : undefined;
  const current = latest.get(comment.design.id);
  const isHtml = current?.format === "html";
  const { artifact } = useArtifact(chatId, isHtml ? current.id : comment.design.id, isHtml ? null : comment.design.version, current?.version);
  const Row = onOpen ? "button" : "div";
  return (
    <Row
      data-slot="design-feedback-comment"
      {...(onOpen
        ? {
            type: "button" as const,
            onClick: onOpen,
            "aria-label": `Show comment ${number} on ${comment.design.title}`,
          }
        : {})}
      className={`flex w-full items-start gap-3 border-t border-line px-3 py-2 text-left first:border-t-0 ${onOpen ? "hover:bg-hover" : ""}`}
    >
      <span className="relative block h-16 w-24 shrink-0 overflow-hidden rounded-[6px] border border-line">
        {artifact && (
          <ScaledPreview
            html={artifact.html}
            format={artifact.format}
            title={`Preview of ${comment.design.title}`}
            width={artifact.width}
            height={artifact.height}
            pin={
              comment.x === undefined || comment.y === undefined
                ? undefined
                : {
                    x: comment.x,
                    y: comment.y,
                    label: String(number),
                    resolved: resolved !== undefined,
                  }
            }
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block ${resolved === undefined ? "text-ink" : "text-ink-3 line-through"}`}>{comment.text}</span>
        {resolved !== undefined && (
          <span data-slot="design-feedback-resolved" className="mt-0.5 flex items-start gap-1 text-[12px] text-green">
            <HugeiconsIcon icon={CheckmarkCircle02Icon} size={13} className="mt-px shrink-0" aria-hidden />
            <span>{resolved}</span>
          </span>
        )}
        <span className="block truncate text-[11px] text-ink-3">
          {comment.design.title} · {latest.get(comment.design.id)?.format === "html" ? "Artifact" : `v${comment.design.version}`}
        </span>
      </span>
    </Row>
  );
}

/** The designs one reply showed: a card for one, a strip of thumbnails for several. */
export function ArtifactCards({ steps }: { steps: (ChatStep & { artifact: ArtifactRef })[] }) {
  const { chatId, openAll, enabled, latest } = useContext(Artifacts);
  const visibleSteps = steps.filter((step) => latest.has(step.artifact.id));
  const htmlSteps = visibleSteps.filter((step) => latest.get(step.artifact.id)?.format === "html");
  const designSteps = visibleSteps.filter((step) => latest.get(step.artifact.id)?.format === "design");
  if (htmlSteps.length)
    return (
      <>
        {htmlSteps.map((step) => (
          <ArtifactCard key={step.id} step={step} />
        ))}
        {designSteps.length > 0 && <ArtifactCards steps={designSteps} />}
      </>
    );
  if (!enabled || visibleSteps.length === 0) return null;
  if (visibleSteps.length === 1) return <ArtifactCard step={visibleSteps[0]!} />;
  return (
    <div data-slot="artifact-group" className="my-2 max-w-xl overflow-hidden rounded-[10px] border border-line bg-surface">
      <div className="flex gap-2 overflow-x-auto border-b border-line p-2">
        {visibleSteps.map((step) => (
          <GroupThumb key={step.id} design={step.artifact} />
        ))}
      </div>
      <div className="flex items-center gap-2 px-3 py-2">
        <HugeiconsIcon icon={PaintBoardIcon} size={16} className="shrink-0 text-ink-2" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] text-ink">{visibleSteps.length} designs</div>
          <div className="truncate text-[11px] text-ink-3">{visibleSteps.map((step) => step.artifact.title).join(" · ")}</div>
        </div>
        <button
          type="button"
          disabled={!chatId}
          onClick={() => openAll(visibleSteps.map((step) => step.artifact))}
          className="rounded-[8px] border border-line px-2.5 py-1 text-[12px] text-ink hover:bg-hover disabled:opacity-50"
        >
          Open
        </button>
      </div>
    </div>
  );
}

function GroupThumb({ design }: { design: ArtifactRef }) {
  const { chatId, open } = useContext(Artifacts);
  const { artifact, error } = useArtifact(chatId, design.id, design.version);
  return (
    <button
      type="button"
      data-slot="artifact-thumb"
      data-artifact={design.id}
      aria-label={`Open ${design.title}, version ${design.version}`}
      disabled={!chatId}
      onClick={() => open(design)}
      className="flex w-40 shrink-0 flex-col gap-1 rounded-[8px] p-1 text-left hover:bg-hover"
    >
      <span className="relative block h-28 w-full overflow-hidden rounded-[6px] border border-line">
        {artifact ? (
          <ScaledPreview html={artifact.html} format={artifact.format} title={`Preview of ${design.title}`} width={artifact.width} height={artifact.height} />
        ) : (
          <span className="grid size-full place-items-center px-2 text-center text-[11px] text-ink-3">{error ?? "Loading…"}</span>
        )}
      </span>
      <span className="truncate px-0.5 text-[12px] text-ink">{design.title}</span>
    </button>
  );
}

type Opened = {
  kind: "designs" | "artifacts";
  chatId: string | null;
  focus: { id: string | null; nonce: number };
  versions: Record<string, number | null>;
  /** A sent comment to open on the canvas. */
  comment?: string;
};

/**
 * The designs of one Chat: cards in its replies and the canvas docked beside it. `userMessages` are the Chat's user
 * messages, where the last design the user chose and the comments already sent are read back; `onSend` sends feedback.
 */
export function ArtifactsProvider({
  chatId,
  steps,
  userMessages,
  onSend,
  children,
}: {
  chatId: string | null;
  steps: ChatStep[];
  userMessages: { id: number | string; body: string }[];
  onSend?: (text: string) => Promise<boolean>;
  children: React.ReactNode;
}) {
  const { enabled } = useDesignsEnabled(chatId);
  const fromSteps = useMemo(() => latestArtifacts(steps), [steps]);
  // The catalog is read again when the replies show a new version, or the agent deleted a design.
  const deletes = steps.filter((step) => step.status === "done" && /\bdesign_delete\b/.test(step.title)).length;
  const revisionKey = `${[...fromSteps.values()].map((design) => `${design.id}:${design.version}`).join("|")}#${deletes}`;
  const [savedDesigns, setSavedDesigns] = useState<{
    chatId: string | null;
    refs: ArtifactRef[];
    htmlAliases?: string[];
    /** The replies' designs when `refs` was read: a design they showed then and `refs` lacks was deleted. */
    revisionKey?: string;
    /** Designs deleted here, hidden before the catalog is read again. */
    deleted?: string[];
  }>({ chatId: null, refs: [] });
  // Direct edits create versions without a new Chat reply. Read their metadata on open and when agent versions change.
  useEffect(() => {
    if (!chatId || !window.milagre) return;
    const list = bridgeForKey(chatId).artifacts?.list;
    if (!list) return;
    let live = true;
    list({ chatId })
      .then(async (refs) => {
        // An unmarked historical id may be a retired HTML page or a structured design
        // omitted while Designs is off. Ask the host instead of guessing its format.
        const known = new Set(refs.map((ref) => ref.id));
        const unknown = [...fromSteps.values()].filter((ref) => !ref.format && !known.has(ref.id));
        const aliases = await Promise.all(
          unknown.map(async (ref) => {
            try {
              const artifact = await bridgeForKey(chatId).artifacts.get({ chatId, id: ref.id });
              return artifact.format === "html" ? ref.id : null;
            } catch {
              return null;
            }
          }),
        );
        if (live)
          setSavedDesigns((current) => ({
            chatId,
            refs,
            htmlAliases: aliases.filter((id): id is string => id !== null),
            revisionKey,
            deleted: current.chatId === chatId ? current.deleted : [],
          }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [chatId, revisionKey, enabled]);
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<DesignSaved>).detail;
      if (!enabled || detail.chatId !== chatId || detail.artifact.format !== "design") return;
      const ref: ArtifactRef = {
        id: detail.artifact.id,
        title: detail.artifact.title,
        version: detail.artifact.version,
        format: "design",
      };
      setSavedDesigns((current) =>
        current.chatId === chatId
          ? { ...current, refs: [...current.refs.filter((item) => item.id !== ref.id), ref] }
          : { chatId, refs: [ref], htmlAliases: [] },
      );
    };
    const deleted = (event: Event) => {
      const detail = (event as CustomEvent<DesignDeleted>).detail;
      if (detail.chatId !== chatId) return;
      setSavedDesigns((current) =>
        current.chatId === chatId
          ? { ...current, refs: current.refs.filter((item) => item.id !== detail.id), deleted: [...(current.deleted ?? []), detail.id] }
          : { chatId, refs: [], htmlAliases: [], deleted: [detail.id] },
      );
    };
    window.addEventListener(DESIGN_SAVED, changed);
    window.addEventListener(DESIGN_DELETED, deleted);
    return () => {
      window.removeEventListener(DESIGN_SAVED, changed);
      window.removeEventListener(DESIGN_DELETED, deleted);
    };
  }, [chatId, enabled]);
  const latest = useMemo(() => {
    const saved = savedDesigns.chatId === chatId ? savedDesigns : null;
    const deleted = new Set(saved?.deleted);
    // Read for the replies as they are now, the catalog has every design they showed that wasn't deleted.
    const current = saved?.revisionKey === revisionKey ? new Set(saved.refs.map((ref) => ref.id)) : null;
    const refs = new Map(
      [...fromSteps].filter(([id, ref]) => ref.format === "html" || (ref.format === "design" && enabled && !deleted.has(id) && (!current || current.has(id)))),
    );
    for (const ref of saved?.refs ?? []) {
      if ((ref.format !== "design" || enabled) && (refs.get(ref.id)?.version ?? 0) <= ref.version) refs.set(ref.id, ref);
    }
    // Unmarked historical refs are resolved only after the saved catalog has answered.
    // A previous HTML id still opens the Chat's current artifact page.
    const catalog = savedDesigns.chatId === chatId ? savedDesigns.refs : [];
    const currentHtml = catalog.find((ref) => ref.format === "html");
    const aliases = new Set(savedDesigns.chatId === chatId ? savedDesigns.htmlAliases : []);
    if (currentHtml)
      for (const [id, ref] of fromSteps) {
        if (ref.format === "html" || aliases.has(id)) refs.set(id, { ...currentHtml, title: ref.title });
      }
    return refs;
  }, [fromSteps, savedDesigns, chatId, enabled, revisionKey]);
  const chosen = useMemo(() => chosenDesign(userMessages.map((message) => message.body)), [userMessages]);
  const moved = useMemo(
    () =>
      designActivity(
        steps,
        userMessages.map((message) => message.body),
      ),
    [steps, userMessages],
  );
  const resolutions = useResolutions(chatId, moved);
  // Comments already sent stay on the canvas, where the user left them, resolved once the agent has addressed them.
  const sent = useMemo<DesignPin[]>(
    () =>
      userMessages.flatMap((message) =>
        (parseDesignFeedback(message.body)?.comments ?? []).flatMap((comment, index) => {
          if (comment.x === undefined || comment.y === undefined) return [];
          const resolved = comment.id ? resolutions.get(comment.id) : undefined;
          return [
            {
              key: `${message.id}:${index}`,
              design: comment.design,
              x: comment.x,
              y: comment.y,
              text: comment.text,
              ...(comment.nodeId ? { nodeId: comment.nodeId } : {}),
              ...(resolved === undefined ? {} : { resolved }),
            },
          ];
        }),
      ),
    [userMessages, resolutions],
  );
  // What is open belongs to the Chat it opened in: switching Chats closes it.
  const [openedIn, setOpenedIn] = useState<Opened | null>(null);
  const opened = openedIn?.chatId === chatId && (enabled || openedIn.kind === "artifacts") ? openedIn : null;
  useEffect(() => {
    if (!enabled) setOpenedIn((current) => (current?.kind === "designs" ? null : current));
  }, [enabled]);
  // A card opens the version it shows; when that is the newest, its frame follows the agent's next revisions.
  const value = useMemo<ArtifactsValue>(
    () => ({
      enabled: true,
      chatId,
      latest,
      open: (ref) =>
        latest.has(ref.id) &&
        setOpenedIn((current) => ({
          chatId,
          kind: latest.get(ref.id)?.format === "design" ? "designs" : "artifacts",
          focus: { id: ref.id, nonce: (current?.focus.nonce ?? 0) + 1 },
          versions: {
            ...(current?.chatId === chatId ? current.versions : {}),
            [ref.id]: latest.get(ref.id)?.version === ref.version ? null : ref.version,
          },
        })),
      openComment: (key) => {
        const pin = sent.find((item) => item.key === key);
        if (!pin || !latest.has(pin.design.id)) return;
        setOpenedIn((current) => ({
          chatId,
          kind: latest.get(pin.design.id)?.format === "design" ? "designs" : "artifacts",
          focus: { id: pin.design.id, nonce: (current?.focus.nonce ?? 0) + 1 },
          versions: {
            ...(current?.chatId === chatId ? current.versions : {}),
            [pin.design.id]: latest.get(pin.design.id)?.version === pin.design.version ? null : pin.design.version,
          },
          comment: key,
        }));
      },
      resolutions,
      openAll: (refs) =>
        setOpenedIn((current) => ({
          chatId,
          kind: refs[0]?.format === "design" ? "designs" : "artifacts",
          focus: { id: null, nonce: (current?.focus.nonce ?? 0) + 1 },
          versions: {
            ...(current?.chatId === chatId ? current.versions : {}),
            ...Object.fromEntries(refs.map((ref) => [ref.id, latest.get(ref.id)?.version === ref.version ? null : ref.version])),
          },
        })),
    }),
    [chatId, latest, sent, resolutions, enabled],
  );
  const designRefs = [...latest.values()].filter((ref) => ref.format === "design");
  const artifactRefs = [...latest.values()].filter((ref) => ref.format === "html");
  // Deleting the last design leaves nothing to show.
  useEffect(() => {
    if (opened?.kind === "designs" && !designRefs.length) setOpenedIn(null);
  }, [opened?.kind, designRefs.length]);
  // The saved catalog owns the one current HTML page; older transcript refs still open it.
  const currentHtml = (savedDesigns.chatId === chatId ? savedDesigns.refs : []).find((ref) => ref.format === "html") ?? artifactRefs.at(-1);
  const togglePanel = (kind: "designs" | "artifacts") => {
    if (document.querySelector("[data-slot=design-editor]")) return;
    if (opened?.kind === kind) setOpenedIn(null);
    else value.openAll(kind === "designs" ? designRefs : currentHtml ? [currentHtml] : []);
  };
  useSidePanel("designs", enabled && chatId && designRefs.length ? { open: opened?.kind === "designs", toggle: () => togglePanel("designs") } : null);
  useSidePanel("artifacts", chatId && artifactRefs.length ? { open: opened?.kind === "artifacts", toggle: () => togglePanel("artifacts") } : null);
  const onVersion = useCallback(
    (id: string, version: number | null) =>
      setOpenedIn(
        (current) =>
          current && {
            ...current,
            versions: { ...current.versions, [id]: version },
          },
      ),
    [],
  );
  // The canvas belongs to the chat: while something else takes the chat's place, it steps aside and comes back with it.
  const [anchor, chatShown] = useShown();
  const closeDesigns = useCallback(() => {
    if (!document.querySelector("[data-slot=design-editor]")) setOpenedIn(null);
  }, []);
  useSidePanelRoom(opened?.kind ?? "designs", !!opened && !!chatId && chatShown, DOCK_WIDTH + 12, closeDesigns);
  return (
    <Artifacts.Provider value={value}>
      <span ref={anchor} aria-hidden className="pointer-events-none absolute top-0 left-0 h-px w-px" />
      {children}
      {(enabled || openedIn?.kind === "artifacts") && (
        <AnimatePresence>
          {opened && chatId && chatShown && (
            <ArtifactDock
              key={opened.kind}
              kind={opened.kind}
              chatId={chatId}
              designs={opened.kind === "designs" ? designRefs : currentHtml ? [currentHtml] : []}
              focus={opened.focus}
              versions={opened.versions}
              onVersion={onVersion}
              chosen={chosen}
              sent={sent}
              openComment={opened.comment}
              onSend={onSend}
              onClose={closeDesigns}
            />
          )}
        </AnimatePresence>
      )}
    </Artifacts.Provider>
  );
}

function ArtifactDock({
  kind,
  chatId,
  designs,
  focus,
  versions,
  onVersion,
  chosen,
  sent,
  openComment,
  onSend,
  onClose,
}: {
  kind: "designs" | "artifacts";
  chatId: string;
  designs: ArtifactRef[];
  focus: { id: string | null; nonce: number };
  versions: Record<string, number | null>;
  onVersion: (id: string, version: number | null) => void;
  chosen: { id: string; version: number } | null;
  sent: DesignPin[];
  openComment?: string;
  onSend?: (text: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const htmlRef = kind === "artifacts" ? designs[0] : undefined;
  const { artifact: page, error: pageError } = useArtifact(htmlRef ? chatId : null, htmlRef?.id ?? "", null, htmlRef?.version);
  const [expanded, setExpanded] = useState(false);
  const [sharingChat, setSharingChat] = useState<string | null>(null);
  const sharingAvailable = useDesignSharingAvailable(chatId, kind);
  const label = kind === "artifacts" ? "Artifacts" : "Designs";
  const area = useDockArea();
  const reduced = useReducedMotion();
  // The designs' frames mount once the panel has slid in: building them while it moves is what makes it stutter.
  const [entered, setEntered] = useState(!!reduced);
  const cramped = !!area && area.width - DOCK_WIDTH - 12 < MIN_CHAT_WIDTH;
  const full = expanded || cramped;
  const canvas = useRef<CanvasHandle>(null);
  const [view, setView] = useState<CanvasView | null>(null);
  const [commenting, setCommenting] = useState(false);
  const [pageComment, setPageComment] = useState("");
  // Feedback waits here until Send: comments pinned on designs, and the design the user chose.
  const [pins, setPins] = useState<DesignPin[]>([]);
  const [openPin, setOpenPin] = useState<string | null>(openComment ?? null);
  // A sent comment opened from the chat opens its bubble, also when the canvas is open already.
  useEffect(() => {
    if (openComment) setOpenPin(openComment);
  }, [openComment, focus.nonce]);
  const [choice, setChoice] = useState<ArtifactRef | null>(null);
  const [sending, setSending] = useState(false);
  // Feedback on a design deleted meanwhile has nothing left to send to.
  const designIds = designs.map((design) => design.id).join("|");
  useEffect(() => {
    if (kind !== "designs") return;
    const ids = new Set(designIds.split("|"));
    setPins((current) => (current.every((pin) => ids.has(pin.design.id)) ? current : current.filter((pin) => ids.has(pin.design.id))));
    setChoice((current) => (current && !ids.has(current.id) ? null : current));
  }, [kind, designIds]);
  const [error, setError] = useState("");
  // Escape leaves comment mode first, then closes the canvas.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("[data-slot=design-editor], [data-slot=design-page-share]")) return;
      if (commenting) setCommenting(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commenting, onClose]);
  const written = pins.filter((pin) => pin.text.trim());
  const feedback = kind === "artifacts" ? Number(!!pageComment.trim() && !!page) : written.length + (choice ? 1 : 0);
  const send = async () => {
    if (!onSend || sending || !feedback) return;
    setSending(true);
    setError("");
    try {
      // Each pin's key is its comment's id, which the agent resolves it by. The host records the comments once the
      // message went, so a send that fails records none.
      const comments: DesignComment[] = written.map(({ key, design, x, y, text, nodeId }) => ({
        id: key,
        design,
        x,
        y,
        text,
        ...(nodeId ? { nodeId } : {}),
      }));
      if (kind === "artifacts" && page)
        comments.push({ id: newCommentId(), design: { id: page.id, title: page.title, version: page.version, format: "html" }, text: pageComment.trim() });
      if (await onSend(designFeedbackMessage({ choice, comments }))) {
        if (comments.length)
          void bridgeForKey(chatId)
            .artifacts.addComments?.({ chatId, comments })
            .catch(() => {});
        setPins([]);
        setPageComment("");
        setOpenPin(null);
        setChoice(null);
        setCommenting(false);
        // The chat comes back into view to follow the reply: the canvas steps back beside it, or closes when the
        // window is too narrow for both.
        if (cramped) onClose();
        else setExpanded(false);
      } else setError("The feedback didn't send. Try again.");
    } finally {
      setSending(false);
    }
  };
  const comments: PinControls = {
    pins,
    sent,
    open: openPin,
    onPin: (design, x, y, nodeId) => {
      const key = newCommentId();
      // A new pin closes the open bubble, dropping it if it was left empty.
      setPins((current) => [
        ...current.filter((pin) => pin.key !== openPin || pin.text.trim()),
        { key, design, x, y, text: "", ...(nodeId ? { nodeId } : {}) },
      ]);
      setOpenPin(key);
    },
    onOpen: setOpenPin,
    onText: (key, text) => setPins((current) => current.map((pin) => (pin.key === key ? { ...pin, text } : pin))),
    onRemove: (key) => {
      setPins((current) => current.filter((pin) => pin.key !== key));
      setOpenPin((current) => (current === key ? null : current));
    },
    onSend: () => void send(),
  };
  const icon = "rounded p-1 text-ink-2 hover:bg-hover disabled:opacity-40";
  return createPortal(
    <DockSlide
      // Opens like the git changes panel. Beside the chat, the chat makes room (--artifact-dock); filling the
      // workspace, the canvas covers it and reserves nothing.
      width={full ? null : DOCK_WIDTH}
      reserve="--artifact-dock"
      onEntered={() => setEntered(true)}
      role="dialog"
      aria-label={label}
      aria-modal="false"
      data-slot="artifact-dock"
      data-full={full || undefined}
      // Beside a docked simulator and the git changes panel, not over them.
      style={
        full && area
          ? {
              top: area.top,
              left: area.left,
              right: `calc(${area.right + 12}px + var(--simulator-dock, 0px))`,
              bottom: area.bottom,
            }
          : {
              top: area?.top ?? 40,
              right: `calc(${(area?.right ?? 0) + 12}px + var(--simulator-dock, 0px))`,
              bottom: area?.bottom ?? 12,
            }
      }
      className="fixed z-[41]"
      panelClassName="overflow-hidden rounded-window bg-surface text-ink shadow-card"
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-2">
        <HugeiconsIcon icon={kind === "artifacts" ? File01Icon : PaintBoardIcon} size={16} aria-hidden />
        <div className="ml-1 min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px]">{label}</span>
            {kind === "designs" && (
              <span data-slot="designs-experimental" className="rounded border border-line px-1.5 py-0.5 text-[9px] leading-none text-ink-3">
                Experimental
              </span>
            )}
          </div>
          <div className="text-[11px] text-ink-3">
            {kind === "artifacts" ? "Chat page" : `${designs.length} ${designs.length === 1 ? "design" : "designs"} in this Chat`}
          </div>
        </div>
        {feedback > 0 && (
          <button
            type="button"
            data-slot="artifact-send"
            disabled={sending}
            title={error || undefined}
            onClick={() => void send()}
            className={`mr-1 flex items-center gap-1.5 rounded-[8px] px-2.5 py-1 text-[12px] font-medium disabled:opacity-50 ${error ? "bg-red text-white" : "bg-ink text-surface"}`}
          >
            {error ? "Retry send" : "Send"}
            <span className="rounded-full bg-surface/20 px-1.5 text-[11px] tabular-nums">{feedback}</span>
          </button>
        )}
        {sharingAvailable && (
          <button
            type="button"
            aria-label="Share page"
            onClick={() => setSharingChat(chatId)}
            className="rounded px-2 py-1 text-[12px] text-ink-2 hover:bg-hover"
          >
            Share
          </button>
        )}
        <Tooltip label={commenting ? "Stop commenting" : kind === "artifacts" ? "Comment on artifact" : "Comment on a design"}>
          <button
            type="button"
            aria-label={commenting ? "Stop commenting" : kind === "artifacts" ? "Comment on artifact" : "Comment on a design"}
            aria-pressed={commenting}
            disabled={!onSend}
            onClick={() => setCommenting((value) => !value)}
            className={`${icon} ${commenting ? "bg-accent/10 text-accent" : ""}`}
          >
            <HugeiconsIcon icon={Comment01Icon} size={16} aria-hidden />
          </button>
        </Tooltip>
        {kind === "designs" && (
          <>
            <Tooltip label="Zoom out">
              <button type="button" aria-label="Zoom out" onClick={() => canvas.current?.zoomBy(1 / 1.25)} className={icon}>
                <HugeiconsIcon icon={MinusSignIcon} size={16} aria-hidden />
              </button>
            </Tooltip>
            <span data-slot="artifact-zoom" className="w-10 text-center text-[11px] text-ink-3 tabular-nums">
              {view ? `${Math.round(view.scale * 100)}%` : ""}
            </span>
            <Tooltip label="Zoom in">
              <button type="button" aria-label="Zoom in" onClick={() => canvas.current?.zoomBy(1.25)} className={icon}>
                <HugeiconsIcon icon={Add01Icon} size={16} aria-hidden />
              </button>
            </Tooltip>
            <Tooltip label="Fit every design">
              <button type="button" aria-label="Fit every design" onClick={() => canvas.current?.fitAll()} className={icon}>
                <HugeiconsIcon icon={FitToScreenIcon} size={16} aria-hidden />
              </button>
            </Tooltip>
          </>
        )}
        {!cramped && (
          <Tooltip label={expanded ? `Show the chat beside the ${kind}` : `Fill the window with the ${kind}`}>
            <button
              type="button"
              aria-label={expanded ? `Show the chat beside the ${kind}` : `Fill the window with the ${kind}`}
              aria-pressed={expanded}
              onClick={() => {
                // Filling the workspace, the designs take the room of the other side panels: they close.
                if (!expanded) window.dispatchEvent(new Event(DESIGNS_EXPANDED));
                setExpanded(!expanded);
              }}
              className={icon}
            >
              <HugeiconsIcon icon={expanded ? ArrowShrink01Icon : ArrowExpand01Icon} size={16} aria-hidden />
            </button>
          </Tooltip>
        )}
        <Tooltip label={`Close ${kind}`}>
          <button type="button" aria-label={`Close ${kind}`} onClick={onClose} className={icon}>
            <HugeiconsIcon icon={Cancel01Icon} size={16} aria-hidden />
          </button>
        </Tooltip>
      </header>
      {entered && kind === "artifacts" ? (
        <div data-slot="artifact-page" className="min-h-0 flex-1 bg-white">
          {page ? (
            <ArtifactFrame html={page.html} title={page.title} format="html" />
          ) : (
            <p role="status" className="p-4 text-[12px] text-ink-3">
              {pageError || "Loading artifact..."}
            </p>
          )}
        </div>
      ) : entered ? (
        <ArtifactCanvas
          ref={canvas}
          chatId={chatId}
          designs={designs}
          versions={versions}
          onVersion={onVersion}
          focus={focus}
          commenting={commenting}
          comments={comments}
          choice={{
            sent: chosen,
            pending: choice,
            onChoose:
              kind === "designs" && onSend
                ? (design) => setChoice((current) => (current?.id === design.id && current.version === design.version ? null : design))
                : null,
          }}
          onView={setView}
        />
      ) : (
        <div className="min-h-0 flex-1 bg-canvas" />
      )}
      {kind === "artifacts" && commenting && (
        <div data-slot="artifact-page-comment" className="shrink-0 border-t border-line p-3">
          <textarea
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- opening a comment focuses its input.
            autoFocus
            aria-label="Comment on artifact"
            rows={3}
            value={pageComment}
            disabled={sending}
            placeholder="Ask for changes to this artifact"
            onChange={(event) => setPageComment(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
            className="w-full resize-none rounded-[8px] border border-line bg-field px-3 py-2 text-[13px] outline-none focus:border-accent"
          />
          {error && (
            <p role="alert" className="mt-1 text-[12px] text-red">
              {error}
            </p>
          )}
        </div>
      )}
      {sharingChat === chatId && <DesignPageShareDialog key={`${chatId}:${kind}`} chatId={chatId} kind={kind} onClose={() => setSharingChat(null)} />}
    </DockSlide>,
    dockLayer(),
  );
}
