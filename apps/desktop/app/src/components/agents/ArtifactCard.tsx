import { useDesignsStage } from "./designs-stage";
import { HtmlReply } from "./HtmlReply";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { CheckmarkCircle02Icon, PaintBoardIcon, File01Icon } from "@hugeicons/core-free-icons";
import {
  chosenDesign,
  designActivity,
  designFeedbackText,
  isInteractiveDesign,
  parseDesignFeedback,
  resolutionNotes,
  type ArtifactComment,
  type DesignComment,
} from "@milagre/shared/artifact";
import type { ArtifactRef, ChatStep, ImageAttachment, Subagent } from "../../model";
import { Button } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { THEME_EVENT } from "../../lib/theme-sheet";
import { useSidePanelRoom } from "./dock-area";
import { useSidePanel } from "./PanelToggles";
import { usePanelWidth } from "./panel-width";
import { ArtifactFrame, pageFiles, type DesignPin, type PageFiles } from "./ArtifactCanvas";
import { useArtifact } from "./artifact-read";
import { SentCommentImages } from "./CommentImages";
import { useDesignsEnabled } from "../../lib/designs-enabled";
import { bridgeForKey } from "../../lib/computer-bridge";
import { remember, useSavedDesigns } from "./saved-designs";
import { libraryDockPage, libraryPageId, useDesignLibrary } from "./design-library";
import { useDesignWorkActive, useDesignWorkStarted, useLiveDesignFeed } from "./design-live";
import { ArtifactDock } from "./ArtifactDock";
import type { DockPage } from "./dock-feedback";

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
  chatId: string | null;
  latest: Map<string, ArtifactRef>;
  open: (ref: ArtifactRef) => void;
  openAll: (refs: ArtifactRef[], page?: DockPage) => void;
  openComment: (key: string) => void;
  resolutions: Map<string, string>;
  anchors: Map<string, string>;
};
const Artifacts = createContext<ArtifactsValue>({
  enabled: false,
  chatId: null,
  latest: new Map(),
  open: () => {},
  openAll: () => {},
  openComment: () => {},
  resolutions: new Map(),
  anchors: new Map(),
});

export function useReplyChatId(): string | null {
  return useContext(Artifacts).chatId;
}

type HostComments = { comments: ArtifactComment[]; resolutions: Map<string, string> };
const NO_COMMENTS: HostComments = { comments: [], resolutions: new Map() };
const lastComments = new Map<string, HostComments>();
const hostCommentsOf = (chatId: string | null) => (chatId ? lastComments.get(chatId) : undefined) ?? NO_COMMENTS;

function useHostComments(chatId: string | null, moved: number) {
  const [state, setState] = useState<HostComments & { chatId: string | null }>(() => ({ chatId, ...hostCommentsOf(chatId) }));
  const [reads, setReads] = useState(0);
  useEffect(() => {
    const comments = chatId && window.milagre ? bridgeForKey(chatId).artifacts?.comments : undefined;
    if (!chatId || !comments) return;
    let live = true;
    comments({ chatId })
      .then((comments) => {
        const read = { comments, resolutions: resolutionNotes(comments) };
        remember(lastComments, chatId, read);
        if (live) setState({ chatId, ...read });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [chatId, moved, reads]);
  const reread = useCallback(() => setReads((count) => count + 1), []);
  const shown = state.chatId === chatId ? state : hostCommentsOf(chatId);
  return { comments: shown.comments, resolutions: shown.resolutions, reread };
}

function latestArtifacts(steps: ChatStep[]): Map<string, ArtifactRef> {
  const latest = new Map<string, ArtifactRef>();
  for (const step of steps)
    if (step.kind === "artifact" && step.artifact && (latest.get(step.artifact.id)?.version ?? 0) < step.artifact.version)
      latest.set(step.artifact.id, step.artifact);
  return latest;
}

function usePinColors() {
  const read = () => {
    const style = getComputedStyle(document.documentElement);
    return {
      accent: style.getPropertyValue("--accent-ink").trim(),
      green: style.getPropertyValue("--green-ink").trim(),
      onAccent: style.getPropertyValue("--on-accent").trim(),
      onGreen: style.getPropertyValue("--on-green").trim(),
    };
  };
  const [colors, setColors] = useState(read);
  useEffect(() => {
    const changed = () => setColors(read());
    window.addEventListener(THEME_EVENT, changed);
    return () => window.removeEventListener(THEME_EVENT, changed);
  }, []);
  return colors;
}

function ScaledPreview({
  html,
  title,
  width = 1280,
  height = 800,
  pin,
  format,
  code,
  files,
}: {
  html: string;
  title: string;
  format?: "design" | "html";
  code?: boolean;
  files?: PageFiles;
  width?: number;
  height?: number;
  pin?: { x: number; y: number; label: string; resolved?: boolean; anchor?: string };
}) {
  const box = useRef<HTMLDivElement>(null);
  const colors = usePinColors();
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
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
          <ArtifactFrame
            html={html}
            title={title}
            preview
            format={format}
            code={code}
            files={files}
            page={
              format === "html" && pin
                ? {
                    scale,
                    pins: [
                      {
                        k: "pin",
                        x: pin.x,
                        y: pin.y,
                        ...(pin.anchor ? { a: pin.anchor } : {}),
                        n: pin.label,
                        fill: pin.resolved ? colors.green : colors.accent,
                        ink: pin.resolved ? colors.onGreen : colors.onAccent,
                        label: `Comment ${pin.label}`,
                      },
                    ],
                    reveal: { key: "pin", nonce: 0 },
                  }
                : undefined
            }
          />
          {pin && format !== "html" && (
            <span
              aria-hidden
              className={`absolute grid size-5 place-items-center rounded-full rounded-tl-none text-10 font-semibold shadow-pin ${pin.resolved ? "bg-green-ink text-on-green" : "bg-accent-ink text-on-accent"}`}
              style={{
                left: `${pin.x * 100}%`,
                top: `${pin.y * 100}%`,
                transform: `scale(${1 / scale})`,
                transformOrigin: "top left",
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
    <div data-slot="artifact-card" data-artifact={id} className="my-2 max-w-xl overflow-hidden rounded-card border border-line bg-surface">
      <div className="relative h-56 overflow-hidden border-b border-line bg-paper">
        {artifact ? (
          <ScaledPreview
            html={artifact.html}
            format={artifact.format}
            code={isInteractiveDesign(artifact)}
            title={`Preview of ${title}`}
            width={artifact.width}
            height={artifact.height}
            files={pageFiles(chatId, artifact)}
          />
        ) : (
          <div className="grid size-full place-items-center px-6 text-center text-12 text-ink-3">
            {error ?? (chatId ? "Loading design…" : "Open this Chat in its Project to see the design.")}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon icon={isHtml ? File01Icon : PaintBoardIcon} size={16} className="shrink-0 text-ink-2" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-13 text-ink">{title}</div>
          <div className="text-11 text-ink-3">
            {isHtml ? "Artifact" : `Design · Version ${version}${newest > version ? ` · version ${newest} is newer` : ""}`}
          </div>
        </div>
        <Button variant="secondary" size={28} disabled={!chatId} onClick={() => open(step.artifact)}>
          Open
        </Button>
      </div>
    </div>
  );
});

const NO_IMAGES: ImageAttachment[] = [];

export function DesignFeedbackCard({
  feedback,
  messageId,
  images = NO_IMAGES,
}: {
  feedback: { choice: ArtifactRef | null; comments: DesignComment[] };
  messageId: number | string;
  images?: ImageAttachment[];
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
      <div data-slot="design-feedback" className="w-full max-w-md overflow-hidden rounded-card border border-line bg-surface text-13">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-12 text-ink-2">
          <Icon icon={PaintBoardIcon} size={14} />
          Feedback
        </div>
        {choice && (
          <div data-slot="design-feedback-choice" className="flex w-full items-center gap-2 px-3 py-2">
            <Icon icon={CheckmarkCircle02Icon} size={16} className="shrink-0 text-ink" />
            <span className="min-w-0 flex-1 truncate">
              Chose <span className="font-medium">{choice.title}</span>
            </span>
            <span className="text-11 text-ink-3">{latest.get(choice.id)?.format === "html" ? "Artifact" : `v${choice.version}`}</span>
          </div>
        )}
        {comments.map((comment) => (
          <FeedbackComment
            key={feedback.comments.indexOf(comment)}
            comment={comment}
            number={feedback.comments.indexOf(comment) + 1}
            images={(comment.images ?? []).flatMap((index) => images[index - 1] ?? [])}
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
    <div data-slot="design-feedback-text" className="max-w-full whitespace-pre-wrap break-words rounded-card bg-field px-3 py-2 text-13 text-ink">
      {designFeedbackText(feedback)}
    </div>
  );
}

function FeedbackComment({ comment, number, images, onOpen }: { comment: DesignComment; number: number; images: ImageAttachment[]; onOpen?: () => void }) {
  const { chatId, resolutions, latest, anchors } = useContext(Artifacts);
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
      className={`flex w-full items-start gap-3 border-t border-line px-3 py-2 text-left first:border-t-0 ${onOpen ? "transition-colors hover:bg-hover active:bg-hover-2" : ""}`}
    >
      <span className="relative block h-16 w-24 shrink-0 overflow-hidden rounded-chip border border-line">
        {artifact && (
          <ScaledPreview
            files={pageFiles(chatId, artifact)}
            html={artifact.html}
            format={artifact.format}
            code={isInteractiveDesign(artifact)}
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
                    ...(comment.id && anchors.get(comment.id) ? { anchor: anchors.get(comment.id) } : {}),
                  }
            }
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block ${resolved === undefined ? "text-ink" : "text-ink-3 line-through"}`}>{comment.text}</span>
        <SentCommentImages images={images} />
        {resolved !== undefined && (
          <span data-slot="design-feedback-resolved" className="mt-0.5 flex items-start gap-1 text-12 text-green-ink">
            <Icon icon={CheckmarkCircle02Icon} size={12} className="mt-0.5 shrink-0" />
            <span>{resolved}</span>
          </span>
        )}
        <span className="block truncate text-11 text-ink-3">
          {comment.design.title} · {latest.get(comment.design.id)?.format === "html" ? "Artifact" : `v${comment.design.version}`}
        </span>
      </span>
    </Row>
  );
}

export function ArtifactCards({ steps }: { steps: (ChatStep & { artifact: ArtifactRef })[] }) {
  const { chatId, openAll, enabled, latest } = useContext(Artifacts);
  const inline = steps.filter((step) => step.artifact.inline);
  if (inline.length)
    return (
      <>
        {inline.map((step) => (
          <HtmlReply key={step.id} chatId={chatId} page={step.artifact} />
        ))}
        <ArtifactCards steps={steps.filter((step) => !step.artifact.inline)} />
      </>
    );
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
    <div data-slot="artifact-group" className="my-2 max-w-xl overflow-hidden rounded-card border border-line bg-surface">
      <div className="flex gap-2 overflow-x-auto border-b border-line p-2">
        {visibleSteps.map((step) => (
          <GroupThumb key={step.id} design={step.artifact} />
        ))}
      </div>
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon icon={PaintBoardIcon} size={16} className="shrink-0 text-ink-2" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-13 text-ink">{visibleSteps.length} designs</div>
          <div className="truncate text-11 text-ink-3">{visibleSteps.map((step) => step.artifact.title).join(" · ")}</div>
        </div>
        <Button variant="secondary" size={28} disabled={!chatId} onClick={() => openAll(visibleSteps.map((step) => step.artifact))}>
          Open
        </Button>
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
      className="flex w-40 shrink-0 flex-col gap-1 rounded-control p-1 text-left transition-colors enabled:hover:bg-hover enabled:active:bg-hover-2 disabled:opacity-40"
    >
      <span className="relative block h-28 w-full overflow-hidden rounded-chip border border-line">
        {artifact ? (
          <ScaledPreview
            html={artifact.html}
            format={artifact.format}
            code={isInteractiveDesign(artifact)}
            title={`Preview of ${design.title}`}
            width={artifact.width}
            height={artifact.height}
            files={pageFiles(chatId, artifact)}
          />
        ) : (
          <span className="grid size-full place-items-center px-2 text-center text-11 text-ink-3">{error ?? "Loading…"}</span>
        )}
      </span>
      <span className="truncate px-0.5 text-12 text-ink">{design.title}</span>
    </button>
  );
}

type Opened = {
  page: DockPage;
  chatId: string | null;
  focus: { id: string | null; nonce: number };
  versions: Record<string, number | null>;
  comment?: string;
  agent?: boolean;
};

const lastPage = new Map<string, DockPage>();

export function ArtifactsProvider({
  chatId,
  steps,
  userMessages,
  onSend,
  agent = "Agent",
  followAgent = false,
  subagents,
  children,
}: {
  chatId: string | null;
  steps: ChatStep[];
  userMessages: { id: number | string; body: string }[];
  onSend?: (text: string, images?: ImageAttachment[]) => Promise<boolean>;
  agent?: string;
  followAgent?: boolean;
  subagents?: readonly Subagent[];
  children: React.ReactNode;
}) {
  const { enabled } = useDesignsEnabled(chatId);
  useLiveDesignFeed(enabled ? chatId : null, agent, subagents);
  const designing = useDesignWorkActive(enabled ? chatId : null);
  const fromSteps = useMemo(() => latestArtifacts(steps), [steps]);
  const deletes = steps.filter((step) => step.status === "done" && /\bdesign_delete\b/.test(step.title)).length;
  const revisionKey = `${[...fromSteps.values()].map((design) => `${design.id}:${design.version}`).join("|")}#${deletes}`;
  const shownDesigns = useSavedDesigns(chatId, fromSteps, revisionKey, enabled);
  const library = useDesignLibrary(enabled ? chatId : null);
  const libraryPages = (enabled && chatId && library?.pages) || [];
  const latest = useMemo(() => {
    const saved = shownDesigns.chatId === chatId ? shownDesigns : null;
    const deleted = new Set(saved?.deleted);
    const current = saved?.revisionKey === revisionKey ? new Set(saved.refs.map((ref) => ref.id)) : null;
    const refs = new Map(
      [...fromSteps].filter(([id, ref]) => ref.format === "html" || (ref.format === "design" && enabled && !deleted.has(id) && (!current || current.has(id)))),
    );
    for (const ref of saved?.refs ?? []) {
      if ((ref.format !== "design" || enabled) && (refs.get(ref.id)?.version ?? 0) <= ref.version) refs.set(ref.id, ref);
    }
    const catalog = saved?.refs ?? [];
    const currentHtml = catalog.find((ref) => ref.format === "html");
    const aliases = new Set(saved?.htmlAliases ?? []);
    if (currentHtml)
      for (const [id, ref] of fromSteps) {
        if (ref.format === "html" || aliases.has(id)) refs.set(id, { ...currentHtml, title: ref.title });
      }
    return refs;
  }, [fromSteps, shownDesigns, chatId, enabled, revisionKey]);
  const chosen = useMemo(() => chosenDesign(userMessages.map((message) => message.body)), [userMessages]);
  const moved = useMemo(
    () =>
      designActivity(
        steps,
        userMessages.map((message) => message.body),
      ),
    [steps, userMessages],
  );
  const { resolutions, comments: hostComments, reread } = useHostComments(chatId, moved);
  const anchors = useMemo(() => new Map(hostComments.flatMap((comment) => (comment.anchor ? [[comment.id, comment.anchor] as const] : []))), [hostComments]);
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
              ...(comment.id ? { commentId: comment.id } : {}),
              ...(resolved === undefined ? {} : { resolved }),
            },
          ];
        }),
      ),
    [userMessages, resolutions],
  );
  const [openedIn, setOpenedIn] = useState<Opened | null>(null);
  const designRefs = [...latest.values()].filter((ref) => ref.format === "design");
  const artifactRefs = [...latest.values()].filter((ref) => ref.format === "html");
  const currentHtml = (shownDesigns.chatId === chatId ? shownDesigns.refs : []).find((ref) => ref.format === "html") ?? artifactRefs.at(-1);
  const hasCanvas = enabled && !!chatId && (designRefs.length > 0 || designing);
  const hasPage = !!chatId && !!currentHtml;
  const offered = (page: DockPage | undefined) =>
    page === "canvas" ? hasCanvas : page === "page" ? hasPage : libraryPages.some((item) => item.id === libraryPageId(page));
  const firstLibrary = libraryPages[0] ? libraryDockPage(libraryPages[0].id) : null;
  const pageFor = (wanted?: DockPage): DockPage | null => (offered(wanted) ? wanted! : hasCanvas ? "canvas" : hasPage ? "page" : firstLibrary);
  const stored = openedIn?.chatId === chatId ? openedIn : null;
  const shownPage = stored && pageFor(stored.page);
  const opened = stored && shownPage ? (shownPage === stored.page ? stored : { ...stored, page: shownPage, comment: undefined }) : null;
  useEffect(() => {
    if (stored && opened?.page !== stored.page) setOpenedIn(opened);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- follows what the panel can show, not each new object.
  }, [stored?.page, opened?.page]);
  useEffect(() => {
    if (chatId && opened) remember(lastPage, chatId, opened.page);
  }, [chatId, opened?.page]);
  const value = useMemo<ArtifactsValue>(
    () => ({
      enabled: true,
      chatId,
      latest,
      open: (ref) =>
        latest.has(ref.id) &&
        setOpenedIn((current) => ({
          chatId,
          page: latest.get(ref.id)?.format === "design" ? "canvas" : "page",
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
          page: latest.get(pin.design.id)?.format === "design" ? "canvas" : "page",
          focus: { id: pin.design.id, nonce: (current?.focus.nonce ?? 0) + 1 },
          versions: {
            ...(current?.chatId === chatId ? current.versions : {}),
            [pin.design.id]: latest.get(pin.design.id)?.version === pin.design.version ? null : pin.design.version,
          },
          comment: key,
        }));
      },
      resolutions,
      anchors,
      openAll: (refs, page) =>
        setOpenedIn((current) => ({
          chatId,
          page: page ?? (refs[0]?.format === "design" ? "canvas" : "page"),
          focus: { id: null, nonce: (current?.focus.nonce ?? 0) + 1 },
          versions: {
            ...(current?.chatId === chatId ? current.versions : {}),
            ...Object.fromEntries(refs.map((ref) => [ref.id, latest.get(ref.id)?.version === ref.version ? null : ref.version])),
          },
        })),
    }),
    [chatId, latest, sent, resolutions, anchors],
  );
  const togglePanel = () => {
    if (document.querySelector("[data-slot=design-editor]")) return;
    if (opened && designsStage.toggleClosesTab) return designsStage.close(closePanel, opened.page)();
    if (opened) return setOpenedIn(null);
    const page = pageFor(chatId ? lastPage.get(chatId) : undefined);
    if (page) value.openAll(page === "canvas" ? designRefs : page === "page" && currentHtml ? [currentHtml] : [], page);
  };
  useSidePanel("artifacts", hasCanvas || hasPage || firstLibrary ? { open: !!opened, toggle: togglePanel } : null);
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
  const onPage = useCallback((page: DockPage) => setOpenedIn((current) => current && { ...current, page, comment: undefined }), []);
  const [anchor, chatShown] = useShown();
  const shownRef = useRef(chatShown);
  shownRef.current = chatShown;
  useDesignWorkStarted(followAgent && enabled ? chatId : null, () => {
    if (!shownRef.current || document.querySelector("[data-slot=design-editor]")) return;
    setOpenedIn((current) =>
      current?.chatId === chatId && current.page === "canvas"
        ? current
        : {
            chatId,
            page: "canvas",
            focus: { id: null, nonce: (current?.focus.nonce ?? 0) + 1 },
            versions: current?.chatId === chatId ? current.versions : {},
            agent: true,
          },
    );
  });
  const designsStage = useDesignsStage(chatId, opened, (page) => {
    const shown = pageFor(page);
    if (shown) value.openAll(shown === "canvas" ? designRefs : shown === "page" && currentHtml ? [currentHtml] : [], shown);
  });
  const closePanel = useCallback(() => {
    if (!document.querySelector("[data-slot=design-editor]")) setOpenedIn(null);
  }, []);
  const dockWidth = usePanelWidth("artifacts").width;
  useSidePanelRoom("artifacts", !!opened && !!chatId && designsStage.takesRoom(chatShown), dockWidth + 12, closePanel);
  const revision = [...latest.values()].map((ref) => `${ref.id}:${ref.version}`).join("|");
  return (
    <Artifacts.Provider value={value}>
      <span ref={anchor} aria-hidden className="pointer-events-none absolute top-0 left-0 h-px w-px" />
      {children}
      <AnimatePresence>
        {opened && chatId && designsStage.visible(chatShown) && (
          <ArtifactDock
            staged={designsStage.staged}
            key={chatId}
            page={opened.page}
            onPage={onPage}
            hasCanvas={hasCanvas}
            chatId={chatId}
            designs={designRefs}
            htmlRef={currentHtml}
            library={libraryPages}
            revision={revision}
            focus={opened.focus}
            versions={opened.versions}
            onVersion={onVersion}
            chosen={chosen}
            sent={sent}
            hostComments={hostComments}
            onCommentsAdded={reread}
            openComment={opened.comment}
            openNonce={opened.focus.nonce}
            onSend={onSend}
            onClose={designsStage.close(closePanel, opened.page)}
          />
        )}
      </AnimatePresence>
    </Artifacts.Provider>
  );
}
