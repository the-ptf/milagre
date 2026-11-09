import { useEffect, useRef, useSyncExternalStore } from "react";
import type { KeybindingCommandId } from "@milagre/shared/keybindings";
import { shortcutCommand, shortcutLabel, useKeybindings } from "../../lib/keybindings";
import { File01Icon, ComputerTerminal01Icon, Globe02Icon, PaintBoardIcon, SmartphoneIcon, GitPullRequestIcon, GitBranchIcon } from "@hugeicons/core-free-icons";
import { IconButton } from "../primitives/Button";
import Tooltip from "../primitives/Tooltip";
import { isModalOpen } from "../../lib/modal";
import { useWindowChrome } from "../../lib/window-chrome";

/** A side panel the open Chat can show: whether it is open, and what shows or hides it. */
export type SidePanel = { open: boolean; toggle: () => void };
type PanelName = "terminal" | "designs" | "artifacts" | "browser" | "simulator";

// Panels register their availability and actions here; the toolbar shows every offered button inline at the top right.
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
    if (open !== undefined && panels[name]?.open !== open) publish({ open, toggle: press.current });
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
  { name: "artifacts", label: "artifacts", icon: File01Icon, command: "artifacts.toggle" },
  { name: "designs", label: "designs", icon: PaintBoardIcon, command: "designs.toggle" },
  { name: "browser", label: "browser", title: "Browser panel", icon: Globe02Icon, command: "browser.toggle" },
  { name: "simulator", label: "simulator", title: "Simulators", icon: SmartphoneIcon, command: "simulator.toggle" },
];

/**
 * The corner's buttons sit 40px apart (32px wide, 8px between): wide enough that the shortcut hints under them, shown
 * while ⌘ is held, don't run into each other. What sits left of them moves this much per button.
 */
export const CORNER_PITCH = 40;

/** How many buttons PanelToggles shows, for what sits left of them. */
export const sidePanelCount = (shown: Partial<Record<PanelName, SidePanel>>, changes = false, pullRequest = false) =>
  BUTTONS.filter(({ name }) => shown[name]).length + Number(changes) + Number(pullRequest);

/** The active Chat's panel actions, PR and Changes, shown inline at the top right. */
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
  const chrome = useWindowChrome();
  const { rules } = useKeybindings();
  if (!buttons.length && !changes && !pullRequest) return null;
  return (
    <div
      data-slot="panel-toggles"
      className="no-drag fixed top-[var(--window-chrome-top)] z-[60] flex gap-2 rounded-card bg-page"
      style={{ right: right + chrome.rightInset }}
    >
      {buttons.map(({ name, label, title = label, icon, command }) => {
        const panel = shown[name]!;
        return (
          <Tooltip
            key={name}
            label={panel.open ? `Hide ${title}` : `Show ${title}`}
            shortcut={shortcutLabel(rules, command)}
            compactHint
            side="bottom"
            align="end"
          >
            <IconButton size={32} label={`Toggle ${label} panel`} icon={icon} aria-pressed={panel.open} data-panel-toggle={name} onClick={panel.toggle} />
          </Tooltip>
        );
      })}
      {pullRequest && (
        <Tooltip label={`Pull request #${pullRequest.number}`} side="bottom" align="end">
          <IconButton
            size={32}
            label={`Pull request #${pullRequest.number}`}
            icon={GitPullRequestIcon}
            aria-pressed={pullRequest.open}
            data-panel-toggle="pr"
            onClick={pullRequest.toggle}
          />
        </Tooltip>
      )}
      {changes && (
        <Tooltip label={changes.open ? "Hide changes" : "Show changes"} shortcut={shortcutLabel(rules, "changes.toggle")} compactHint side="bottom" align="end">
          <IconButton
            size={32}
            label="Toggle changes panel"
            icon={GitBranchIcon}
            aria-pressed={changes.open}
            data-panel-toggle="changes"
            data-changes-toggle=""
            onClick={changes.toggle}
          />
        </Tooltip>
      )}
    </div>
  );
}
