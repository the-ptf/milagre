import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUpLeft01Icon,
  BotIcon,
  CommandLineIcon,
  ComputerIcon,
  Folder01Icon,
  FolderGitIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  Globe02Icon,
  Link04Icon,
  LinkSquare02Icon,
  Redo03Icon,
  SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import { chatBookmark } from "@milagre/shared/subchats";
import { directSubchats } from "@milagre/shared/subchat-states";
import type { AgentPort, BackgroundTask, Subagent } from "@milagre/shared/model";
import { preferenceStorage as localStorage } from "../../lib/preference-storage.ts";
import { chatSwitching } from "../../lib/chat-switch-timing";
import { DURATION, EASE_OUT, SPRING_LAYOUT, scaled, scaledSpring, useMotionScale } from "../../lib/ease";
import { useDisplayNow } from "../../lib/display-clock";
import { familyEntry, type FamilyEntry, type FamilyReads } from "../../lib/family-menu";
import { Icon } from "../primitives/Icon";
import { IconButton } from "../primitives/Button";
import { ScrollArea } from "../primitives/ScrollArea";
import { SectionLabel } from "../primitives/SectionLabel";
import Tooltip from "../primitives/Tooltip";
import { roomToWiden, usePanelWidth } from "./panel-width";
import { useCloseWhenDesignsExpand, useSidePanelRoom } from "./dock-area";
import { ResizeHandle } from "../primitives/ResizeHandle";
import { useSidePanel } from "./PanelToggles";
import { useComputers } from "../../lib/computers";
import { useRoutines } from "../../lib/routines";
import { openInEditor, useEditors } from "../../lib/editors";

/*
 * The Details panel (ported from the GPUI app's Details tab, after Claude desktop's details sidebar): sections with a
 * muted heading, then 32px rows (a 16px glyph, the label, a muted value) inset 8px from the panel's edges, so a hover
 * fill sits as a block under the text rather than an edge-to-edge band. Sections:
 *
 * - Environment: the computer, the repo, the Worktree's branch and its path (a click copies it; Finder and editor).
 * - Lineage (folds): the open Chat's parent, then its Subchats nested; a row opens that Chat, its muted → showing under
 *   the pointer before its state.
 * - Background tasks (folds): running commands, ports and subagents with their time.
 * - Links (folds), only when the Chat has a PR or canvas Links.
 *
 * It has its own corner toggle and no shortcut. Open or closed holds for every Chat; the folds hold for the session.
 */

const KEY = "milagre.detailsPanel";
let open = localStorage.getItem(KEY) === "1";
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Whether the Details panel is open, and its toggle. */
export function useDetailsPanelOpen() {
  return useSyncExternalStore(subscribe, () => open);
}

export function setDetailsPanelOpen(next: boolean) {
  if (next === open) return;
  open = next;
  localStorage.setItem(KEY, next ? "1" : "0");
  listeners.forEach((listener) => listener());
}

// The folds, kept for the session across Chats.
const folds = { lineage: false, background: false, links: false };

export type DetailsData = {
  /** The open Chat's key (`<scope>#<id>`). */
  chatKey: string;
  computer?: { name: string; state: string; offline?: boolean };
  repo?: string;
  branch?: string;
  path?: string;
  onReveal?: () => void;
  onOpenInEditor?: () => void;
  /** The editor "Open in" uses, for the button's tooltip. */
  editorName?: string;
  /** The family's sessions and live runs, for Lineage. */
  family?: FamilyReads;
  onOpenChat: (key: string) => void;
  backgroundTasks?: BackgroundTask[];
  ports?: AgentPort[];
  subagents?: Subagent[];
  pullRequest?: { number: number; state: string; onOpen: () => void };
  links?: { key: string; label: string; onOpen?: () => void }[];
};

const ROW = "mx-2 flex h-8 shrink-0 items-center gap-2 rounded-control px-2 text-13 text-ink-2";
const CLICKABLE = "cursor-pointer text-left transition-colors hover:bg-hover focus-visible:-outline-offset-2";

function Glyph({ icon, size = 16 }: { icon: Parameters<typeof Icon>[0]["icon"]; size?: 14 | 16 }) {
  return (
    <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-ink-3">
      <Icon icon={icon} size={size} />
    </span>
  );
}

function Value({ children, className = "text-ink-3" }: { children: ReactNode; className?: string }) {
  return <span className={`shrink-0 text-12 ${className}`}>{children}</span>;
}

function Heading({ label, open, onToggle }: { label: string; open?: boolean; onToggle?: () => void }) {
  if (!onToggle)
    return (
      <div className={`${ROW} text-ink-3`}>
        <SectionLabel as="h3">{label}</SectionLabel>
      </div>
    );
  return (
    <button type="button" aria-expanded={open} data-details-toggle={label} onClick={onToggle} className={`${ROW} ${CLICKABLE} w-[calc(100%-16px)] text-ink-3`}>
      <SectionLabel as="span" className="min-w-0 flex-1">
        {label}
      </SectionLabel>
      <Icon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={14} />
    </button>
  );
}

function Section({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section data-details-section={name} className="flex flex-col pb-1">
      {children}
    </section>
  );
}

/** A path or branch cut in its middle so both ends show. */
function middle(text: string, max: number) {
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(text.length - (max - 1 - half))}`;
}

function elapsed(since: number, now: number) {
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A Lineage row: opens that Chat; a muted arrow shows before its state under the pointer. */
function LineageRow({
  entry,
  icon,
  value,
  depth = 0,
  onOpen,
}: {
  entry: FamilyEntry;
  icon: "parent" | "child";
  value: string;
  depth?: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      data-details-lineage={entry.key}
      onClick={onOpen}
      className={`group/lineage ${ROW} ${CLICKABLE} w-[calc(100%-16px)]`}
      style={depth ? { paddingLeft: 8 + depth * 16 } : undefined}
    >
      <Glyph icon={icon === "parent" ? ArrowUpLeft01Icon : Redo03Icon} size={icon === "parent" ? 16 : 14} />
      <span className="min-w-0 flex-1 truncate">{entry.title}</span>
      <span
        aria-hidden
        data-details-arrow
        className="flex shrink-0 text-ink-3 opacity-0 transition-opacity group-hover/lineage:opacity-100 group-focus-visible/lineage:opacity-100"
      >
        →
      </span>
      <Value className={icon === "parent" ? "text-ink-3" : entry.ink}>{value}</Value>
    </button>
  );
}

/** The open Chat's Subchats at every depth, in order, each with how far in it sits. */
function descendants(family: FamilyReads, key: string, depth = 0): { key: string; depth: number }[] {
  return directSubchats(family.sessions, key).flatMap((child) => [{ key: child, depth }, ...descendants(family, child, depth + 1)]);
}

export function DetailsBody({ data }: { data: DetailsData }) {
  const [, rerender] = useState(0);
  const fold = (name: keyof typeof folds) => () => {
    folds[name] = !folds[name];
    rerender((n) => n + 1);
  };
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const running = (data.subagents ?? []).filter((agent) => agent.status === "running" || agent.status === "initializing" || agent.status === "waiting");
  const tasks = data.backgroundTasks ?? [];
  const ports = data.ports ?? [];
  const busy = running.length + tasks.length + ports.length > 0;
  const now = useDisplayNow(1000, busy);

  const bookmark = data.family ? chatBookmark(data.family.sessions, data.chatKey) : null;
  const parent = data.family && bookmark ? familyEntry(bookmark.parent, data.family, false) : null;
  const children = data.family
    ? descendants(data.family, data.chatKey).flatMap(({ key, depth }) => {
        const entry = familyEntry(key, data.family!, true);
        return entry ? [{ entry, depth }] : [];
      })
    : [];
  const hasLinks = Boolean(data.pullRequest) || Boolean(data.links?.length);

  return (
    <ScrollArea data-details-body className="flex min-h-0 shrink flex-col gap-3 pt-3 pb-3">
      <Section name="environment">
        <Heading label="Environment" />
        {data.computer && (
          <div className={ROW}>
            <Glyph icon={ComputerIcon} />
            <span className="min-w-0 flex-1 truncate">{data.computer.name}</span>
            <Value className={data.computer.offline ? "text-orange-ink" : "text-ink-3"}>{data.computer.state}</Value>
          </div>
        )}
        {data.repo && (
          <div className={ROW}>
            <Glyph icon={FolderGitIcon} />
            <span className="min-w-0 flex-1 truncate">{data.repo}</span>
          </div>
        )}
        {data.branch && (
          <Tooltip label={data.branch} side="bottom" className="w-full">
            <div data-details-branch className={`${ROW} w-[calc(100%-16px)]`}>
              <Glyph icon={GitBranchIcon} />
              <span className="min-w-0 flex-1 truncate">{middle(data.branch, 34)}</span>
            </div>
          </Tooltip>
        )}
        {data.path && (
          <div data-details-path className={`${ROW} pr-1 transition-colors hover:bg-hover`}>
            <Tooltip label={data.path} side="bottom" className="min-w-0 flex-1">
              <button
                type="button"
                aria-label={`Copy ${data.path}`}
                onClick={() => {
                  void navigator.clipboard.writeText(data.path!).catch(() => {});
                  setCopied(true);
                }}
                className="flex h-8 min-w-0 flex-1 items-center gap-2 text-left"
              >
                <Glyph icon={Folder01Icon} />
                <span className="min-w-0 flex-1 truncate">{middle(data.path, 26)}</span>
              </button>
            </Tooltip>
            {copied ? (
              <span className="shrink-0 pr-1 text-12 text-green-ink">Copied</span>
            ) : (
              <>
                {data.onReveal && <IconButton size={24} label="Show in Finder" icon={FolderOpenIcon} onClick={data.onReveal} />}
                {data.onOpenInEditor && (
                  <IconButton
                    size={24}
                    label={data.editorName ? `Open in ${data.editorName}` : "Open in editor"}
                    icon={SourceCodeIcon}
                    onClick={data.onOpenInEditor}
                  />
                )}
              </>
            )}
          </div>
        )}
      </Section>
      {(parent || children.length > 0) && (
        <Section name="lineage">
          <Heading label="Lineage" open={!folds.lineage} onToggle={fold("lineage")} />
          {!folds.lineage && (
            <>
              {parent && <LineageRow entry={parent} icon="parent" value="Parent" onOpen={() => data.onOpenChat(parent.key)} />}
              {children.map(({ entry, depth }) => (
                <LineageRow key={entry.key} entry={entry} icon="child" value={entry.word} depth={depth} onOpen={() => data.onOpenChat(entry.key)} />
              ))}
            </>
          )}
        </Section>
      )}
      <Section name="background">
        <Heading label="Background tasks" open={!folds.background} onToggle={fold("background")} />
        {!folds.background && (
          <>
            {tasks
              .filter((task) => !ports.some((port) => port.taskId === task.id))
              .map((task) => (
                <div key={task.id} className={ROW}>
                  <Glyph icon={CommandLineIcon} />
                  <span className="min-w-0 flex-1 truncate">{task.title}</span>
                  <Value>{elapsed(task.startedAt, now)}</Value>
                </div>
              ))}
            {ports.map((port) => (
              <div key={`${port.pid}:${port.port}`} className={ROW}>
                <Glyph icon={Globe02Icon} />
                <span className="min-w-0 flex-1 truncate">{port.command}</span>
                <Value>:{port.port}</Value>
              </div>
            ))}
            {running.map((agent) => (
              <div key={agent.id} className={ROW}>
                <Glyph icon={BotIcon} />
                <span className="min-w-0 flex-1 truncate">{agent.title}</span>
                <Value>{elapsed(agent.startedAt, now)}</Value>
              </div>
            ))}
            {!busy && <div className="flex h-8 items-center px-4 text-13 text-ink-3">Nothing running</div>}
          </>
        )}
      </Section>
      {hasLinks && (
        <Section name="links">
          <Heading label="Links" open={!folds.links} onToggle={fold("links")} />
          {!folds.links && (
            <>
              {data.pullRequest && (
                <button type="button" data-details-pr onClick={data.pullRequest.onOpen} className={`${ROW} ${CLICKABLE} w-[calc(100%-16px)]`}>
                  <Glyph icon={GitPullRequestIcon} />
                  <span className="min-w-0 flex-1 truncate">Pull request #{data.pullRequest.number}</span>
                  <Value>{data.pullRequest.state}</Value>
                </button>
              )}
              {data.links?.map((link) =>
                link.onOpen ? (
                  <button key={link.key} type="button" onClick={link.onOpen} className={`${ROW} ${CLICKABLE} w-[calc(100%-16px)]`}>
                    <Glyph icon={Link04Icon} />
                    <span className="min-w-0 flex-1 truncate">{link.label}</span>
                    <Value>Linked</Value>
                  </button>
                ) : (
                  <div key={link.key} className={ROW}>
                    <Glyph icon={LinkSquare02Icon} />
                    <span className="min-w-0 flex-1 truncate">{link.label}</span>
                    <Value>Linked</Value>
                  </div>
                ),
              )}
            </>
          )}
        </Section>
      )}
    </ScrollArea>
  );
}

/**
 * The panel's column beside the Changes panel, as ChangesPanelSlot: its width springs open from zero so the chat narrows
 * with it, and its left edge drags its width. A Chat switch opens or closes it at once.
 */
export function DetailsPanelSlot({ data }: { data: DetailsData | null }) {
  const shown = useDetailsPanelOpen() && data !== null;
  const scale = useMotionScale();
  const [sliding, setSliding] = useState(false);
  const resize = usePanelWidth("details");
  const close = () => setDetailsPanelOpen(false);
  useCloseWhenDesignsExpand(close);
  useSidePanelRoom("details", shown, resize.width + 12, close);
  // Its corner toggle, while a Chat is open; no shortcut.
  useSidePanel("details", data ? { open: shown, toggle: () => setDetailsPanelOpen(!open) } : null);
  const atOnce = chatSwitching();
  const spring = scaledSpring(SPRING_LAYOUT, scale);
  const fade = { duration: scaled(DURATION.slow, scale), ease: EASE_OUT };
  return (
    <AnimatePresence initial={false} custom={atOnce}>
      {shown && (
        <motion.div
          key="details-panel"
          data-details-slot
          className={`relative z-[42] -ml-3 flex min-h-0 shrink-0 ${sliding ? "overflow-hidden" : "overflow-visible"}`}
          onAnimationStart={() => setSliding(true)}
          onAnimationComplete={() => setSliding(false)}
          custom={atOnce}
          variants={{ closed: (now: boolean) => ({ width: 0, transition: now ? { duration: 0 } : spring }), open: { width: "auto" } }}
          initial={atOnce ? false : "closed"}
          animate="open"
          exit="closed"
          transition={spring}
        >
          <motion.div
            className="relative flex min-h-0 pt-[var(--window-chrome-height)] pr-3 pb-3"
            custom={atOnce}
            variants={{ closed: (now: boolean) => ({ opacity: 0, x: 24, transition: now ? { duration: 0 } : fade }), open: { opacity: 1, x: 0 } }}
            initial={atOnce ? false : "closed"}
            animate="open"
            exit="closed"
            transition={fade}
          >
            <div className="absolute top-[var(--window-chrome-height)] bottom-3 left-0">
              <ResizeHandle
                label="Resize details panel"
                side="left"
                width={resize.width}
                min={resize.min}
                max={() => roomToWiden("details", resize.width)}
                reset={resize.reset}
                onResize={resize.onResize}
                onCommit={resize.onCommit}
              />
            </div>
            <div
              data-details-panel
              role="complementary"
              aria-label="Details"
              // As tall as its sections, up to the window; it scrolls past that.
              className="flex max-h-full min-h-0 shrink-0 flex-col self-start overflow-hidden rounded-window bg-surface shadow-card"
              style={{ width: resize.width }}
            >
              {data && <DetailsBody data={data} />}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** The open Chat's Details, gathered from what App already reads; nothing over a Link or with no Chat open. */
export function DetailsPanelHost({
  chatKey,
  project,
  worktree,
  remoteComputer,
  family,
  backgroundTasks,
  ports,
  subagents,
  pullRequest,
  onOpenChat,
  onReveal,
}: {
  chatKey: string | null;
  project?: { name: string; path: string };
  worktree?: { name: string; path: string };
  /** The paired computer the Chat runs on; undefined for this Mac. */
  remoteComputer?: { name: string; offline: boolean };
  /** Shows the Worktree in Finder (this Mac's Chats only). */
  onReveal?: () => void;
  family?: Omit<FamilyReads, "routines" | "now">;
  backgroundTasks?: BackgroundTask[];
  ports?: AgentPort[];
  subagents?: Subagent[];
  pullRequest?: DetailsData["pullRequest"];
  onOpenChat: (key: string) => void;
}) {
  const { thisMac } = useComputers();
  const { routines } = useRoutines();
  const { editor } = useEditors();
  // Lineage's states ("Working 2m") read the clock to the minute.
  const now = useDisplayNow(60_000, Boolean(chatKey && family));
  const local = !remoteComputer;
  const data: DetailsData | null = chatKey
    ? {
        chatKey,
        computer: remoteComputer
          ? { name: remoteComputer.name, state: remoteComputer.offline ? "Offline" : "Paired", offline: remoteComputer.offline }
          : { name: thisMac, state: "This computer" },
        repo: project?.name,
        branch: worktree?.name,
        path: worktree?.path,
        onReveal: local && worktree ? onReveal : undefined,
        onOpenInEditor: local && worktree ? () => void openInEditor(worktree.path) : undefined,
        editorName: editor?.name,
        family: family ? { ...family, routines, now } : undefined,
        onOpenChat,
        backgroundTasks,
        ports,
        subagents,
        pullRequest,
      }
    : null;
  return <DetailsPanelSlot data={data} />;
}
