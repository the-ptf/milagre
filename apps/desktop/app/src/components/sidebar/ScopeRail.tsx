import { useEffect, useRef, useState, type ReactNode, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { SpinnerRing } from "../primitives/SpinnerRing";
import { ChatMarkDotInline, type SidebarRecent } from "./ChatRow";
import { useDismiss } from "../../lib/use-dismiss";
import type { RailStatus } from "../../lib/sidebar-scopes";

/** One Project, Link or Chat on the collapsed rail. */
export type RailScope = {
  key: string;
  name: string;
  icon: ReactNode;
  current: boolean;
  /** One list opens this Chat directly; grouped items open their scope. */
  chat?: { scopeKey: string; id: string };
  /** What the icon's corner shows: a chat asking or waiting wins over one running. */
  status: RailStatus;
  /** The chats with a turn under way or waiting on the user, listed in the popover. */
  chats: SidebarRecent[];
};

const OPEN_DELAY = 300;
const CLOSE_GRACE = 250;
const POPOVER_WIDTH = 240;

const STATUS_LABEL: Record<RailStatus, string> = { attention: "waits for you", running: "running", idle: "" };

/**
 * The collapsed sidebar: one icon per scope in By Project, or per Chat in One list. Resting on an icon
 * opens its Chats beside the rail; a Chat item opens directly, and a scope item switches Projects.
 */
export function ScopeRail({
  scopes,
  onOpenScope,
  onOpenChat,
}: {
  scopes: RailScope[];
  /** The icon was clicked: a scope that isn't open opens. */
  onOpenScope: (key: string) => void;
  onOpenChat: (key: string, id: string) => void;
}) {
  const [shown, setShown] = useState<{ key: string; top: number; left: number; flip: boolean } | null>(null);
  const timer = useRef<number | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const place = (key: string, button: HTMLElement) => {
    triggerRef.current = button;
    const rect = button.getBoundingClientRect();
    const rail = button.closest("aside")?.getBoundingClientRect() ?? rect;
    // Icons low in the window open upwards so the list stays on screen.
    const flip = rect.top > window.innerHeight - 240;
    setShown({ key, top: flip ? window.innerHeight - rect.bottom - 4 : rect.top - 4, left: rail.right + 8, flip });
  };
  const showSoon = (key: string, button: HTMLElement) => {
    clear();
    if (shown?.key === key) return;
    timer.current = window.setTimeout(() => place(key, button), OPEN_DELAY);
  };
  const hideSoon = () => {
    clear();
    if (shown) timer.current = window.setTimeout(() => setShown(null), CLOSE_GRACE);
  };
  const hide = () => {
    clear();
    setShown(null);
  };
  useDismiss(Boolean(shown), hide, (target) => Boolean(railRef.current?.contains(target) || popoverRef.current?.contains(target)));
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    triggerRef.current?.focus();
    hide();
  };
  const open = shown ? scopes.find((scope) => scope.key === shown.key) : undefined;
  return (
    <div ref={railRef} onKeyDown={escape} data-scope-rail className="mx-auto flex w-8 flex-col gap-px">
      {scopes.map((scope) => (
        <button
          key={scope.key}
          type="button"
          data-rail-scope={scope.key}
          data-rail-status={scope.status}
          aria-current={scope.current ? "true" : undefined}
          aria-label={`${scope.name}${scope.chat ? `, ${scope.chats[0]?.label ?? "Chat"}` : ""}${scope.status === "idle" ? "" : `, a chat ${STATUS_LABEL[scope.status]}`}`}
          onClick={() => {
            hide();
            if (scope.chat) onOpenChat(scope.chat.scopeKey, scope.chat.id);
            else if (!scope.current) onOpenScope(scope.key);
          }}
          onPointerEnter={(event) => showSoon(scope.key, event.currentTarget)}
          onPointerLeave={hideSoon}
          onFocus={(event) => {
            clear();
            place(scope.key, event.currentTarget);
          }}
          onBlur={hideSoon}
          className={`relative flex size-8 items-center justify-center rounded-[8px] transition-[background-color,transform] duration-150 active:scale-[0.96] ${scope.current ? "bg-hover-2" : "hover:bg-hover-2"}`}
        >
          <span className="relative flex items-center justify-center">
            {scope.icon}
            {scope.status === "attention" ? (
              <span aria-hidden className="absolute -right-1 -top-1 size-2 rounded-full bg-orange ring-2 ring-surface" />
            ) : (
              scope.status === "running" && (
                <span aria-hidden className="absolute -right-1.5 -top-1.5 flex rounded-full bg-surface p-px">
                  <SpinnerRing size={10} stroke={1.75} color="var(--accent)" />
                </span>
              )
            )}
          </span>
        </button>
      ))}
      {shown &&
        open &&
        createPortal(
          <div
            ref={popoverRef}
            onKeyDown={escape}
            data-scope-rail-popover={open.key}
            role="group"
            aria-label={open.name}
            onPointerEnter={clear}
            onPointerLeave={hideSoon}
            className="fixed z-[60] rounded-[12px] bg-surface p-2 shadow-overlay"
            style={{
              left: shown.left,
              width: POPOVER_WIDTH,
              ...(shown.flip ? { bottom: shown.top } : { top: shown.top }),
              animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both",
              transformOrigin: shown.flip ? "bottom left" : "top left",
            }}
          >
            <div className="truncate px-2 pt-1 pb-1.5 text-[12.5px] font-medium text-ink-3">{open.name}</div>
            {open.chats.length > 0 ? (
              <div className="flex flex-col gap-px">
                {open.chats.map((chat) => (
                  <button
                    key={chat.id}
                    type="button"
                    data-rail-chat={chat.id}
                    onClick={() => {
                      hide();
                      onOpenChat(open.chat?.scopeKey ?? open.key, chat.id);
                    }}
                    className="flex h-8 w-full min-w-0 items-center gap-2 rounded-[8px] px-2 text-left text-[13px] font-medium text-ink-2 hover:bg-hover-2 hover:text-ink focus-visible:bg-hover-2 focus-visible:outline-none"
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      <ChatMarkDotInline mark={chat.mark ?? "idle"} failed={false} background={chat.background} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{chat.label}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="px-2 pb-1 text-[13px] text-ink-3">No chat running</p>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
