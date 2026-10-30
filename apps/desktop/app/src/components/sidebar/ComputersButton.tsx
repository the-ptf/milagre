import { useRef, useState } from "react";
import { Add01Icon, LaptopIcon, Settings01Icon } from "@hugeicons/core-free-icons";
import Tooltip from "@/components/primitives/Tooltip";
import { IconButton } from "../primitives/Button";
import { CheckboxBox } from "../primitives/Checkbox";
import { Icon } from "../primitives/Icon";
import { MenuRow, MenuSeparator, Popover } from "../primitives/Popover";
import { useSettings } from "../../lib/settings";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import { DOT_COLOR, computerTone, routeLine, settingsTooltip, useComputers, useHiddenComputers, type ComputerTone } from "../../lib/computers";
import { setComputerHidden } from "../../lib/hidden-projects";

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
  // A two-line menu row (MenuRow's metrics and highlight) holding two controls: the check and the gear.
  return (
    <div
      data-row
      data-computer-row={id}
      data-computer-hidden={!shown || undefined}
      className="group/host flex min-h-12 shrink-0 items-center gap-1 rounded-inline pr-1.5 transition-colors hover:bg-hover-2 has-[:focus-visible]:bg-hover-2"
    >
      <Tooltip label={shown ? `Hide ${name}'s Projects from the sidebar` : `Show ${name}'s Projects in the sidebar`} className="min-w-0 flex-1 self-stretch">
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={shown}
          data-menu-row
          data-computer-show
          onClick={() => onShow(!shown)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-inline py-1.5 pl-2 text-left focus-visible:-outline-offset-2"
        >
          <CheckboxBox checked={shown} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span data-computer-name className={`truncate text-13 font-medium ${shown ? "text-ink" : "text-ink-3"}`}>
              {name}
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: DOT_COLOR[tone] }} />
              <span data-computer-line className="truncate text-12 text-ink-3">
                {line}
              </span>
            </span>
          </span>
        </button>
      </Tooltip>
      <Tooltip label={gearLabel} side="bottom" align="end">
        <IconButton
          label={gearLabel}
          icon={Settings01Icon}
          size={24}
          data-menu-row
          data-computer-gear
          onClick={onGear}
          className="opacity-0 group-hover/host:opacity-100 focus-visible:opacity-100 focus-visible:-outline-offset-2"
        />
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
  onAddComputer,
  onOpenSettings,
}: {
  /** Unused: the popover opens above the button either way. */
  collapsed?: boolean;
  /** @deprecated The button is an IconButton now; remove it from the call site. */
  buttonClassName?: string;
  onAddComputer: () => void;
  /** null: This Mac. */
  onOpenSettings: (id: string | null) => void;
}) {
  const { otherComputers } = useSettings();
  const { thisMac, computers } = useComputers();
  const hidden = useHiddenComputers();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // "seen 2h ago" is read when the popover opens, not on every render.
  const [now, setNow] = useState(0);
  if (!otherComputers) return null;

  const close = () => setOpen(false);
  const pick = (run: () => void) => () => {
    close();
    run();
  };
  const anyAway = computers.some((computer) => computerTone(computer) !== "online");

  return (
    <>
      <IconButton
        ref={buttonRef}
        label="Computers"
        size={32}
        aria-haspopup="menu"
        aria-expanded={open}
        data-computers-button
        onClick={() => {
          if (open) return close();
          setNow(Date.now());
          setOpen(true);
        }}
      >
        <Icon icon={LaptopIcon} size={16} />
        {anyAway && <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-orange" />}
      </IconButton>
      {open && (
        // Above the button, at the bottom of the sidebar (expanded or collapsed).
        <Popover anchor={buttonRef} align="start" width={272} label="Computers" onClose={close} data-computers-panel>
          <HostRow
            id="this-mac"
            name={thisMac}
            line="This Mac"
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
          <MenuSeparator />
          <MenuRow icon={Add01Icon} title="Add computer" data-add-computer-row onClick={pick(onAddComputer)} />
        </Popover>
      )}
    </>
  );
}
