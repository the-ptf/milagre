import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "../../lib/use-dismiss";
import GlideMenu from "../primitives/GlideMenu";
import type { KeybindingCommandId } from "@milagre/shared/keybindings";
import { shortcutCommand, shortcutLabel, useKeybindings } from "../../lib/keybindings";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  File01Icon,
  ComputerTerminal01Icon,
  Globe02Icon,
  PaintBoardIcon,
  SmartphoneIcon,
  MoreHorizontalIcon,
  GitPullRequestIcon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons";
import Tooltip from "../primitives/Tooltip";
import { isModalOpen } from "../../lib/modal";
import { useWindowChrome } from "../../lib/window-chrome";

/** A side panel the open Chat can show: whether it is open, and what shows or hides it. */
export type SidePanel = { open: boolean; toggle: () => void; promoted?: boolean };
type PanelName = "terminal" | "designs" | "artifacts" | "browser" | "simulator";

// Panels register their availability and actions here; the toolbar promotes Browser and keeps the rest in its menu.
let panels: Partial<Record<PanelName, SidePanel>> = {};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => panels;

/** Offers a panel action while `panel` is set; null removes it. */
export function useSidePanel(name: PanelName, panel: SidePanel | null) {
  const open = panel?.open;
  const promoted = panel?.promoted;
  const offered = open !== undefined;
  // The button calls the newest toggle, so a toggle made anew each render doesn't publish the panel again.
  const toggle = useRef(panel?.toggle);
  toggle.current = panel?.toggle;
  const press = useRef(() => toggle.current?.());
  const publish = (next: SidePanel | undefined) => {
    const { [name]: _gone, ...rest } = panels;
    panels = next ? { ...rest, [name]: next } : rest;
    listeners.forEach((listener) => listener());
  };
  // The button shows while the panel is offered, and goes with it.
  useEffect(() => {
    if (!offered) return;
    return () => publish(undefined);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- publish only closes over name
  }, [name, offered]);
  // Its pressed state follows the panel's after every render, so it never lags behind the panel: a panel closed for
  // another (the window's room, the designs expanding) shows its button released at once.
  useEffect(() => {
    if (open !== undefined && (panels[name]?.open !== open || panels[name]?.promoted !== promoted)) publish({ open, promoted, toggle: press.current });
  });
}

/** The panels available in the active Chat. */
export function useSidePanels() {
  return useSyncExternalStore(subscribe, snapshot);
}

// Changes, the theme and the canvas are App's keys. The Terminals take ⌘J by default, as in VS Code; New Terminal is App's.
// `title`, when the tooltip names the panel differently from its button's accessible name.
const BUTTONS: { name: PanelName; label: string; title?: string; icon: typeof PaintBoardIcon; command: KeybindingCommandId }[] = [
  { name: "terminal", label: "Terminals", icon: ComputerTerminal01Icon, command: "terminal.toggle" },
  { name: "artifacts", label: "Artifacts", icon: File01Icon, command: "artifacts.toggle" },
  { name: "designs", label: "Designs", icon: PaintBoardIcon, command: "designs.toggle" },
  { name: "browser", label: "browser", title: "Browser panel", icon: Globe02Icon, command: "browser.toggle" },
  { name: "simulator", label: "Simulators", icon: SmartphoneIcon, command: "simulator.toggle" },
];

/**
 * The corner's buttons sit 40px apart (32px wide, 8px between): wide enough that the shortcut hints under them, shown
 * while ⌘ is held, don't run into each other. What sits left of them moves this much per button.
 */
export const CORNER_PITCH = 40;

const isBrowserShortcut = (name: PanelName, panel: SidePanel) => name === "browser" && panel.promoted !== false;
/** How many buttons PanelToggles shows, for what sits left of them. */
export const sidePanelCount = (shown: Partial<Record<PanelName, SidePanel>>, changes = false, pullRequest = false) => {
  const available = BUTTONS.filter(({ name }) => shown[name]);
  return (
    Number(available.some(({ name }) => isBrowserShortcut(name, shown[name]!))) +
    Number(pullRequest) +
    Number(changes || available.some(({ name }) => !isBrowserShortcut(name, shown[name]!)))
  );
};

/** Browser, PR and the remaining panel actions, in that order, beside the active Chat.
 */
export function PanelToggles({ right, changes, pullRequest }: { right: number; changes?: SidePanel; pullRequest?: SidePanel & { number: number } }) {
  const shown = useSidePanels();
  // Each button's shortcut, while its button shows.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || isModalOpen()) return;
      const command = shortcutCommand(event);
      const button = command && BUTTONS.find((item) => item.command === command && panels[item.name]);
      const panel = button && panels[button.name];
      if (!panel) return;
      event.preventDefault();
      panel.toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const buttons = BUTTONS.filter(({ name }) => shown[name]);
  const browser = shown.browser?.promoted === false ? undefined : shown.browser;
  const chrome = useWindowChrome();
  const { rules } = useKeybindings();
  const overflow: MenuEntry[] = buttons
    .filter(({ name }) => !isBrowserShortcut(name, shown[name]!))
    .map(({ name, label, title, icon, command }) => ({
      id: name,
      label: title ?? label,
      icon,
      shortcut: shortcutLabel(rules, command),
      ...shown[name]!,
    }));
  if (changes)
    overflow.unshift({
      id: "changes",
      label: "View changes",
      icon: GitBranchIcon,
      shortcut: shortcutLabel(rules, "changes.toggle"),
      ...changes,
    });
  if (!buttons.length && !changes && !pullRequest) return null;
  return (
    <div
      data-slot="panel-toggles"
      className="fixed top-[var(--window-chrome-top)] z-[60] flex gap-2 rounded-control bg-surface/90 backdrop-blur-chip [-webkit-app-region:no-drag]"
      style={{ right: right + chrome.rightInset }}
    >
      {browser && (
        <Tooltip label="Browser" shortcut={shortcutLabel(rules, "browser.toggle")} compactHint side="bottom" align="end">
          <button
            type="button"
            aria-label="Toggle browser panel"
            aria-pressed={browser.open}
            data-panel-toggle="browser"
            onClick={browser.toggle}
            className={controlClass(browser.open)}
          >
            <HugeiconsIcon icon={Globe02Icon} size={18} strokeWidth={1.8} />
          </button>
        </Tooltip>
      )}
      {pullRequest && (
        <Tooltip label={`Pull request #${pullRequest.number}`} side="bottom" align="end">
          <button
            type="button"
            aria-label={`Pull request #${pullRequest.number}`}
            aria-pressed={pullRequest.open}
            data-panel-toggle="pr"
            onClick={pullRequest.toggle}
            className={controlClass(pullRequest.open)}
          >
            <HugeiconsIcon icon={GitPullRequestIcon} size={24} strokeWidth={1.8} />
          </button>
        </Tooltip>
      )}
      {overflow.length > 0 && <PanelMenu entries={overflow} />}
    </div>
  );
}

const controlClass = (active: boolean) =>
  `flex size-8 items-center justify-center rounded-control transition-colors hover:bg-hover hover:text-ink ${active ? "bg-hover text-ink" : "text-ink-3"}`;
type MenuEntry = SidePanel & {
  id: string;
  label: string;
  icon: typeof Globe02Icon;
  shortcut?: string;
};

function PanelMenu({ entries, label = "Chat actions", icon = MoreHorizontalIcon }: { entries: MenuEntry[]; label?: string; icon?: typeof Globe02Icon }) {
  const [position, setPosition] = useState<{
    top: number;
    right: number;
  } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const place = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (rect)
      setPosition({
        top: rect.bottom + 8,
        right: Math.max(12, window.innerWidth - rect.right),
      });
  };
  const close = (focus = false) => {
    setPosition(null);
    if (focus) trigger.current?.focus();
  };
  useDismiss(
    !!position,
    () => close(),
    (target) => !!(trigger.current?.contains(target) || menu.current?.contains(target)),
    place,
  );
  const expanded = position !== null;
  useEffect(() => {
    if (expanded) menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [expanded]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!position}
        onClick={() => (position ? close() : place())}
        className={controlClass(!!position)}
      >
        <HugeiconsIcon icon={icon} size={18} strokeWidth={1.8} />
      </button>
      {position &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label={label}
            style={position}
            className="fixed z-[70] min-w-52 rounded-card bg-surface p-1 shadow-raised [-webkit-app-region:no-drag]"
            onKeyDown={(event) => {
              if (event.key === "Escape" || event.key === "Tab") {
                event.preventDefault();
                event.stopPropagation();
                close(true);
              } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const rows = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
                const index = rows.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                  event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
                rows[next]?.focus();
              }
            }}
          >
            <GlideMenu rowSelector="[role=menuitemcheckbox]" highlightClassName="rounded-inline bg-hover">
              {entries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={entry.open}
                  data-panel-toggle={entry.id}
                  onClick={() => {
                    close(true);
                    entry.toggle();
                  }}
                  className="flex h-8 w-full items-center gap-2 rounded-inline px-2 text-13 text-ink-2 focus:bg-hover focus:text-ink"
                >
                  <HugeiconsIcon icon={entry.icon} size={16} strokeWidth={1.8} />
                  <span className="flex-1 text-left">{entry.label}</span>
                  <span className="text-11 text-ink-3">{entry.shortcut}</span>
                </button>
              ))}
            </GlideMenu>
          </div>,
          document.body,
        )}
    </>
  );
}
