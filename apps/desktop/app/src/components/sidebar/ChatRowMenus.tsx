import { readWithTimeout } from "@milagre/shared/read-timeout";
import { type LinearIssue } from "@milagre/shared/linear";
import { LinearLogo } from "../ProviderLogo";
import { LinearIssuePicker } from "../LinearIssuePicker";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  ArrowRight01Icon,
  Delete02Icon,
  CircleIcon,
  Copy01Icon,
  FolderOpenIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  Link04Icon,
  PencilEdit02Icon,
  PinIcon,
  PinOffIcon,
  Refresh01Icon,
  Bug01Icon,
  SourceCodeIcon,
  Tick02Icon,
  Undo02Icon,
  Unlink04Icon,
} from "@hugeicons/core-free-icons";
import GlideMenu from "@/components/primitives/GlideMenu";
import { archiveMode, type ArchivePlan } from "@/lib/archive";
import { useEditors } from "@/lib/editors";
import { ScrollArea } from "../primitives/ScrollArea";
import { useDismiss } from "../../lib/use-dismiss";
import { RELOAD_HINT } from "@milagre/shared/chat-reload";
import { UI_COPY } from "@milagre/shared/model-copy";
import { fileManager } from "@/lib/shortcut-hints";
import { snoozeChoices, snoozeTimeLabel, type SnoozePreset } from "@milagre/shared/snooze";
import { useSettings } from "../../lib/settings";
import { HugeIcon } from "./ChatMarks";
import type { SidebarRecent, ChatRowActions } from "./ChatRow";
import { HIDE_ONLY, MENU_WIDTH, SUB_MENU_WIDTH, type MenuEntry } from "./chat-row-parts";

export function LinkIssuePopover({
  position,
  onPick,
  onClose,
}: {
  position: { x: number; y: number };
  onPick: (issue: LinearIssue) => void;
  onClose: () => void;
}) {
  useDismiss(true, onClose, (target) => !!target.closest("[data-picker-panel]"));
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(position.y);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const place = () => {
      const height = element.getBoundingClientRect().height;
      setTop(position.y + height > window.innerHeight - 8 ? Math.max(8, position.y - height - 8) : position.y);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [position.y]);
  return createPortal(
    <div ref={ref} data-linear-link-picker className="fixed z-[70]" style={{ top, left: Math.min(position.x, window.innerWidth - 420 - 8) }}>
      <LinearIssuePicker className="w-[420px] max-w-[calc(100vw-2rem)]" title="Link a Linear issue" onPick={onPick} onClose={onClose} />
    </div>,
    document.body,
  );
}

const DETAILS_OMIT: ReadonlySet<string> = new Set(["report-bug", "read", "unread", "reveal", "editor", "commit", "pin", "unpin"]);

export function ChatContextMenu({
  item,
  position,
  actions,
  onRename,
  onClose,
}: {
  item: SidebarRecent;
  position: { x: number; y: number };
  actions: ChatRowActions;
  onRename: () => void;
  onClose: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(true);
  const [linking, setLinking] = useState<{ x: number; y: number } | null>(null);
  const at = { x: Math.min(position.x, window.innerWidth - MENU_WIDTH - 8), y: position.y };
  useEffect(() => {
    if (!menuOpen && !linking) onClose();
  }, [menuOpen, linking, onClose]);
  return (
    <>
      {menuOpen && (
        <ChatMenu
          item={item}
          position={at}
          trigger={trigger}
          onClose={() => setMenuOpen(false)}
          onRename={onRename}
          onLink={() => setLinking(at)}
          linked={false}
          actions={actions}
          omit={DETAILS_OMIT}
        />
      )}
      {linking && (
        <LinkIssuePopover
          position={linking}
          onPick={(issue) => {
            setLinking(null);
            actions.onLinkIssue?.(item.id, issue.key, issue.workspace);
          }}
          onClose={() => setLinking(null)}
        />
      )}
    </>
  );
}

type MenuContext = {
  item: SidebarRecent;
  actions: ChatRowActions;
  run: (action: () => void) => () => void;
};

function archiveEntries({ item, actions, run }: MenuContext, deletionPlan: ArchivePlan, openedAt: number, presets: SnoozePreset[]): MenuEntry[] {
  const choices = snoozeChoices(openedAt, presets);
  const snoozeItems: MenuEntry[] = item.doneAt
    ? []
    : item.snoozedUntil
      ? actions.onWake
        ? [
            {
              key: "wake",
              label: "Wake",
              icon: AlarmClockOffIcon,
              hint: `Snoozed until ${snoozeTimeLabel(item.snoozedUntil, openedAt)}`,
              onSelect: run(() => actions.onWake?.(item.id)),
            },
          ]
        : []
      : actions.onSnooze && choices.length > 0
        ? [
            {
              key: "snooze",
              label: "Snooze",
              icon: AlarmClockIcon,
              onSelect: () => {},
              sub: choices.map((choice) => ({
                key: choice.id,
                label: choice.label,
                detail: snoozeTimeLabel(choice.until, openedAt),
                onSelect: run(() => actions.onSnooze?.(item.id, choice.until)),
              })),
            },
          ]
        : [];
  return [
    ...snoozeItems,
    ...(actions.onDone && !item.doneAt
      ? [
          {
            key: "done",
            label: "Mark Done",
            icon: Tick02Icon,
            onSelect: run(() => actions.onDone?.(item.id)),
          },
        ]
      : actions.onReopen && item.doneAt
        ? [
            {
              key: "reopen",
              label: "Reopen",
              icon: Undo02Icon,
              onSelect: run(() => actions.onReopen?.(item.id)),
            },
          ]
        : []),
    {
      key: "archive",
      label: "Delete",
      icon: Delete02Icon,
      danger: true,
      onSelect: run(() => actions.onArchive?.(item.id, archiveMode(deletionPlan), deletionPlan)),
      disabled: !actions.onArchive,
    },
  ];
}

function chatEntries(
  { item, actions, run }: MenuContext,
  {
    details,
    copy,
    onRename,
    onLink,
  }: { details: NonNullable<SidebarRecent["details"]>; copy: (text: string) => () => void; onRename: () => void; onLink: () => void },
): MenuEntry[] {
  return [
    ...(actions.gitless
      ? []
      : [
          {
            key: "copy-path",
            label: "Copy path",
            icon: Copy01Icon,
            onSelect: copy(details.path ?? ""),
            disabled: !details.path,
          },
          {
            key: "copy-branch",
            label: "Copy branch name",
            icon: GitBranchIcon,
            onSelect: copy(details.branch ?? ""),
            disabled: !details.branch,
          },
        ]),
    {
      key: "rename",
      label: UI_COPY.renameChat,
      icon: PencilEdit02Icon,
      onSelect: run(onRename),
      disabled: !actions.onRename,
    },
    {
      key: "reload",
      label: UI_COPY.reloadChat,
      icon: Refresh01Icon,
      hint: RELOAD_HINT,
      onSelect: run(() => actions.onReload?.(item.id)),
      disabled: !actions.onReload,
    },
    ...(actions.onReportBug
      ? [
          {
            key: "report-bug",
            label: UI_COPY.reportMilagreBug,
            icon: Bug01Icon,
            onSelect: run(() => actions.onReportBug?.(item.id)),
          },
        ]
      : []),
    ...(details.linkable
      ? details.linearKey
        ? [
            {
              key: "unlink-issue",
              label: "Unlink issue",
              leading: <LinearLogo size={14} />,
              onSelect: run(() => actions.onUnlinkIssue?.(item.id)),
              disabled: !actions.onUnlinkIssue,
            },
          ]
        : [
            {
              key: "link-issue",
              label: "Link issue…",
              leading: <LinearLogo size={14} />,
              onSelect: run(onLink),
              disabled: !actions.onLinkIssue,
            },
          ]
      : []),
    item.unread
      ? {
          key: "read",
          label: "Mark as read",
          icon: Tick02Icon,
          onSelect: run(() => actions.onMarkUnread?.(item.id, false)),
          disabled: !actions.onMarkUnread,
        }
      : {
          key: "unread",
          label: "Mark as unread",
          icon: CircleIcon,
          onSelect: run(() => actions.onMarkUnread?.(item.id, true)),
          disabled: !actions.onMarkUnread,
        },
  ];
}

function folderEntries(
  { item, actions, run }: MenuContext,
  {
    details,
    editor,
    position,
    linked,
  }: { details: NonNullable<SidebarRecent["details"]>; editor: ReturnType<typeof useEditors>["editor"]; position: { x: number; y: number }; linked: boolean },
): MenuEntry[] {
  return [
    ...(actions.gitless
      ? []
      : [
          {
            key: "reveal",
            label: `Open in ${fileManager}`,
            icon: FolderOpenIcon,
            onSelect: run(() => actions.onReveal?.(item.id)),
            disabled: !actions.onReveal || !details.path,
          },
          {
            key: "editor",
            label: editor ? `Open in ${editor.name}` : "No editor found",
            icon: SourceCodeIcon,
            onSelect: run(() => actions.onOpenInEditor?.(item.id)),
            disabled: !editor || !actions.onOpenInEditor || !details.path,
          },
          {
            key: "commit",
            label: "Commit and open PR…",
            icon: GitPullRequestIcon,
            onSelect: run(() => actions.onCommit?.(item.id)),
            disabled: !actions.onCommit || !details.path,
          },
        ]),
    item.pinned
      ? {
          key: "unpin",
          label: "Unpin",
          icon: PinOffIcon,
          onSelect: run(() => actions.onPin?.(item.id, null)),
          disabled: !actions.onPin,
        }
      : {
          key: "pin",
          label: "Pin",
          icon: PinIcon,
          onSelect: run(() => actions.onPin?.(item.id)),
          disabled: !actions.onPin,
        },
    ...(actions.onLinkWith && details.path
      ? [
          {
            key: "link-with",
            label: "Link with…",
            icon: Link04Icon,
            onSelect: run(() =>
              actions.onLinkWith?.(item.id, {
                top: position.y,
                left: position.x,
              }),
            ),
          },
        ]
      : []),
    ...(actions.onRemoveLink && linked
      ? [
          {
            key: "remove-link",
            label: "Remove Link with…",
            icon: Unlink04Icon,
            onSelect: run(() =>
              actions.onRemoveLink?.(item.id, {
                top: position.y,
                left: position.x,
              }),
            ),
          },
        ]
      : []),
    ...(actions.onDetach && item.parent
      ? [
          {
            key: "detach",
            label: "Detach from parent",
            icon: Unlink04Icon,
            onSelect: run(() => actions.onDetach?.(item.id)),
          },
        ]
      : []),
  ];
}

export function ChatMenu({
  item,
  position,
  trigger,
  onClose,
  onRename,
  onLink,
  linked,
  actions,
  omit,
}: {
  item: SidebarRecent;
  position: { x: number; y: number };
  omit?: ReadonlySet<string>;
  trigger: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onRename: () => void;
  onLink: () => void;
  linked: boolean;
  actions: ChatRowActions;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [plan, setPlan] = useState<ArchivePlan | null>(actions.onArchiveCheck ? null : HIDE_ONLY);
  const [top, setTop] = useState(position.y);
  const { details = {} } = item;

  useLayoutEffect(() => {
    menuRef.current?.querySelector<HTMLElement>("[data-menu-row]")?.focus();
  }, []);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const height = menu.getBoundingClientRect().height;
    setTop(position.y + height > window.innerHeight - 8 ? Math.max(8, position.y - height - 8) : position.y);
  }, [position.y, plan]);

  useEffect(() => {
    if (!actions.onArchiveCheck || !actions.onArchive) return;
    let live = true;
    readWithTimeout(() => actions.onArchiveCheck!(item.id), 5_000).then(
      // oxlint-disable-next-line promise/no-callback-in-promise -- the handler receives the resolved value, not a Node-style callback
      (next) => live && setPlan(next),
      () => live && setPlan(HIDE_ONLY),
    );
    return () => {
      live = false;
    };
    // Checked once per opening; the menu remounts each time it opens.
  }, []);

  const subRef = useRef<HTMLDivElement>(null);
  const [sub, setSub] = useState<{ key: string; top: number; focus: boolean } | null>(null);
  useLayoutEffect(() => {
    if (sub?.focus) subRef.current?.querySelector<HTMLElement>("[data-menu-row]")?.focus();
  }, [sub]);
  const openSub = (key: string, row: HTMLElement, focus: boolean) => {
    const top = row.getBoundingClientRect().top - 6;
    setSub((current) => (current?.key === key && !focus ? current : { key, top, focus }));
  };

  useDismiss(true, onClose, (target) => !!(menuRef.current?.contains(target) || subRef.current?.contains(target) || trigger.current?.contains(target)));

  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  const { editor } = useEditors();
  const copy = (text: string) => run(() => void navigator.clipboard.writeText(text).catch(() => {}));

  const deletionPlan = plan ?? HIDE_ONLY;
  const [openedAt] = useState(() => Date.now());
  const { snoozePresets } = useSettings();
  const context = { item, actions, run };
  const items: Array<MenuEntry | "divider"> = [
    ...chatEntries(context, { details, copy, onRename, onLink }),
    ...folderEntries(context, { details, editor, position, linked }),
    "divider" as const,
    ...archiveEntries(context, deletionPlan, openedAt, snoozePresets),
  ].filter((entry) => entry === "divider" || (!omit?.has(entry.key) && (!actions.remote || (entry.key !== "reveal" && entry.key !== "editor"))));

  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = [...(menuRef.current?.querySelectorAll<HTMLElement>("[data-menu-row]:not(:disabled)") ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    const active = document.activeElement as HTMLElement | null;
    if (event.key === "ArrowRight" && active?.dataset.sub) {
      event.preventDefault();
      openSub(active.dataset.sub, active, true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      rows[(index + step + rows.length) % rows.length]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Tab") {
      event.preventDefault();
    }
  };

  const subEntry = sub ? items.find((entry): entry is MenuEntry => entry !== "divider" && entry.key === sub.key) : undefined;
  const subKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = [...(subRef.current?.querySelectorAll<HTMLElement>("[data-menu-row]:not(:disabled)") ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      rows[(index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
    } else if (event.key === "ArrowLeft" || event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const key = sub?.key;
      setSub(null);
      menuRef.current?.querySelector<HTMLElement>(`[data-sub="${key}"]`)?.focus();
    } else if (event.key === "Tab") event.preventDefault();
  };
  const subLeft = position.x + MENU_WIDTH + SUB_MENU_WIDTH + 12 > window.innerWidth ? position.x - SUB_MENU_WIDTH - 6 : position.x + MENU_WIDTH + 6;

  return createPortal(
    <>
      <div
        ref={menuRef}
        role="menu"
        aria-label={`Actions for ${item.label}`}
        data-chat-menu
        onKeyDown={moveFocus}
        className="fixed z-[70] flex max-h-[calc(100vh-16px)] flex-col overflow-hidden rounded-card bg-surface p-1.5 shadow-overlay"
        style={{
          top,
          left: position.x,
          width: MENU_WIDTH,
          animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) backwards",
          transformOrigin: "top left",
        }}
      >
        <ScrollArea className="min-h-0">
          <GlideMenu className="flex flex-col gap-px" rowSelector="[data-menu-row]:not(:disabled)" highlightClassName="inset-x-0 rounded-control bg-hover-2">
            {items.map((entry, index) =>
              entry === "divider" ? (
                <div key={`divider-${index}`} className="my-1 h-px bg-line" />
              ) : (
                <button
                  key={entry.key}
                  data-menu-row
                  data-sub={entry.sub ? entry.key : undefined}
                  role="menuitem"
                  type="button"
                  aria-haspopup={entry.sub ? "menu" : undefined}
                  aria-expanded={entry.sub ? sub?.key === entry.key : undefined}
                  disabled={entry.disabled}
                  title={entry.hint}
                  onPointerEnter={(event) => (entry.sub ? openSub(entry.key, event.currentTarget, false) : setSub(null))}
                  onClick={entry.sub ? (event) => openSub(entry.key, event.currentTarget, true) : entry.onSelect}
                  className={`relative z-10 flex w-full items-center gap-2 rounded-control px-2 text-left outline-none focus-visible:bg-hover-2 disabled:opacity-40 h-8 ${entry.danger ? "text-red-ink" : "text-ink"} ${entry.sub && sub?.key === entry.key ? "bg-hover-2" : ""}`}
                >
                  <span className={`flex size-5 shrink-0 items-center justify-center ${entry.danger ? "text-red-ink" : "text-ink-2"}`}>
                    {entry.leading ?? (entry.icon && <HugeIcon icon={entry.icon} size={16} />)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-13">{entry.label}</span>
                  {entry.sub && <HugeIcon icon={ArrowRight01Icon} size={14} />}
                </button>
              ),
            )}
          </GlideMenu>
        </ScrollArea>
      </div>
      {sub && subEntry?.sub && (
        <div
          ref={subRef}
          role="menu"
          aria-label={subEntry.label}
          data-chat-submenu={subEntry.key}
          onKeyDown={subKeys}
          className="fixed z-[71] flex flex-col overflow-hidden rounded-card bg-surface p-1.5 shadow-overlay"
          style={{
            top: Math.max(8, Math.min(sub.top, window.innerHeight - 8 - (subEntry.sub.length * 33 + 12))),
            left: subLeft,
            width: SUB_MENU_WIDTH,
            animation: "pop-in var(--duration-fast) var(--ease-enter) backwards",
            transformOrigin: "top left",
          }}
        >
          <GlideMenu className="flex flex-col gap-px" rowSelector="[data-menu-row]:not(:disabled)" highlightClassName="inset-x-0 rounded-control bg-hover-2">
            {subEntry.sub.map((choice) => (
              <button
                key={choice.key}
                data-menu-row
                data-sub-choice={choice.key}
                role="menuitem"
                type="button"
                onClick={choice.onSelect}
                className="relative z-10 flex h-8 w-full items-center gap-2 rounded-control px-2 text-left text-ink outline-none focus-visible:bg-hover-2"
              >
                <span className="min-w-0 flex-1 truncate text-13">{choice.label}</span>
                {choice.detail && <span className="shrink-0 text-12 tabular-nums text-ink-3">{choice.detail}</span>}
              </button>
            ))}
          </GlideMenu>
        </div>
      )}
    </>,
    document.body,
  );
}
