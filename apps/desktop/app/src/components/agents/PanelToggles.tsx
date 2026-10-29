import { useEffect, useRef, useSyncExternalStore } from "react";
import type { KeybindingCommandId } from "@milagre/shared/keybindings";
import { shortcutCommand, shortcutLabel, useKeybindings } from "../../lib/keybindings";
import { HugeiconsIcon } from "@hugeicons/react";
import { File01Icon, ComputerTerminal01Icon, PaintBoardIcon, SmartphoneIcon } from "@hugeicons/core-free-icons";
import Tooltip from "../primitives/Tooltip";
import { isModalOpen } from "../../lib/modal";
import { useWindowChrome } from "../../lib/window-chrome";

/** A side panel the open Chat can show: whether it is open, and what shows or hides it. */
export type SidePanel = { open: boolean; toggle: () => void };
type PanelName = "terminal" | "designs" | "artifacts" | "simulator";

// The Chat's Terminals, designs and simulator register here while they have something to show, so the window's top-right
// corner can offer a button for each without owning their state.
let panels: Partial<Record<PanelName, SidePanel>> = {};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => panels;

/** Offers this panel's button while `panel` is set; null takes it away (the Chat has no designs, or no simulator). */
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

/** The panels with a button now. */
export function useSidePanels() {
  return useSyncExternalStore(subscribe, snapshot);
}

// Changes, the theme and the canvas are App's keys. The Terminals take ⌘J by default, as in VS Code; New Terminal is App's.
const BUTTONS: { name: PanelName; label: string; icon: typeof PaintBoardIcon; command: KeybindingCommandId }[] = [
  { name: "terminal", label: "Terminals", icon: ComputerTerminal01Icon, command: "terminal.toggle" },
  { name: "artifacts", label: "artifacts", icon: File01Icon, command: "artifacts.toggle" },
  { name: "designs", label: "designs", icon: PaintBoardIcon, command: "designs.toggle" },
  { name: "simulator", label: "simulator", icon: SmartphoneIcon, command: "simulator.toggle" },
];

/**
 * The corner's buttons sit 40px apart (32px wide, 8px between): wide enough that the shortcut hints under them, shown
 * while ⌘ is held, don't run into each other. What sits left of them moves this much per button.
 */
export const CORNER_PITCH = 40;

/** How many buttons PanelToggles shows, for what sits left of them. */
export const sidePanelCount = (shown: Partial<Record<PanelName, SidePanel>>) => BUTTONS.filter(({ name }) => shown[name]).length;

/**
 * The top-right buttons for the Chat's Terminals, designs and simulator, left of the changes toggle, `right` pixels from the
 * window's edge. A button shows only while its Chat has something for it.
 */
export function PanelToggles({ right }: { right: number }) {
  const shown = useSidePanels();
  // Each button's shortcut, while its button shows.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || isModalOpen()) return;
      const command = shortcutCommand(event);
      const button = command && BUTTONS.find((item) => item.command === command);
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
  if (!buttons.length) return null;
  return (
    <div
      data-slot="panel-toggles"
      className="fixed top-[var(--window-chrome-top)] z-[60] flex gap-2 [-webkit-app-region:no-drag]"
      style={{ right: right + chrome.rightInset }}
    >
      {buttons.map(({ name, label, icon, command }) => {
        const panel = shown[name]!;
        return (
          <Tooltip
            key={name}
            label={panel.open ? `Hide ${label}` : `Show ${label}`}
            shortcut={shortcutLabel(rules, command)}
            compactHint
            side="bottom"
            align="end"
          >
            <button
              type="button"
              aria-label={`Toggle ${label} panel`}
              aria-pressed={panel.open}
              data-panel-toggle={name}
              onClick={panel.toggle}
              className={`flex size-8 items-center justify-center rounded-control transition-colors hover:bg-hover hover:text-ink ${panel.open ? "bg-hover text-ink" : "text-ink-3"}`}
            >
              <HugeiconsIcon icon={icon} size={18} strokeWidth={1.8} color="currentColor" />
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
