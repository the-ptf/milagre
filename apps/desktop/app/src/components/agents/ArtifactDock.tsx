import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useReducedMotion } from "motion/react";
import {
  ArrowExpand01Icon,
  ArrowShrink01Icon,
  Cancel01Icon,
  Comment01Icon,
  File01Icon,
  LibraryIcon,
  LinkSquare02Icon,
  MoreHorizontalIcon,
  PaintBoardIcon,
  Share08Icon,
} from "@hugeicons/core-free-icons";
import {
  ARTIFACT_SEND,
  artifactTab,
  libraryProject,
  type ArtifactComment,
  type DesignLibraryPage,
  type HtmlArtifact,
  type PageShareScope,
} from "@milagre/shared/artifact";
import { isModalOpen } from "../../lib/modal";
import type { ArtifactRef, ImageAttachment } from "../../model";
import Tooltip from "../primitives/Tooltip";
import { Button, IconButton } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { MenuRow, Popover } from "../primitives/Popover";
import { Select } from "../primitives/Select";
import { useDesignSharingAvailable } from "../../lib/design-sharing-available";
import { ARTIFACT_EXPANDED, dockLayer, useDockArea } from "./dock-area";
import { ResizableDockSlide } from "./DockSlide";
import { MIN_CHAT_WIDTH, usePanelWidth } from "./panel-width";
import type { DesignPin } from "./ArtifactCanvas";
import { useArtifact } from "./artifact-read";
import { DesignPageShareDialog } from "./DesignPageShareDialog";
import { CommentOptions } from "./CommentOptions";
import { COMMENT_KEY, useCommentKey } from "./comment-key";
import { CanvasBody, PageBody, commentLabel } from "./ArtifactDockBodies";
import { useDockFeedback, type DockFeedback, type DockPage } from "./dock-feedback";
import { libraryDockPage, libraryPageId, libraryRefs } from "./design-library";
import { openDesignLibrary } from "../../lib/design-library-page";

const OPEN_LIBRARY = "open-library";
import { AddToLibraryDialog, type LibrarySource } from "./AddToLibraryDialog";

/** The panel's accessible name: the Cmd+Enter handler finds its own panel by it. */
const ARTIFACT_DOCK_LABEL = "Artifact";

type DockProps = {
  page: DockPage;
  onPage: (page: DockPage) => void;
  hasCanvas: boolean;
  chatId: string;
  designs: ArtifactRef[];
  htmlRef: ArtifactRef | undefined;
  library: DesignLibraryPage[];
  revision: string;
  focus: { id: string | null; nonce: number };
  versions: Record<string, number | null>;
  onVersion: (id: string, version: number | null) => void;
  chosen: { id: string; version: number } | null;
  sent: DesignPin[];
  hostComments: ArtifactComment[];
  onCommentsAdded: () => void;
  openComment?: string;
  openNonce: number;
  onSend?: (text: string, images?: ImageAttachment[]) => Promise<boolean>;
  onClose: () => void;
  staged?: { beside: boolean };
};

function useSendShortcut(onSend: DockProps["onSend"], active: DockFeedback) {
  const sendFromDock = useEffectEvent(() => void active.send());
  const waiting = useEffectEvent(() => active.count > 0);
  useEffect(() => {
    if (!onSend) return;
    const dockOf = (element: Element | null) => element?.closest("[data-slot=artifact-dock]")?.getAttribute("aria-label");
    const ownDock = (element: Element | null) => dockOf(element) === ARTIFACT_DOCK_LABEL;
    const drafting = (element: Element | null) =>
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? !!element.value.trim()
        : element instanceof HTMLElement && element.isContentEditable && !!element.textContent?.trim();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.defaultPrevented || event.isComposing) return;
      if (isModalOpen()) return;
      const focused = document.activeElement;
      if (!ownDock(focused) && (!waiting() || dockOf(focused) || drafting(focused))) return;
      event.preventDefault();
      sendFromDock();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data !== ARTIFACT_SEND || !event.source || isModalOpen()) return;
      const frame = [...document.querySelectorAll("iframe")].find((element) => element.contentWindow === event.source);
      if (frame && ownDock(frame)) sendFromDock();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
    };
  }, [onSend]);
}

/** Expanded by its button, or a Workspace tab in front that isn't shown beside the Chat. */
const fillsWorkspace = (expanded: boolean, staged: { beside: boolean } | undefined) => expanded || (!!staged && !staged.beside);

/**
 * The Artifact panel: one docked panel for the Chat's designs (the canvas) and its HTML page. The title is a menu that
 * switches between them in place, without the panel sliding in again or changing width.
 */
export function ArtifactDock(props: DockProps) {
  const { page, onPage, hasCanvas, chatId, designs, htmlRef, library, onSend, onClose } = props;
  const { artifact, error: pageError } = useArtifact(htmlRef ? chatId : null, htmlRef?.id ?? "", null, htmlRef?.version);
  const html = artifact?.format === "html" ? artifact : null;
  const [expandedByUser, setExpanded] = useState(false);
  const expanded = fillsWorkspace(expandedByUser, props.staged);
  const [sharing, setSharing] = useState<PageShareScope | null>(null);
  const [adding, setAdding] = useState<LibrarySource | null>(null);
  const libraryPage = library.find((item) => item.id === libraryPageId(page));
  const sharingAvailable = useDesignSharingAvailable(chatId);
  const area = useDockArea();
  const reduced = useReducedMotion();
  const [entered, setEntered] = useState(!!reduced);
  const resize = usePanelWidth("artifacts");
  const fits = area ? Math.min(resize.width, area.width - area.simulator - area.browser - 12 - MIN_CHAT_WIDTH) : resize.width;
  const cramped = !!area && fits < Math.min(resize.width, resize.reset);
  const dockWidth = Math.max(resize.min, fits);
  const full = expanded || cramped;
  const [pageTab, setPageTab] = useState<string | null>(null);
  const onSent = () => (cramped ? onClose() : setExpanded(false));
  const shared = {
    chatId,
    designs,
    html,
    versions: props.versions,
    onVersion: props.onVersion,
    sent: props.sent,
    hostComments: props.hostComments,
    openNonce: props.openNonce,
    onSend,
    onCommentsAdded: props.onCommentsAdded,
    onSent,
  };
  const canvasFeedback = useDockFeedback({ ...shared, page: "canvas", openComment: page === "canvas" ? props.openComment : undefined });
  const pageFeedback = useDockFeedback({ ...shared, page: "page", openComment: page === "page" ? props.openComment : undefined });
  const active = page === "page" ? pageFeedback : canvasFeedback;
  const escape = () => {
    if (document.querySelector("[data-slot=design-editor], [data-slot=design-page-share], [data-slot=add-to-library]")) return;
    if (active.commenting) active.setCommenting(false);
    else onClose();
  };
  const onEscape = useEffectEvent(escape);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      onEscape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useCommentKey(!!onSend, active.toggleComment);
  useSendShortcut(onSend, active);
  const shareDesign = useCallback((design: ArtifactRef) => setSharing({ kind: "design", designId: design.id }), []);
  const addDesign = useCallback((design: ArtifactRef) => setAdding({ designId: design.id, title: design.title }), []);
  const addPage =
    html && !html.assets?.length
      ? () =>
          setAdding({ designId: html.id, title: artifactTab(html, pageTab)?.title ?? html.title, tab: html.tabs ? artifactTab(html, pageTab)?.id : undefined })
      : undefined;
  return createPortal(
    <ResizableDockSlide
      panel="artifacts"
      label="Resize the Artifact panel"
      width={full ? null : dockWidth}
      reserve="--artifact-dock"
      onEntered={() => setEntered(true)}
      role="dialog"
      aria-label={ARTIFACT_DOCK_LABEL}
      aria-modal="false"
      data-slot="artifact-dock"
      data-page={page}
      data-full={full || undefined}
      style={
        full && area
          ? {
              top: area.top,
              left: area.left,
              right: `calc(${area.right + 12}px + var(--simulator-dock, 0px) + var(--browser-dock, 0px))`,
              bottom: area.bottom,
            }
          : {
              top: area?.top ?? 40,
              right: `calc(${(area?.right ?? 0) + 12}px + var(--simulator-dock, 0px) + var(--browser-dock, 0px))`,
              bottom: area?.bottom ?? 12,
            }
      }
      className="fixed z-[41]"
      panelClassName="overflow-hidden rounded-window bg-surface text-ink shadow-card"
    >
      <DockHeader
        page={page}
        hasCanvas={hasCanvas}
        html={html}
        htmlRef={htmlRef}
        library={library}
        tab={pageTab}
        onChoose={(next, tab) => {
          if (next === "page") setPageTab(tab);
          if (next !== page) onPage(next);
        }}
        onOpenLibrary={() => openDesignLibrary(libraryProject(chatId))}
        feedback={active}
        canComment={!!onSend}
        cramped={cramped}
        expanded={expanded}
        onExpand={() => {
          if (!expanded) window.dispatchEvent(new Event(ARTIFACT_EXPANDED));
          setExpanded(!expanded);
        }}
        onShare={sharingAvailable && !libraryPage ? setSharing : undefined}
        onAddPage={addPage}
        onClose={onClose}
      />
      {page !== "page" ? (
        <CanvasBody
          key={libraryPage ? page : "canvas"}
          chatId={chatId}
          allowLive={entered && !libraryPage}
          library={!!libraryPage}
          designs={libraryPage ? libraryRefs(libraryPage) : designs}
          versions={props.versions}
          onVersion={props.onVersion}
          focus={props.focus}
          chosen={props.chosen}
          feedback={canvasFeedback}
          canComment={!!onSend && !libraryPage}
          onShare={sharingAvailable && !libraryPage ? shareDesign : undefined}
          onAddToLibrary={libraryPage ? undefined : addDesign}
        />
      ) : entered ? (
        <PageBody
          chatId={chatId}
          page={html}
          error={pageError}
          tab={pageTab}
          onTab={setPageTab}
          feedback={pageFeedback}
          canComment={!!onSend}
          onEscape={escape}
        />
      ) : (
        <div className="min-h-0 flex-1 bg-canvas" />
      )}
      {adding && (
        <AddToLibraryDialog
          chatId={chatId}
          pages={library}
          source={adding}
          onClose={() => setAdding(null)}
          onAdded={(entry) => {
            setAdding(null);
            onPage(libraryDockPage(entry.page));
          }}
        />
      )}
      {sharing && (
        <DesignPageShareDialog
          key={`${chatId}:${sharing.kind}:${sharing.designId ?? ""}`}
          chatId={chatId}
          scope={sharing}
          revision={props.revision}
          onClose={() => setSharing(null)}
        />
      )}
    </ResizableDockSlide>,
    dockLayer(),
  );
}

function PageMenu({
  page,
  hasCanvas,
  html,
  htmlRef,
  library,
  tab,
  onChoose,
  onOpenLibrary,
}: {
  page: DockPage;
  hasCanvas: boolean;
  html: HtmlArtifact | null;
  htmlRef: ArtifactRef | undefined;
  library: DesignLibraryPage[];
  tab: string | null;
  onChoose: (page: DockPage, tab: string | null) => void;
  onOpenLibrary: () => void;
}) {
  const title = html?.title ?? htmlRef?.title ?? "Page";
  const tabs = html?.tabs && html.tabs.length > 1 ? html.tabs : null;
  const shownTab = html ? artifactTab(html, tab) : null;
  const canvasIcon = <Icon icon={PaintBoardIcon} size={16} />;
  const pageIcon = <Icon icon={File01Icon} size={16} />;
  const libraryIcon = <Icon icon={LibraryIcon} size={16} />;
  const titled = (text: string, detail?: string) => (
    <span data-slot="artifact-dock-title" className="min-w-0 truncate text-13">
      {text}
      {detail && <span className="text-ink-3"> · {detail}</span>}
    </span>
  );
  const options = [
    ...(hasCanvas ? [{ value: "canvas", label: "Canvas", icon: canvasIcon, display: titled("Canvas") }] : []),
    ...(htmlRef
      ? tabs
        ? tabs.map((item) => ({ value: `page:${item.id}`, label: item.title, icon: pageIcon, group: title, display: titled(title, item.title) }))
        : [{ value: "page:", label: title, icon: pageIcon, display: titled(title) }]
      : []),
    ...library.map((item) => ({
      value: libraryDockPage(item.id),
      label: item.name,
      icon: libraryIcon,
      group: "Project library",
      display: titled("Project library", item.name),
    })),
    ...(library.length ? [{ value: OPEN_LIBRARY, label: "Open Designs", icon: <Icon icon={LinkSquare02Icon} size={16} />, group: "Project library" }] : []),
  ];
  const value = page === "page" ? `page:${tabs && shownTab ? shownTab.id : ""}` : page;
  const shownLibrary = library.find((item) => item.id === libraryPageId(page));
  if (options.length < 2)
    return shownLibrary
      ? titled("Project library", shownLibrary.name)
      : titled(page === "canvas" ? "Canvas" : title, page === "page" && tabs && shownTab ? shownTab.title : undefined);
  const current = options.find((option) => option.value === value) ?? options[0]!;
  return (
    <Select
      label={`${page === "page" && tabs ? `${title}, ${current.label} tab` : current.label}. Choose what the panel shows`}
      variant="text"
      width={240}
      value={current.value}
      options={options}
      onChange={(next) =>
        next === OPEN_LIBRARY
          ? onOpenLibrary()
          : next.startsWith("page:")
            ? onChoose("page", next.slice("page:".length) || null)
            : onChoose(next as DockPage, null)
      }
    />
  );
}

function DockHeader({
  page,
  hasCanvas,
  html,
  htmlRef,
  library,
  tab,
  onChoose,
  onOpenLibrary,
  feedback,
  canComment,
  cramped,
  expanded,
  onExpand,
  onShare,
  onAddPage,
  onClose,
}: {
  page: DockPage;
  hasCanvas: boolean;
  html: HtmlArtifact | null;
  htmlRef: ArtifactRef | undefined;
  library: DesignLibraryPage[];
  tab: string | null;
  onChoose: (page: DockPage, tab: string | null) => void;
  onOpenLibrary: () => void;
  feedback: DockFeedback;
  canComment: boolean;
  cramped: boolean;
  expanded: boolean;
  onExpand: () => void;
  onShare?: (scope: PageShareScope) => void;
  onAddPage?: () => void;
  onClose: () => void;
}) {
  const more = useRef<HTMLSpanElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const label = commentLabel(feedback, page);
  return (
    <header className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-2">
      <Icon icon={page === "canvas" ? PaintBoardIcon : page === "page" ? File01Icon : LibraryIcon} size={14} />
      <div className="ml-1 flex min-w-0 flex-1 items-center gap-2">
        <PageMenu
          page={page}
          hasCanvas={hasCanvas}
          html={html}
          htmlRef={htmlRef}
          library={library}
          tab={tab}
          onChoose={onChoose}
          onOpenLibrary={onOpenLibrary}
        />
      </div>
      {feedback.count > 0 && (
        <Tooltip label={feedback.error || "Send to the agent"}>
          <Button
            variant={feedback.error ? "danger" : "primary"}
            size={24}
            data-slot="artifact-send"
            disabled={feedback.sending}
            onClick={() => void feedback.send()}
            className="mr-1"
          >
            {feedback.error ? "Retry send" : "Send"}
            <span className={`rounded-full px-1.5 text-11 tabular-nums ${feedback.error ? "bg-on-red/20" : "bg-on-ink/20"}`}>{feedback.count}</span>
          </Button>
        </Tooltip>
      )}
      {onShare && (
        <Tooltip label={hasCanvas && htmlRef ? "Share the designs and the page" : "Share"}>
          <IconButton label="Share" icon={Share08Icon} size={24} data-slot="artifact-share" onClick={() => onShare({ kind: "workspace" })} />
        </Tooltip>
      )}
      {page === "page" && ((onShare && hasCanvas) || onAddPage) && (
        <span ref={more} className="inline-flex">
          <IconButton
            label="More actions for the page"
            icon={MoreHorizontalIcon}
            size={24}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          />
          {moreOpen && (
            <Popover anchor={more} label="Page actions" onClose={() => setMoreOpen(false)}>
              {onShare && hasCanvas && (
                <MenuRow
                  data-slot="artifact-share-page"
                  icon={Share08Icon}
                  title="Share this page…"
                  onClick={() => {
                    setMoreOpen(false);
                    onShare({ kind: "artifacts" });
                  }}
                />
              )}
              {onAddPage && (
                <MenuRow
                  data-slot="artifact-add-library"
                  icon={LibraryIcon}
                  title="Add to Project library…"
                  onClick={() => {
                    setMoreOpen(false);
                    onAddPage();
                  }}
                />
              )}
            </Popover>
          )}
        </span>
      )}
      {page === "page" && (
        <CommentOptions shown={feedback.showResolved} onChange={feedback.setShowResolved}>
          <Tooltip label={`${label}. Right-click or hold for comment options`} keyHint={COMMENT_KEY}>
            <IconButton
              label={label}
              icon={Comment01Icon}
              size={24}
              tone="accent"
              aria-pressed={feedback.commenting}
              disabled={!canComment}
              onClick={feedback.toggleComment}
            />
          </Tooltip>
        </CommentOptions>
      )}
      {!cramped && (
        <IconButton
          label={expanded ? "Show the Chat beside the artifact" : "Fill the window with the artifact"}
          icon={expanded ? ArrowShrink01Icon : ArrowExpand01Icon}
          size={24}
          aria-pressed={expanded}
          onClick={onExpand}
        />
      )}
      <IconButton label="Close the Artifact panel" icon={Cancel01Icon} size={24} onClick={onClose} />
    </header>
  );
}
