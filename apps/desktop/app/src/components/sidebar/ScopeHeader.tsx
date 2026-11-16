import { Fragment, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { IconSvgElement } from "@hugeicons/react";
import { Add01Icon, ArrowDown01Icon, CloudOffIcon, LaptopIcon, MoreVerticalIcon } from "@hugeicons/core-free-icons";
import Tooltip from "@/components/primitives/Tooltip";
import { IconButton } from "../primitives/Button";
import { Icon, type IconSize } from "../primitives/Icon";
import { MenuRow, MenuSeparator, Popover } from "../primitives/Popover";
import { thisComputer } from "../../lib/shortcut-hints";
import { type RowComputer } from "./ChatRow";
import { computerAlias } from "../../lib/computer-scopes";
import { useSidebarKeys } from "./use-sidebar-keys";

type IconProps = { size?: IconSize; className?: string };

const IconChevronDownSmall = (props: IconProps) => <Icon icon={ArrowDown01Icon} {...props} />;

export type ScopeMenuItem = {
  key: string;
  label: string;
  icon: IconSvgElement;
  run: () => void;
  disabled?: boolean;
  destructive?: boolean;
  separatorBefore?: boolean;
};

export function ScopeHeader({
  name,
  icon,
  open,
  current,
  plusIsCurrent = current,
  attention,
  computer,
  onToggle,
  onNewChat,
  onDragStart,
  dragging,
  menu,
}: {
  name: string;
  icon: ReactNode;
  open: boolean;
  current: boolean;
  plusIsCurrent?: boolean;
  attention: boolean;
  computer?: RowComputer;
  onToggle: () => void;
  onNewChat?: () => void;
  onDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  dragging?: boolean;
  menu: ScopeMenuItem[];
}) {
  const keys = useSidebarKeys();
  const rightRoom = `${attention ? "pr-6" : "pr-2"} ${
    attention
      ? menu.length > 0
        ? "group-hover/scope:pr-[80px] group-has-[:focus-visible]/scope:pr-[80px]"
        : "group-hover/scope:pr-[52px] group-has-[:focus-visible]/scope:pr-[52px]"
      : menu.length > 0
        ? "group-hover/scope:pr-[60px] group-has-[:focus-visible]/scope:pr-[60px]"
        : "group-hover/scope:pr-8 group-has-[:focus-visible]/scope:pr-8"
  }`;
  return (
    <div className={`group/scope relative mx-2 flex h-8 items-center ${dragging ? "opacity-40" : ""}`}>
      <button
        type="button"
        data-scope-toggle
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${name}${computer ? ` on ${computer.name}${computer.offline ? ", offline" : ""}` : ""}`}
        onClick={onToggle}
        onPointerDown={onDragStart}
        className={`flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-control pl-2 text-left transition-colors hover:bg-hover active:bg-hover-2 ${onDragStart ? "cursor-grab" : ""} ${rightRoom}`}
      >
        <span className="relative flex h-5 min-w-5 shrink-0 items-center justify-center text-ink">
          <span className="flex items-center justify-center transition-opacity duration-fast group-hover/scope:opacity-0 group-has-[[data-scope-toggle]:focus-visible]/scope:opacity-0">
            {icon}
          </span>
          <span
            aria-hidden
            data-scope-chevron
            className={`absolute inset-y-0 left-0 flex w-5 items-center justify-center text-ink-3 opacity-0 transition-[opacity,transform] duration-fast group-hover/scope:opacity-100 group-has-[[data-scope-toggle]:focus-visible]/scope:opacity-100 ${open ? "" : "-rotate-90"}`}
          >
            <IconChevronDownSmall size={14} />
          </span>
        </span>
        <span
          data-scope-name
          className={`min-w-0 flex-1 truncate text-[length:calc(13px+var(--sidebar-delta))] ${current ? "font-medium text-ink" : "text-ink-2"}`}
        >
          {name}
        </span>
        {computer && (
          <Tooltip
            label={computer.offline ? `${computer.name}, offline` : computer.local ? `${computer.name} · ${thisComputer}` : computer.name}
            align="end"
            className="shrink-0"
          >
            <span
              data-scope-computer
              data-offline={computer.offline || undefined}
              className={`flex h-[18px] items-center gap-1 rounded-chip px-1.5 text-[length:calc(11px+var(--sidebar-delta))] font-medium ${computer.offline ? "bg-orange-tint text-orange-ink" : "bg-field text-ink-2"}`}
            >
              <Icon icon={computer.offline ? CloudOffIcon : LaptopIcon} size={12} />
              <span className="max-w-[72px] truncate">{computerAlias(computer.name)}</span>
            </span>
          </Tooltip>
        )}
      </button>
      {attention && (
        <AttentionDot
          className={`pointer-events-none absolute right-3 transition-transform duration-fast ease-enter ${menu.length > 0 ? "group-hover/scope:-translate-x-[52px] group-has-[:focus-visible]/scope:-translate-x-[52px]" : "group-hover/scope:-translate-x-[26px] group-has-[:focus-visible]/scope:-translate-x-[26px]"}`}
        />
      )}
      <div className="absolute right-1 flex items-center gap-0.5">
        {menu.length > 0 && <ScopeMenuButton name={name} items={menu} />}
        {onNewChat && (
          <Tooltip label="New chat" shortcut={plusIsCurrent ? keys.newChat : undefined} align="end">
            <IconButton
              size={24}
              data-scope-action
              label={plusIsCurrent ? "New chat" : `New chat in ${name}`}
              icon={Add01Icon}
              onClick={onNewChat}
              className="opacity-0 group-hover/scope:opacity-100 focus-visible:opacity-100"
            />
          </Tooltip>
        )}
      </div>
    </div>
  );
}

export function ScopeBody({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      inert={!open}
      data-scope-body
      className="grid transition-[grid-template-rows,opacity] duration-base ease-enter motion-reduce:transition-none"
      style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
    >
      <div className="min-w-0 overflow-hidden">{children}</div>
    </div>
  );
}

function ScopeMenuButton({ name, items }: { name: string; items: ScopeMenuItem[] }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <Tooltip label="More" align="end">
        <IconButton
          ref={buttonRef}
          size={24}
          data-scope-menu
          label={`${name} actions`}
          icon={MoreVerticalIcon}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={open ? "" : "opacity-0 group-hover/scope:opacity-100 focus-visible:opacity-100"}
        />
      </Tooltip>
      {open && (
        <Popover anchor={buttonRef} width={224} label={`${name} actions`} onClose={close} data-scope-menu-panel>
          {items.map((item) => (
            <Fragment key={item.key}>
              {item.separatorBefore && <MenuSeparator />}
              <MenuRow
                data-scope-menu-item={item.key}
                icon={item.icon}
                title={item.label}
                danger={item.destructive}
                disabled={item.disabled}
                onClick={() => {
                  close();
                  item.run();
                }}
              />
            </Fragment>
          ))}
        </Popover>
      )}
    </>
  );
}

function AttentionDot({ className = "" }: { className?: string }) {
  return <span role="img" aria-label="Needs attention" title="A chat here waits for you" className={`size-2 shrink-0 rounded-full bg-orange ${className}`} />;
}
