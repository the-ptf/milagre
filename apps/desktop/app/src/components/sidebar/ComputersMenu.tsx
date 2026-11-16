import { Add01Icon, Settings01Icon } from "@hugeicons/core-free-icons";
import Tooltip from "@/components/primitives/Tooltip";
import { IconButton } from "../primitives/Button";
import { CheckboxBox } from "../primitives/Checkbox";
import { MenuRow, MenuSeparator } from "../primitives/Popover";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import { DOT_COLOR, computerTone, routeLine, settingsTooltip, useComputers, useHiddenComputers, type ComputerTone } from "../../lib/computers";
import { setComputerHidden } from "../../lib/hidden-projects";
import { ThisComputer } from "../../lib/shortcut-hints";

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
      className="group/host flex min-h-12 shrink-0 items-center gap-1 rounded-inline pr-1.5 transition-colors hover:bg-hover-2 has-[:focus-visible]:bg-hover-2 has-[[data-computer-show]:focus-visible]:outline-2 has-[[data-computer-show]:focus-visible]:-outline-offset-2 has-[[data-computer-show]:focus-visible]:outline-accent"
    >
      <Tooltip label={shown ? `Hide ${name}'s Projects from the sidebar` : `Show ${name}'s Projects in the sidebar`} className="min-w-0 flex-1 self-stretch">
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={shown}
          data-menu-row
          data-computer-show
          onClick={() => onShow(!shown)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-inline py-1.5 pl-2 text-left focus-visible:outline-none"
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

export function ComputersMenu({
  now,
  onAddComputer,
  onOpenSettings,
  onPicked,
}: {
  now: number;
  onAddComputer: () => void;
  onOpenSettings: (id: string | null) => void;
  onPicked: () => void;
}) {
  const { thisMac, computers } = useComputers();
  const hidden = useHiddenComputers();
  const pick = (run: () => void) => () => {
    onPicked();
    run();
  };
  return (
    <>
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
      <MenuSeparator />
      <MenuRow icon={Add01Icon} title="Add computer" data-add-computer-row onClick={pick(onAddComputer)} />
    </>
  );
}
