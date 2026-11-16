import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { KeybindingCommandId } from "@milagre/shared/keybindings";
import { shortcutCommand, shortcutLabel, useKeybindings } from "../../lib/keybindings";
import {
  File01Icon,
  ComputerTerminal01Icon,
  Globe02Icon,
  AlignBoxMiddleRightIcon,
  PaintBoardIcon,
  SmartphoneIcon,
  GitPullRequestIcon,
  FileDiffIcon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { IconButton } from "../primitives/Button";
import { MenuRow, Popover } from "../primitives/Popover";
import Tooltip from "../primitives/Tooltip";
import { isModalOpen } from "../../lib/modal";
import { useWindowChrome } from "../../lib/window-chrome";

export type SidePanel = { open: boolean; toggle: () => void };
type PanelName = "terminal" | "designs" | "artifacts" | "browser" | "simulator" | "details";

let panels: Partial<Record<PanelName, SidePanel>> = {};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => panels;

export function useSidePanel(name: PanelName, panel: SidePanel | null) {
  const open = panel?.open;
  const offered = open !== undefined;
  const toggle = useRef(panel?.toggle);
  toggle.current = panel?.toggle;
  const press = useRef(() => toggle.current?.());
  const publish = (next: SidePanel | undefined) => {
    const { [name]: _gone, ...rest } = panels;
    panels = next ? { ...rest, [name]: next } : rest;
    listeners.forEach((listener) => listener());
  };
  useEffect(() => {
    if (!offered) return;
    return () => publish(undefined);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- publish only closes over name
  }, [name, offered]);
  useEffect(() => {
    if (open !== undefined && panels[name]?.open !== open) publish({ open, toggle: press.current });
  });
}

export function useSidePanels() {
  return useSyncExternalStore(subscribe, snapshot);
}

const BUTTONS: { name: PanelName; label: string; title?: string; icon: typeof PaintBoardIcon; command?: KeybindingCommandId }[] = [
  { name: "details", label: "details", title: "Details", icon: AlignBoxMiddleRightIcon },
  { name: "terminal", label: "Terminals", icon: ComputerTerminal01Icon, command: "terminal.toggle" },
  { name: "artifacts", label: "artifacts", icon: File01Icon, command: "artifacts.toggle" },
  { name: "designs", label: "designs", icon: PaintBoardIcon, command: "designs.toggle" },
  { name: "browser", label: "browser", title: "Browser panel", icon: Globe02Icon, command: "browser.toggle" },
  { name: "simulator", label: "simulator", title: "Simulators", icon: SmartphoneIcon, command: "simulator.toggle" },
];

export const CORNER_PITCH = 40;

const LEADING = new Set<PanelName>(["details", "terminal"]);

const sidePanelCount = (shown: Partial<Record<PanelName, SidePanel>>, changes = false, pullRequest = false) =>
  BUTTONS.filter(({ name }) => shown[name]).length + Number(changes) + Number(pullRequest);

/** The title bar's trailing buttons: the panel toggles, which a split's Panels menu replaces, and the Canvas button, hidden while split. */
export function cornerButtonCount(
  splitOn: boolean,
  shown: Partial<Record<PanelName, SidePanel>>,
  changesAvailable: boolean,
  prNumber: number | null | undefined,
  view: string,
) {
  if (splitOn) return 0;
  return sidePanelCount(shown, changesAvailable, changesAvailable && !!prNumber) + (view === "chat" || view === "canvas" ? 1 : 0);
}

type PanelProps = { changes?: SidePanel; pullRequest?: SidePanel & { number: number } };

/** The panel buttons as one menu, for the focused pane of a split, where the title bar holds the panes' headers. */
export function PanelMenu({ changes, pullRequest }: PanelProps) {
  const shown = useSidePanels();
  const { rules } = useKeybindings();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const buttons = BUTTONS.filter(({ name }) => shown[name]);
  if (!buttons.length && !changes && !pullRequest) return null;
  const row = (key: string, title: string, icon: typeof PaintBoardIcon, panel: SidePanel, command?: KeybindingCommandId) => (
    <MenuRow
      key={key}
      icon={icon}
      title={title}
      checked={panel.open}
      trailing={command && <span className="text-12 text-ink-3">{shortcutLabel(rules, command)}</span>}
      data-panel-menu-row={key}
      onClick={() => {
        setOpen(false);
        panel.toggle();
      }}
    />
  );
  return (
    <>
      <IconButton
        ref={trigger}
        size={24}
        label="Panels"
        icon={MoreHorizontalIcon}
        side="bottom"
        aria-haspopup="menu"
        aria-expanded={open}
        data-panel-menu
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
      />
      {open && (
        <Popover anchor={trigger} align="end" width={240} label="Panels" onClose={() => setOpen(false)} data-panel-menu-popover>
          {buttons
            .filter(({ name }) => LEADING.has(name))
            .map(({ name, label, title = label, icon, command }) => row(name, capitalize(title), icon, shown[name]!, command))}
          {pullRequest && row("pr", `Pull request #${pullRequest.number}`, GitPullRequestIcon, pullRequest)}
          {changes && row("changes", "Changes", FileDiffIcon, changes, "changes.toggle")}
          {buttons
            .filter(({ name }) => !LEADING.has(name))
            .map(({ name, label, title = label, icon, command }) => row(name, capitalize(title), icon, shown[name]!, command))}
        </Popover>
      )}
    </>
  );
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The title bar's panel buttons. `hidden` drops them and their shortcuts where the panels don't apply; `split` drops only
 * the buttons, while a split's Panels menu offers them and the shortcuts keep working.
 */
export function PanelToggles({
  right,
  changes,
  pullRequest,
  hidden = false,
  split = false,
}: PanelProps & { right: number; hidden?: boolean; split?: boolean }) {
  const shown = useSidePanels();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (hidden || event.defaultPrevented || event.isComposing || isModalOpen()) return;
      const command = shortcutCommand(event);
      const button = command && BUTTONS.find((item) => item.command === command && panels[item.name]);
      const panel = button && panels[button.name];
      if (!panel) return;
      event.preventDefault();
      panel.toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden]);
  const buttons = BUTTONS.filter(({ name }) => shown[name]);
  const chrome = useWindowChrome();
  const { rules } = useKeybindings();
  const panelButton = ({ name, label, title = label, icon, command }: (typeof BUTTONS)[number]) => {
    const panel = shown[name]!;
    return (
      <Tooltip
        key={name}
        label={panel.open ? `Hide ${title}` : `Show ${title}`}
        shortcut={command && shortcutLabel(rules, command)}
        compactHint
        side="bottom"
        align="end"
      >
        <IconButton size={32} label={`Toggle ${label} panel`} icon={icon} aria-pressed={panel.open} data-panel-toggle={name} onClick={panel.toggle} />
      </Tooltip>
    );
  };
  if (hidden || split || (!buttons.length && !changes && !pullRequest)) return null;
  return (
    <div data-slot="panel-toggles" className="no-drag fixed top-[var(--window-chrome-top)] z-[60] flex gap-2" style={{ right: right + chrome.rightInset }}>
      {buttons.filter(({ name }) => LEADING.has(name)).map(panelButton)}
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
        <Tooltip label={changes.open ? "Hide Changes" : "Show Changes"} shortcut={shortcutLabel(rules, "changes.toggle")} compactHint side="bottom" align="end">
          <IconButton
            size={32}
            label="Toggle changes panel"
            icon={FileDiffIcon}
            aria-pressed={changes.open}
            data-panel-toggle="changes"
            data-changes-toggle=""
            onClick={changes.toggle}
          />
        </Tooltip>
      )}
      {buttons.filter(({ name }) => !LEADING.has(name)).map(panelButton)}
    </div>
  );
}
