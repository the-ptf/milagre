import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, LaptopIcon, Settings01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import GlideMenu from "@/components/primitives/GlideMenu";
import Tooltip from "@/components/primitives/Tooltip";
import { ScrollArea } from "../primitives/ScrollArea";
import { useDismiss } from "../../lib/use-dismiss";
import { useSettings } from "../../lib/settings";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import { DOT_COLOR, computerTone, routeLine, settingsTooltip, useComputers, useHiddenComputers, type ComputerTone } from "../../lib/computers";
import { setComputerHidden } from "../../lib/hidden-projects";
import { ThisComputer } from "../../lib/shortcut-hints";

const icon = (data: typeof LaptopIcon, size: number) => <HugeiconsIcon icon={data} size={size} strokeWidth={1.8} color="currentColor" />;

function HostRow({
  id,
  name,
  line,
  tone,
  shown,
  onShow,
  gearLabel,
  onGear,
}: {
  id: string;
  name: string;
  line: string;
  tone: ComputerTone;
  /** Its Projects are in the sidebar; unchecked, the sidebar leaves them out. */
  shown: boolean;
  onShow: (shown: boolean) => void;
  gearLabel: string;
  onGear: () => void;
}) {
  return (
    <div
      data-row
      data-computer-row={id}
      data-computer-hidden={!shown || undefined}
      className="group/host relative z-10 flex h-11 items-center gap-1 rounded-[8px] pr-2"
    >
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={shown}
        data-menu-row
        data-computer-show
        title={shown ? `Hide ${name}'s Projects from the sidebar` : `Show ${name}'s Projects in the sidebar`}
        onClick={() => onShow(!shown)}
        className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-[8px] pl-2.5 text-left outline-none focus-visible:bg-hover-2"
      >
        <span
          aria-hidden
          className={`flex size-4 shrink-0 items-center justify-center rounded-[4px] transition-colors duration-100 ${shown ? "bg-ink text-surface" : "border-[1.5px] border-ink-3"}`}
        >
          {shown && <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={1.8} color="currentColor" />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span data-computer-name className={`truncate text-[13px] font-medium ${shown ? "text-ink" : "text-ink-3"}`}>
            {name}
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: DOT_COLOR[tone] }} />
            <span data-computer-line className="truncate text-[11.5px] text-ink-3">
              {line}
            </span>
          </span>
        </span>
      </button>
      <Tooltip label={gearLabel} side="bottom" align="end">
        <button
          type="button"
          data-menu-row
          data-computer-gear
          aria-label={gearLabel}
          onClick={onGear}
          className="flex size-[26px] shrink-0 items-center justify-center rounded-[7px] text-ink opacity-0 outline-none transition-opacity duration-100 group-hover/host:opacity-100 hover:bg-hover-2 focus-visible:bg-hover-2 focus-visible:opacity-100"
        >
          {icon(Settings01Icon, 15)}
        </button>
      </Tooltip>
    </div>
  );
}

/**
 * The footer's laptop button (spec "Computer status", design sidebar-c-sections v6): a popover of This Mac and each
 * paired computer with its status dot and route, a check that keeps its Projects in the sidebar or leaves them out, a gear
 * per computer that opens its settings (This Mac's: Settings › Devices), and Add computer. Shown only while Settings ›
 * Devices › Other computers is on.
 */
export function ComputersButton({
  collapsed,
  buttonClassName,
  onAddComputer,
  onOpenSettings,
}: {
  collapsed: boolean;
  buttonClassName: string;
  onAddComputer: () => void;
  /** null: This Mac. */
  onOpenSettings: (id: string | null) => void;
}) {
  const { otherComputers } = useSettings();
  const { thisMac, computers } = useComputers();
  const hidden = useHiddenComputers();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // "seen 2h ago" is read when the popover opens, not on every render.
  const [now, setNow] = useState(0);
  const [position, setPosition] = useState({ bottom: 0, left: 0 });

  // Above the button, which sits at the bottom of the sidebar; collapsed, beside the rail.
  const place = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return false;
    setPosition(
      collapsed ? { bottom: window.innerHeight - rect.bottom, left: rect.right + 8 } : { bottom: window.innerHeight - rect.top + 6, left: rect.left },
    );
    return true;
  };
  const close = () => setOpen(false);
  useDismiss(open, close, (target) => !!target.closest("[data-computers-button], [data-computers-panel]"), place);
  useLayoutEffect(() => {
    // The gears show on hover, so the first control seen is Add computer, not This Mac's invisible gear.
    if (open) panelRef.current?.querySelector<HTMLElement>("[data-add-computer-row]")?.focus();
  }, [open]);
  if (!otherComputers) return null;

  const pick = (run: () => void) => () => {
    close();
    run();
  };
  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = [...(panelRef.current?.querySelectorAll<HTMLElement>("[data-menu-row]") ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      rows[(index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
      buttonRef.current?.focus();
    }
  };
  const anyAway = computers.some((computer) => computerTone(computer) !== "online");

  return (
    <>
      <Tooltip label="Computers">
        <button
          ref={buttonRef}
          type="button"
          aria-label="Computers"
          aria-haspopup="menu"
          aria-expanded={open}
          data-computers-button
          onClick={() => (open ? close() : place() && (setNow(Date.now()), setOpen(true)))}
          className={`${buttonClassName} relative ${collapsed ? "size-8" : "size-9"} ${open ? "bg-hover-2 text-ink" : ""}`}
        >
          {icon(LaptopIcon, 17)}
          {anyAway && <span aria-hidden className="absolute right-1.5 top-1.5 size-1.5 rounded-full" style={{ background: "var(--orange)" }} />}
        </button>
      </Tooltip>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            aria-label="Computers"
            data-computers-panel
            onKeyDown={moveFocus}
            className="fixed z-50 flex max-h-[min(420px,calc(100vh-16px))] w-[272px] flex-col overflow-hidden rounded-[12px] bg-surface shadow-overlay"
            style={{ bottom: position.bottom, left: position.left, animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom left" }}
          >
            <ScrollArea className="p-1.5">
              <GlideMenu className="flex flex-col gap-px" rowSelector="[data-row]" highlightClassName="inset-x-0 rounded-[8px] bg-hover">
                <HostRow
                  id="this-mac"
                  name={thisMac}
                  line={ThisComputer}
                  tone="online"
                  shown={!hidden.has(LOCAL_COMPUTER)}
                  onShow={(shown) => setComputerHidden(LOCAL_COMPUTER, !shown)}
                  gearLabel={`${thisMac} settings: devices`}
                  onGear={pick(() => onOpenSettings(null))}
                />
                {computers.map((computer) => (
                  <HostRow
                    key={computer.id}
                    id={computer.id}
                    name={computer.name}
                    line={routeLine(computer, now)}
                    tone={computerTone(computer)}
                    shown={!hidden.has(computer.id)}
                    onShow={(shown) => setComputerHidden(computer.id, !shown)}
                    gearLabel={settingsTooltip(computer.name)}
                    onGear={pick(() => onOpenSettings(computer.id))}
                  />
                ))}
              </GlideMenu>
              <div className="mx-1.5 my-1 h-px bg-line" />
              <button
                type="button"
                data-menu-row
                data-add-computer-row
                onClick={pick(onAddComputer)}
                className="flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-left text-[13px] text-ink-2 outline-none hover:bg-hover focus-visible:bg-hover"
              >
                {icon(Add01Icon, 16)}
                Add computer
              </button>
            </ScrollArea>
          </div>,
          document.body,
        )}
    </>
  );
}
