import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle02Icon, Delete02Icon, Link04Icon, Tick02Icon, Unlink04Icon } from "@hugeicons/core-free-icons";
import {
  canLinkProjects,
  findLink,
  LINK_PROBLEM_LABEL,
  linkAskMessage,
  linkedEndLabel,
  linkedEnds,
  linkEndpoints,
  linkProblem,
  type LinkScope,
} from "@milagre/shared/chat-links";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { ProjectLink } from "@/electron";
import { ScrollArea } from "../primitives/ScrollArea";
import { useDismiss } from "../../lib/use-dismiss";
import { TOAST_CLASS } from "../../lib/toast";
import type { SidebarRecent } from "./ChatRow";

/* ─────────────────────────────────────────────────────────
 * SIDEBAR LINKS
 * The canvas Links (spec 003) as the sidebar shows and makes
 * them: the Link icon and hover-card lines on linked rows, the
 * popover a drop or "Link with…" opens (scope, Always allow,
 * Link and ask), the chat list behind "Link with…", the list
 * behind "Remove Link with…", and the toast that undoes them.
 * One provider serves every Project's chat list, so a chat
 * dropped on another Project's chat links the two.
 * ───────────────────────────────────────────────────────── */

const TOAST_MS = 6000;
const POPOVER_WIDTH = 320;
const PICKER_WIDTH = 300;

/** One Link that reaches a chat's Worktree, named by its other end. */
export type LinkedEnd = { linkId: string; label: string };
/** A chat in one of the sidebar's lists. */
export type LinkChat = { scopeKey: string; item: SidebarRecent };
type Anchor = { top: number; left: number };
/** A Project's chats as the sidebar lists them, for the Link icons and the "Link with…" list. */
export type LinkScopeChats = { scopeKey: string; projectId: string; projectName: string; rows: SidebarRecent[] };
/** A chat list a drag can land on, so a chat dropped on another Project's chat offers a Link. */
export type LinkListHandle = { scopeKey: string; containers: () => HTMLElement[]; byId: (id: string) => SidebarRecent | undefined };

type SidebarLinksValue = {
  links: ProjectLink[];
  /** The Project id a Link endpoint takes for the list's chats; null when they can't be linked (another computer, a Named Link). */
  projectIdOf: (scopeKey: string) => string | null;
  endsFor: (scopeKey: string, item: SidebarRecent) => LinkedEnd[];
  /** Reads the Links again, so a drag sees ones drawn on the canvas meanwhile. */
  refresh: () => void;
  ask: (source: LinkChat, target: LinkChat, anchor: Anchor) => void;
  pick: (source: LinkChat, anchor: Anchor, mode: "link" | "remove") => void;
  toast: (text: string, options?: ToastOptions) => void;
  register: (handle: LinkListHandle) => () => void;
  lists: () => LinkListHandle[];
};

const NO_ENDS: LinkedEnd[] = [];
/** `kind` leads the toast with its icon: a deletion's trash or Done's check. */
type ToastOptions = { undo?: () => void; left?: number; kind?: "deleted" | "done" };
const TOAST_ICONS = { deleted: Delete02Icon, done: CheckmarkCircle02Icon };

const SidebarLinksContext = createContext<SidebarLinksValue>({
  links: [],
  projectIdOf: () => null,
  endsFor: () => NO_ENDS,
  refresh: () => {},
  ask: () => {},
  pick: () => {},
  toast: () => {},
  register: () => () => {},
  lists: () => [],
});

export const useSidebarLinks = () => useContext(SidebarLinksContext);

const worktreeOf = (projectId: string, item: SidebarRecent) => (item.details?.path ? { project_id: projectId, worktree_path: item.details.path } : null);
const sideName = (item: SidebarRecent) => item.details?.branch ?? item.label;

function HugeIcon({ icon, size = 16 }: { icon: Parameters<typeof HugeiconsIcon>[0]["icon"]; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" />;
}

export function SidebarLinksProvider({
  scopes,
  projects,
  onAskChat,
  children,
}: {
  scopes: LinkScopeChats[];
  /** This Mac's registered Projects, to name a Link's end in a Project the sidebar doesn't list. */
  projects: ReadonlyArray<{ id: string; name: string }>;
  /** "Link and ask A…": sends the message to chat A through the normal send path. */
  onAskChat?: (scopeKey: string, id: string, message: { body: string; prompt: string }) => Promise<unknown>;
  children: ReactNode;
}) {
  const [links, setLinks] = useState<ProjectLink[]>([]);
  const [asking, setAsking] = useState<{ source: LinkChat; target: LinkChat; anchor: Anchor } | null>(null);
  const [picking, setPicking] = useState<{ source: LinkChat; anchor: Anchor; mode: "link" | "remove" } | null>(null);
  const [toast, setToast] = useState<{ text: string; left: number; undo?: () => void; kind?: ToastOptions["kind"] } | null>(null);
  const handles = useRef(new Set<LinkListHandle>());
  const latest = useRef({ scopes, projects, onAskChat });
  latest.current = { scopes, projects, onAskChat };

  const read = useCallback(async () => {
    const bridge = window.milagre;
    if (!bridge) return;
    let next: unknown;
    try {
      next = await bridge.getLinks?.();
    } catch {
      next = undefined;
    }
    // A Mac that predates canvas:links still has them in the canvas snapshot.
    if (!Array.isArray(next))
      try {
        next = (await bridge.getCanvas?.())?.links;
      } catch {
        return;
      }
    if (Array.isArray(next)) setLinks(next as ProjectLink[]);
  }, []);
  useEffect(() => {
    void read();
    return window.milagre?.onLinksChanged?.((next) => Array.isArray(next) && setLinks(next));
  }, [read]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const showToast = useCallback((text: string, options: ToastOptions = {}) => {
    const left = options.left ?? (document.querySelector("aside")?.getBoundingClientRect().right ?? 0) + 12;
    setToast({ text, undo: options.undo, left, kind: options.kind });
  }, []);

  const scopeOf = useCallback((key: string) => scopes.find((scope) => scope.scopeKey === key), [scopes]);
  const projectName = useCallback(
    (id: string) => scopes.find((scope) => scope.projectId === id)?.projectName ?? projects.find((project) => project.id === id)?.name,
    [scopes, projects],
  );
  const branchAt = useCallback(
    (projectId: string, path: string) => {
      for (const scope of scopes) {
        if (scope.projectId !== projectId) continue;
        const row = scope.rows.find((item) => item.details?.path === path && item.details.branch);
        if (row) return row.details?.branch;
      }
      return undefined;
    },
    [scopes],
  );

  // Each row keeps the same array while its Links and their names don't change, so the memo'd rows don't re-render.
  const endsCache = useRef(new Map<string, { key: string; ends: LinkedEnd[] }>());
  const endsFor = useCallback(
    (scopeKey: string, item: SidebarRecent) => {
      const projectId = scopeOf(scopeKey)?.projectId;
      const worktree = projectId ? worktreeOf(projectId, item) : null;
      if (!worktree) return NO_ENDS;
      const ends = linkedEnds(links, worktree).map(({ link, other }) => ({
        linkId: link.id,
        label: linkedEndLabel(other, {
          project: projectName(other.project_id),
          branch: other.worktree_path === undefined ? undefined : branchAt(other.project_id, other.worktree_path),
        }),
      }));
      if (!ends.length) return NO_ENDS;
      const id = `${scopeKey}#${item.id}`;
      const key = ends.map((end) => `${end.linkId}\0${end.label}`).join("\n");
      const cached = endsCache.current.get(id);
      if (cached?.key === key) return cached.ends;
      endsCache.current.set(id, { key, ends });
      return ends;
    },
    [links, scopeOf, projectName, branchAt],
  );

  async function create(ask: { source: LinkChat; target: LinkChat }, choice: { scope: LinkScope; allow: boolean; text: string }) {
    const bridge = window.milagre;
    const sourceProject = scopeOf(ask.source.scopeKey)?.projectId;
    const targetProject = scopeOf(ask.target.scopeKey)?.projectId;
    const a = sourceProject ? worktreeOf(sourceProject, ask.source.item) : null;
    const b = targetProject ? worktreeOf(targetProject, ask.target.item) : null;
    if (!bridge || !a || !b) return;
    const [first, second] = linkEndpoints(a, b, choice.scope);
    let created: ProjectLink | undefined;
    try {
      const next = await bridge.addLink(first, second);
      setLinks(next);
      created = findLink(next, first, second);
    } catch (error) {
      showToast(`Could not create the Link: ${ipcErrorMessage(error)}`);
      return;
    }
    // A step after the Link that fails leaves the Link in place and says what didn't happen, in the phone's words.
    const undo = created && (() => void remove(created!, false));
    if (choice.allow && created) {
      try {
        await bridge.grantDelegations?.(`${ask.source.scopeKey}#${ask.source.item.id}`, created.id);
      } catch (error) {
        showToast(`Link created. Could not always allow Delegations: ${ipcErrorMessage(error)}`, { undo });
        return;
      }
    }
    const text = choice.text.trim();
    if (!text || !latest.current.onAskChat || !ask.target.item.details?.path) return showToast("Link created", { undo });
    const current = latest.current;
    const targetName = targetProject
      ? (current.scopes.find((scope) => scope.projectId === targetProject)?.projectName ??
        current.projects.find((project) => project.id === targetProject)?.name)
      : undefined;
    const message = linkAskMessage(text, {
      label: ask.target.item.label,
      chatRef: `${ask.target.scopeKey}#${ask.target.item.id}`,
      worktreePath: ask.target.item.details.path,
      projectName: targetName,
      branch: ask.target.item.details.branch,
    });
    try {
      await latest.current.onAskChat(ask.source.scopeKey, ask.source.item.id, message);
    } catch (error) {
      showToast(`Link created. Could not ask “${ask.source.item.label}”: ${ipcErrorMessage(error)}`, { undo });
      return;
    }
    showToast(`Link created. Asked “${ask.source.item.label}”.`, { undo });
  }

  async function remove(link: ProjectLink, offerUndo = true) {
    const bridge = window.milagre;
    if (!bridge) return;
    try {
      setLinks(await bridge.removeLink(link.id));
      if (offerUndo)
        showToast("Link removed", {
          // The same Link comes back, id and all, so an Always allow grant on it holds again. A Mac before restore makes a new one.
          undo: () =>
            void (bridge.restoreLink ? bridge.restoreLink(link) : bridge.addLink(link.a, link.b)).then(setLinks, (error) =>
              showToast(`Could not link them again: ${ipcErrorMessage(error)}`),
            ),
        });
    } catch (error) {
      showToast(`Could not remove the Link: ${ipcErrorMessage(error)}`);
    }
  }

  const value = useMemo<SidebarLinksValue>(
    () => ({
      links,
      projectIdOf: (key) => scopeOf(key)?.projectId ?? null,
      endsFor,
      refresh: () => void read(),
      ask: (source, target, anchor) => {
        setPicking(null);
        setAsking({ source, target, anchor });
      },
      pick: (source, anchor, mode) => {
        setAsking(null);
        setPicking({ source, anchor, mode });
      },
      toast: showToast,
      register: (handle) => {
        handles.current.add(handle);
        return () => void handles.current.delete(handle);
      },
      lists: () => [...handles.current],
    }),
    [links, scopeOf, endsFor, read, showToast],
  );

  const focusRow = (chat: LinkChat) =>
    document.querySelector<HTMLElement>(`[data-chat-scope="${CSS.escape(chat.scopeKey)}"] [data-chat-id="${CSS.escape(chat.item.id)}"] [data-row]`)?.focus();

  return (
    <SidebarLinksContext.Provider value={value}>
      {children}
      {asking && (
        <LinkPopover
          source={asking.source}
          target={asking.target}
          anchor={asking.anchor}
          sourceProject={projectName(scopeOf(asking.source.scopeKey)?.projectId ?? "") ?? ""}
          targetProject={projectName(scopeOf(asking.target.scopeKey)?.projectId ?? "") ?? ""}
          projects={canLinkProjects(
            { project_id: scopeOf(asking.source.scopeKey)?.projectId ?? "" },
            { project_id: scopeOf(asking.target.scopeKey)?.projectId ?? "" },
          )}
          canAsk={Boolean(onAskChat)}
          onConfirm={(choice) => {
            const ask = asking;
            setAsking(null);
            focusRow(ask.source);
            void create(ask, choice);
          }}
          onCancel={() => {
            setAsking(null);
            focusRow(asking.source);
          }}
        />
      )}
      {picking && (
        <LinkPicker
          mode={picking.mode}
          anchor={picking.anchor}
          source={picking.source}
          entries={
            picking.mode === "remove"
              ? endsFor(picking.source.scopeKey, picking.source.item).map((end) => ({ key: end.linkId, title: end.label, problem: null }))
              : linkCandidates(scopes, links, picking.source)
          }
          onPick={(key) => {
            const { source, anchor, mode } = picking;
            setPicking(null);
            if (mode === "remove") {
              const link = links.find((item) => item.id === key);
              if (link) void remove(link);
              focusRow(source);
              return;
            }
            const [scopeKey, id] = splitKey(key);
            const item = scopeOf(scopeKey)?.rows.find((row) => row.id === id);
            if (item) setAsking({ source, target: { scopeKey, item }, anchor });
          }}
          onClose={() => {
            setPicking(null);
            focusRow(picking.source);
          }}
        />
      )}
      {toast &&
        createPortal(
          <div
            role="status"
            data-chat-toast
            className={`${TOAST_CLASS} bottom-4 flex items-center gap-3`}
            style={{ left: toast.left, animation: "fade-up 200ms cubic-bezier(0.23,1,0.32,1) both" }}
          >
            {toast.kind && <HugeIcon icon={TOAST_ICONS[toast.kind]} size={16} />}
            <span>{toast.text}</span>
            {toast.undo && (
              <button
                type="button"
                data-chat-toast-undo
                onClick={() => {
                  setToast(null);
                  toast.undo?.();
                }}
                className="relative shrink-0 font-semibold underline-offset-2 before:absolute before:-inset-2 hover:underline"
              >
                Undo
              </button>
            )}
          </div>,
          document.body,
        )}
    </SidebarLinksContext.Provider>
  );
}

// A picker entry's key is the chat's own key, `scope#id`; a scope (a Project path) can hold a "#", the id can't.
const splitKey = (key: string): [string, string] => {
  const at = key.lastIndexOf("#");
  return [key.slice(0, at), key.slice(at + 1)];
};

type PickerEntry = { key: string; title: string; detail?: string; problem: string | null };

/** Every other chat with a Worktree, each saying why it can't be picked when it can't. */
function linkCandidates(scopes: LinkScopeChats[], links: ProjectLink[], source: LinkChat): PickerEntry[] {
  const from = scopes.find((scope) => scope.scopeKey === source.scopeKey);
  const a = from ? worktreeOf(from.projectId, source.item) : null;
  if (!a) return [];
  return scopes.flatMap((scope) =>
    scope.rows.flatMap((item) => {
      if (item.pending || (scope.scopeKey === source.scopeKey && item.id === source.item.id)) return [];
      const b = worktreeOf(scope.projectId, item);
      if (!b) return [];
      const problem = linkProblem(links, a, b);
      return [
        {
          key: `${scope.scopeKey}#${item.id}`,
          title: item.label,
          detail: [scope.projectName, item.details?.branch].filter(Boolean).join(" / "),
          problem: problem && LINK_PROBLEM_LABEL[problem],
        },
      ];
    }),
  );
}

/** Asks before a Link is made; nothing is created until Create Link. Escape or a press outside cancels. */
function LinkPopover({
  source,
  target,
  anchor,
  sourceProject,
  targetProject,
  projects,
  canAsk,
  onConfirm,
  onCancel,
}: {
  source: LinkChat;
  target: LinkChat;
  anchor: Anchor;
  sourceProject: string;
  targetProject: string;
  /** The two chats are in different Projects, so the whole Projects can be linked. */
  projects: boolean;
  canAsk: boolean;
  onConfirm: (choice: { scope: LinkScope; allow: boolean; text: string }) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<LinkScope>("worktrees");
  const [allow, setAllow] = useState(false);
  const [text, setText] = useState("");
  const [top, setTop] = useState(anchor.top);
  useLayoutEffect(() => {
    ref.current?.querySelector<HTMLElement>("[data-link-confirm]")?.focus();
  }, []);
  // Opens beside the row, moved up as far as it needs to stay in the window, again as the message field grows. The
  // height is offsetHeight: the pop-in animation scales the box, which getBoundingClientRect would measure.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const place = () => setTop(Math.max(8, Math.min(anchor.top, window.innerHeight - element.offsetHeight - 8)));
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [anchor.top]);
  useDismiss(true, onCancel, (element) => !!ref.current?.contains(element));
  const confirm = () => onConfirm({ scope, allow, text: canAsk ? text : "" });
  const wholeProjects = scope === "projects";
  const choices: Array<{ key: LinkScope; label: string; detail: string }> = [
    { key: "worktrees", label: "Only these Worktrees", detail: `${sideName(source.item)} and ${sideName(target.item)}` },
    { key: "projects", label: "The whole Projects", detail: `Every Worktree of ${sourceProject} and ${targetProject}, new ones too` },
  ];
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Create Link"
      data-link-popover
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          // Consumed here, so Escape doesn't also stop the open chat's turn.
          event.preventDefault();
          onCancel();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          confirm();
        }
      }}
      className="fixed z-[70] rounded-[12px] bg-surface p-3 shadow-overlay"
      style={{
        top,
        left: Math.min(anchor.left, window.innerWidth - POPOVER_WIDTH - 8),
        width: POPOVER_WIDTH,
        animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both",
        transformOrigin: "top left",
      }}
    >
      <p className="text-[13.5px] font-semibold text-ink">{wholeProjects ? "Link these Projects?" : "Link these Worktrees?"}</p>
      <p data-link-sides className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-2">
        <span className="truncate">{wholeProjects ? sourceProject : sideName(source.item)}</span>
        <span className="shrink-0 text-ink-3">
          <HugeIcon icon={Link04Icon} size={13} />
        </span>
        <span className="truncate">{wholeProjects ? targetProject : sideName(target.item)}</span>
      </p>
      {projects && (
        <div role="radiogroup" aria-label="What the Link joins" data-link-scope className="mt-2.5 flex flex-col gap-px">
          {choices.map((choice) => (
            <button
              key={choice.key}
              type="button"
              role="radio"
              aria-checked={scope === choice.key}
              data-link-scope-choice={choice.key}
              onClick={() => setScope(choice.key)}
              className={`flex w-full items-start gap-2 rounded-[8px] px-2 py-1.5 text-left outline-none focus-visible:bg-hover-2 ${scope === choice.key ? "bg-hover-2" : "hover:bg-hover"}`}
            >
              <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center ${scope === choice.key ? "text-ink" : "text-transparent"}`}>
                <HugeIcon icon={Tick02Icon} size={14} />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] text-ink">{choice.label}</span>
                <span className="block text-[11.5px] leading-snug text-ink-3">{choice.detail}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <p className="mt-2 text-[12.5px] leading-snug text-ink-3">
        Every Chat on either side can read the other side and make Delegations to it, so “{source.item.label}” can ask “{target.item.label}” for changes.
      </p>
      <label data-link-always-allow className="mt-2.5 flex cursor-pointer items-start gap-2 text-[13px] text-ink">
        <input type="checkbox" checked={allow} onChange={(event) => setAllow(event.target.checked)} className="mt-0.5 accent-ink" />
        <span className="min-w-0">
          <span className="block">Always allow Delegations from “{source.item.label}”</span>
          <span className="block text-[11.5px] leading-snug text-ink-3">Same as “Always allow for this Link in this chat” on the approval card.</span>
        </span>
      </label>
      {canAsk && (
        <label className="mt-2.5 block">
          <span className="block text-[12px] font-medium text-ink-2">Ask “{source.item.label}” (optional)</span>
          <textarea
            data-link-ask
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={3}
            placeholder={`What should it ask “${target.item.label}” to do?`}
            className="mt-1 block max-h-40 w-full resize-none rounded-[8px] border border-line bg-field px-2 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
          />
        </label>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-[8px] px-3 py-1.5 text-[13px] text-ink-2 hover:bg-hover-2">
          Cancel
        </button>
        <button type="button" data-link-confirm onClick={confirm} className="rounded-[8px] bg-ink px-3 py-1.5 text-[13px] font-medium text-surface">
          {text.trim() && canAsk ? "Create Link and ask" : "Create Link"}
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** "Link with…" (every other chat, filtered as you type) or "Remove Link with…" (the chat's Links), at the menu's place. */
function LinkPicker({
  mode,
  anchor,
  source,
  entries,
  onPick,
  onClose,
}: {
  mode: "link" | "remove";
  anchor: Anchor;
  source: LinkChat;
  entries: PickerEntry[];
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [top, setTop] = useState(anchor.top);
  useDismiss(true, onClose, (element) => !!ref.current?.contains(element));
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return entries.filter((entry) => words.every((word) => `${entry.title} ${entry.detail ?? ""}`.toLowerCase().includes(word)));
  }, [entries, query]);
  const pickable = shown.filter((entry) => !entry.problem);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const place = () => {
      const height = element.offsetHeight;
      setTop(anchor.top + height > window.innerHeight - 8 ? Math.max(8, window.innerHeight - height - 8) : anchor.top);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [anchor.top]);
  useLayoutEffect(() => {
    ref.current?.querySelector<HTMLElement>(mode === "link" ? "[data-link-search]" : "[data-link-entry]:not(:disabled)")?.focus();
  }, []);
  useEffect(() => setActive(0), [query]);
  const title = mode === "link" ? `Link “${source.item.label}” with…` : `Remove a Link of “${source.item.label}”`;
  const pickActive = () => {
    const entry = pickable[Math.min(active, pickable.length - 1)];
    if (entry) onPick(entry.key);
  };
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={title}
      data-link-picker={mode}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (mode === "link" && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          if (pickable.length) setActive((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + pickable.length) % pickable.length);
        } else if (mode === "link" && event.key === "Enter" && (event.target as HTMLElement).matches("[data-link-search]")) {
          event.preventDefault();
          pickActive();
        }
      }}
      className="fixed z-[70] flex max-h-[360px] flex-col overflow-hidden rounded-[12px] bg-surface p-1.5 shadow-overlay"
      style={{
        top,
        left: Math.min(anchor.left, window.innerWidth - PICKER_WIDTH - 8),
        width: PICKER_WIDTH,
        animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both",
        transformOrigin: "top left",
      }}
    >
      <p className="truncate px-2 pb-1 pt-1 text-[12px] font-medium text-ink-3">{title}</p>
      {mode === "link" && (
        <input
          data-link-search
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search chats"
          aria-label="Search chats"
          className="mx-1 mb-1 h-8 shrink-0 rounded-[8px] border border-line bg-field px-2 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
        />
      )}
      <ScrollArea as="ul" chainScroll className="flex min-h-0 flex-col gap-px">
        {shown.map((entry) => {
          const highlighted = mode === "link" && !entry.problem && pickable[Math.min(active, pickable.length - 1)]?.key === entry.key;
          return (
            <li key={entry.key}>
              <button
                type="button"
                data-link-entry={entry.key}
                disabled={Boolean(entry.problem)}
                onClick={() => onPick(entry.key)}
                className={`flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left outline-none focus-visible:bg-hover-2 disabled:opacity-50 ${highlighted ? "bg-hover-2" : "enabled:hover:bg-hover-2"}`}
              >
                <span className="flex size-5 shrink-0 items-center justify-center text-ink-2">
                  <HugeIcon icon={mode === "link" ? Link04Icon : Unlink04Icon} size={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">{entry.title}</span>
                  {entry.detail && <span className="block truncate text-[11.5px] text-ink-3">{entry.detail}</span>}
                </span>
                {entry.problem && <span className="shrink-0 text-[11.5px] text-ink-3">{entry.problem}</span>}
              </button>
            </li>
          );
        })}
        {!shown.length && (
          <li className="px-2 py-2 text-[12.5px] text-ink-3">
            {entries.length ? "No chats match." : mode === "link" ? "No other chats to link." : "No Links."}
          </li>
        )}
      </ScrollArea>
    </div>,
    document.body,
  );
}
