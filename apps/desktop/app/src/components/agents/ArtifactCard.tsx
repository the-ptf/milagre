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
import { DESIGN_SAVED, type DesignSaved } from "./DesignEditor";
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
}: {
  html: string;
  title: string;
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
          <ArtifactFrame html={html} title={title} preview />
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
  const { artifact, error } = useArtifact(allowed ? chatId : null, id, version);
  const newest = latest.get(id)?.version ?? version;
  if (!allowed) return null;
  return (
    <div data-slot="artifact-card" data-artifact={id} className="my-2 max-w-xl overflow-hidden rounded-[10px] border border-line bg-surface">
      <div className="relative h-56 overflow-hidden border-b border-line bg-white">
        {artifact ? (
          <ScaledPreview html={artifact.html} title={`Preview of ${title}`} width={artifact.width} height={artifact.height} />
        ) : (
          <div className="grid size-full place-items-center px-6 text-center text-[12px] text-ink-3">
            {error ?? (chatId ? "Loading design…" : "Open this Chat in its Project to see the design.")}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 px-3 py-2">
        <HugeiconsIcon icon={PaintBoardIcon} size={16} className="shrink-0 text-ink-2" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] text-ink">{title}</div>
          <div className="text-[11px] text-ink-3">
            Version {version}
            {newest > version ? ` · version ${newest} is newer` : ""}
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
          Feedback on the designs
        </div>
        {choice && (
          <div data-slot="design-feedback-choice" className="flex w-full items-center gap-2 px-3 py-2">
            <HugeiconsIcon icon={CheckmarkCircle02Icon} size={16} className="shrink-0 text-accent" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              Chose <span className="font-medium">{choice.title}</span>
            </span>
            <span className="text-[11px] text-ink-3">v{choice.version}</span>
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
  const { chatId, resolutions } = useContext(Artifacts);
  const resolved = comment.id ? resolutions.get(comment.id) : undefined;
  const { artifact } = useArtifact(chatId, comment.design.id, comment.design.version);
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
          {comment.design.title} · v{comment.design.version}
        </span>
      </span>
    </Row>
  );
}

/** The designs one reply showed: a card for one, a strip of thumbnails for several. */
export function ArtifactCards({ steps }: { steps: (ChatStep & { artifact: ArtifactRef })[] }) {
  const { chatId, openAll, enabled, latest } = useContext(Artifacts);
  const visibleSteps = steps.filter((step) => latest.has(step.artifact.id));
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
          <ScaledPreview html={artifact.html} title={`Preview of ${design.title}`} width={artifact.width} height={artifact.height} />
        ) : (
          <span className="grid size-full place-items-center px-2 text-center text-[11px] text-ink-3">{error ?? "Loading…"}</span>
        )}
      </span>
      <span className="truncate px-0.5 text-[12px] text-ink">{design.title}</span>
    </button>
  );
}

type Opened = {
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
  const revisionKey = [...fromSteps.values()].map((design) => `${design.id}:${design.version}`).join("|");
  const [savedDesigns, setSavedDesigns] = useState<{
    chatId: string | null;
    refs: ArtifactRef[];
  }>({ chatId: null, refs: [] });
  // Direct edits create versions without a new Chat reply. Read their metadata on open and when agent versions change.
  useEffect(() => {
    if (!enabled || !chatId || !window.milagre) return;
    const list = bridgeForKey(chatId).artifacts?.list;
    if (!list) return;
    let live = true;
    list({ chatId })
      .then((refs) => {
        if (live)
          setSavedDesigns({
            chatId,
            refs: refs.filter((ref) => ref.format === "design"),
          });
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
      setSavedDesigns((current) => ({
        chatId,
        refs: [...(current.chatId === chatId ? current.refs.filter((item) => item.id !== ref.id) : []), ref],
      }));
    };
    window.addEventListener(DESIGN_SAVED, changed);
    return () => window.removeEventListener(DESIGN_SAVED, changed);
  }, [chatId, enabled]);
  const latest = useMemo(() => {
    if (!enabled) return new Map<string, ArtifactRef>();
    const refs = new Map([...fromSteps].filter(([, ref]) => ref.format === "design"));
    for (const ref of savedDesigns.chatId === chatId ? savedDesigns.refs : []) {
      if ((refs.get(ref.id)?.version ?? 0) < ref.version) refs.set(ref.id, ref);
    }
    return refs;
  }, [fromSteps, savedDesigns, chatId, enabled]);
  const chosen = useMemo(() => chosenDesign(userMessages.map((message) => message.body)), [userMessages]);
  const moved = useMemo(
    () =>
      designActivity(
        steps,
        userMessages.map((message) => message.body),
      ),
    [steps, userMessages],
  );
  const resolutions = useResolutions(enabled ? chatId : null, moved);
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
  const opened = enabled && openedIn?.chatId === chatId ? openedIn : null;
  useEffect(() => {
    if (!enabled) setOpenedIn(null);
  }, [enabled]);
  // A card opens the version it shows; when that is the newest, its frame follows the agent's next revisions.
  const value = useMemo<ArtifactsValue>(
    () => ({
      enabled,
      chatId,
      latest,
      open: (ref) =>
        enabled &&
        latest.has(ref.id) &&
        setOpenedIn((current) => ({
          chatId,
          focus: { id: ref.id, nonce: (current?.focus.nonce ?? 0) + 1 },
          versions: {
            ...(current?.chatId === chatId ? current.versions : {}),
            [ref.id]: latest.get(ref.id)?.version === ref.version ? null : ref.version,
          },
        })),
      openComment: (key) => {
        const pin = sent.find((item) => item.key === key);
        if (!enabled || !pin || !latest.has(pin.design.id)) return;
        setOpenedIn((current) => ({
          chatId,
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
        enabled &&
        setOpenedIn((current) => ({
          chatId,
          focus: { id: null, nonce: (current?.focus.nonce ?? 0) + 1 },
          versions: {
            ...(current?.chatId === chatId ? current.versions : {}),
            ...Object.fromEntries(refs.map((ref) => [ref.id, latest.get(ref.id)?.version === ref.version ? null : ref.version])),
          },
        })),
    }),
    [chatId, latest, sent, resolutions, enabled],
  );
  // The window's top-right corner offers the designs too, while this Chat has any.
  const toggleDesigns = useCallback(() => {
    // The global corner control remains above the modal. It must not unmount an editor with local changes.
    if (!enabled || document.querySelector("[data-slot=design-editor]")) return;
    if (opened) setOpenedIn(null);
    else value.openAll([...latest.values()]);
  }, [opened, value, latest, enabled]);
  useSidePanel("designs", enabled && chatId && latest.size ? { open: !!opened, toggle: toggleDesigns } : null);
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
  useSidePanelRoom("designs", !!opened && !!chatId && chatShown, DOCK_WIDTH + 12, closeDesigns);
  return (
    <Artifacts.Provider value={value}>
      <span ref={anchor} aria-hidden className="pointer-events-none absolute top-0 left-0 h-px w-px" />
      {children}
      {enabled && (
        <AnimatePresence>
          {opened && chatId && chatShown && (
            <ArtifactDock
              key="designs"
              chatId={chatId}
              designs={[...latest.values()]}
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
  const [expanded, setExpanded] = useState(false);
  const [sharingChat, setSharingChat] = useState<string | null>(null);
  const sharingAvailable = useDesignSharingAvailable(chatId);
  const area = useDockArea();
  const reduced = useReducedMotion();
  // The designs' frames mount once the panel has slid in: building them while it moves is what makes it stutter.
  const [entered, setEntered] = useState(!!reduced);
  const cramped = !!area && area.width - DOCK_WIDTH - 12 < MIN_CHAT_WIDTH;
  const full = expanded || cramped;
  const canvas = useRef<CanvasHandle>(null);
  const [view, setView] = useState<CanvasView | null>(null);
  const [commenting, setCommenting] = useState(false);
  // Feedback waits here until Send: comments pinned on designs, and the design the user chose.
  const [pins, setPins] = useState<DesignPin[]>([]);
  const [openPin, setOpenPin] = useState<string | null>(openComment ?? null);
  // A sent comment opened from the chat opens its bubble, also when the canvas is open already.
  useEffect(() => {
    if (openComment) setOpenPin(openComment);
  }, [openComment, focus.nonce]);
  const [choice, setChoice] = useState<ArtifactRef | null>(null);
  const [sending, setSending] = useState(false);
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
  const feedback = written.length + (choice ? 1 : 0);
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
      if (await onSend(designFeedbackMessage({ choice, comments }))) {
        if (comments.length)
          void bridgeForKey(chatId)
            .artifacts.addComments?.({ chatId, comments })
            .catch(() => {});
        setPins([]);
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
      aria-label="Designs"
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
        <HugeiconsIcon icon={PaintBoardIcon} size={16} aria-hidden />
        <div className="ml-1 min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px]">Designs</span>
            <span data-slot="designs-experimental" className="rounded border border-line px-1.5 py-0.5 text-[9px] leading-none text-ink-3">
              Experimental
            </span>
          </div>
          <div className="text-[11px] text-ink-3">{designs.length === 1 ? "1 design" : `${designs.length} designs`} in this Chat</div>
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
        <Tooltip label={commenting ? "Stop commenting" : "Comment on a design"}>
          <button
            type="button"
            aria-label={commenting ? "Stop commenting" : "Comment on a design"}
            aria-pressed={commenting}
            disabled={!onSend}
            onClick={() => setCommenting((value) => !value)}
            className={`${icon} ${commenting ? "bg-accent/10 text-accent" : ""}`}
          >
            <HugeiconsIcon icon={Comment01Icon} size={16} aria-hidden />
          </button>
        </Tooltip>
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
        {!cramped && (
          <Tooltip label={expanded ? "Show the chat beside the designs" : "Fill the window with the designs"}>
            <button
              type="button"
              aria-label={expanded ? "Show the chat beside the designs" : "Fill the window with the designs"}
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
        <Tooltip label="Close designs">
          <button type="button" aria-label="Close designs" onClick={onClose} className={icon}>
            <HugeiconsIcon icon={Cancel01Icon} size={16} aria-hidden />
          </button>
        </Tooltip>
      </header>
      {entered ? (
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
            onChoose: onSend ? (design) => setChoice((current) => (current?.id === design.id && current.version === design.version ? null : design)) : null,
          }}
          onView={setView}
        />
      ) : (
        <div className="min-h-0 flex-1 bg-canvas" />
      )}
      {sharingChat === chatId && <DesignPageShareDialog key={chatId} chatId={chatId} onClose={() => setSharingChat(null)} />}
    </DockSlide>,
    dockLayer(),
  );
}
