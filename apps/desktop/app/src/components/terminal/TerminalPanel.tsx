import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, ArrowDown01Icon, Cancel01Icon, ComputerTerminal01Icon } from "@hugeicons/core-free-icons";
import type { TerminalInfo, TerminalProfiles } from "@milagre/shared/terminal";
import { bridgeForKey } from "../../lib/computer-bridge";
import { Select } from "../primitives/Select";
import Tooltip from "../primitives/Tooltip";
import { PickerPanel, PickerRow } from "../primitives/Picker";
import { useDismiss } from "../../lib/use-dismiss";
import { closeTerminal, newTerminal, openTerminal, takeFocusRequest, toggleTerminalPanel, type TerminalPlace } from "../../lib/terminal-actions";
import { useSidePanel } from "../agents/PanelToggles";
import { attachTerminal, fitTerminal, focusTerminal, terminalHasFocus } from "../../lib/terminal-sessions";
import {
  chatTerminals,
  saveTerminalHeight,
  setTerminalHeight,
  setTerminalPanelOpen,
  setTerminalPicking,
  showTerminal,
  TERMINAL_HEIGHT,
  useChatTerminals,
  useTerminalHeight,
} from "../../lib/terminal-store";
import { ipcErrorMessage } from "@milagre/shared/result";
import { useEvent } from "../../lib/stable";
import { AnimatePresence } from "motion/react";
import { TerminalSlide } from "./TerminalSlide";

/**
 * The open Chat's Terminals, under its messages: one tab per Terminal, the shown one below. ⌘T adds one, ⌘J hides the
 * panel and ⌘W ends the focused Terminal; ending one that runs a command asks first. The panel's height is shared by
 * every Chat; whether it shows is each Chat's own.
 */
export function TerminalPanel({ chatId, places, notify }: { chatId: string | null; places?: TerminalPlace[]; notify: (message: string) => void }) {
  const { terminals, active, open, picking } = useChatTerminals(chatId);
  const height = useTerminalHeight();
  const panel = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const plus = useRef<HTMLDivElement>(null);
  // A confirmation is for the Terminal it was asked about, while that Terminal is the one shown.
  const [asked, setArmed] = useState<string | null>(null);
  const armed = asked === active ? asked : null;
  const shown = terminals.find((terminal) => terminal.id === active) ?? null;
  const shownId = shown?.id;
  const multiple = (places?.length ?? 0) > 1;
  const [profiles, setProfiles] = useState<TerminalProfiles | null>(null);
  const [savingShell, setSavingShell] = useState(false);
  const profileRevision = useRef(0);
  useEffect(() => {
    profileRevision.current++;
    setProfiles(null);
    setSavingShell(false);
    if (!chatId || !open) return;
    let disposed = false;
    const load = async () => {
      const revision = profileRevision.current;
      try {
        const next = await bridgeForKey(chatId).terminals.profiles();
        if (!disposed && revision === profileRevision.current) setProfiles(next);
      } catch {
        /* Older computers have no shell selector. */
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [chatId, open]);
  async function chooseShell(value: string) {
    if (!chatId) return;
    const revision = ++profileRevision.current;
    setSavingShell(true);
    try {
      const next = await bridgeForKey(chatId).terminals.setShell({ shell: value || null });
      if (revision === profileRevision.current) setProfiles(next);
    } catch (error) {
      notify(`Couldn't select a shell: ${ipcErrorMessage(error)}`);
    } finally {
      if (revision === profileRevision.current) setSavingShell(false);
    }
  }
  // The corner button (⌘J) is offered for every sent Chat, even one with no Terminal yet: it opens the first.
  useSidePanel("terminal", chatId ? { open, toggle: () => toggleTerminalPanel(chatId, places, notify) } : null);

  // Only the shown Terminal's id matters here: a new title or busy state must not move or refit its xterm.
  const latestShown = useRef(shown);
  useLayoutEffect(() => {
    latestShown.current = shown;
  });
  useLayoutEffect(() => {
    const current = latestShown.current;
    if (!open || !current || !body.current) return;
    attachTerminal(current, body.current);
    if (takeFocusRequest(current.id)) focusTerminal(current.id);
  }, [open, shownId]);

  useEffect(() => {
    if (!open || !shownId || !body.current) return;
    const observer = new ResizeObserver(() => fitTerminal(shownId));
    observer.observe(body.current);
    return () => observer.disconnect();
  }, [open, shownId]);

  const close = useEvent((terminal: TerminalInfo) => {
    if (terminal.busy && armed !== terminal.id) {
      setArmed(terminal.id);
      return;
    }
    setArmed(null);
    const refocus = terminalHasFocus(terminal.id);
    void closeTerminal(terminal).then(() => {
      // The list has been read again: focus moves to the Terminal shown now, if the closed one had it.
      const next = chatTerminals(terminal.chatId).active;
      if (refocus && next) requestAnimationFrame(() => focusTerminal(next));
      return undefined;
    });
  });

  useEffect(
    () =>
      window.milagre.onCloseFocusedTerminal(() => {
        const focused = terminals.find((terminal) => terminalHasFocus(terminal.id));
        if (focused) {
          close(focused);
          return;
        }
        // The focused Terminal left the window without a blur (another Chat took its place): ⌘W is the window's again.
        window.milagre.setTerminalFocused(false);
        window.close();
      }),
    [terminals, close],
  );

  // The choice opens with its first Worktree focused, so Enter takes it.
  useEffect(() => {
    // The panel is still rising from zero height; focusing its first row must not scroll the surrounding Chat.
    if (picking) requestAnimationFrame(() => plus.current?.querySelector<HTMLButtonElement>("[data-picker-row]")?.focus({ preventScroll: true }));
  }, [picking]);

  useDismiss(
    picking,
    () => chatId && setTerminalPicking(chatId, false),
    (target) => Boolean(plus.current?.contains(target)),
    // CSS keeps this picker attached to +. Opening the panel resizes and scrolls the Chat above it,
    // so those scrolls must follow the anchor rather than dismiss the Worktree choice.
    () => {},
  );

  function startResize(event: React.PointerEvent) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = panel.current?.getBoundingClientRect().height ?? height;
    const room = (panel.current?.closest("[data-terminal-slot]")?.parentElement?.getBoundingClientRect().height ?? window.innerHeight) * 0.75;
    const move = (next: PointerEvent) => setTerminalHeight(Math.min(room, Math.max(TERMINAL_HEIGHT.min, startHeight + startY - next.clientY)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.documentElement.style.cursor = "";
      saveTerminalHeight();
    };
    document.documentElement.style.cursor = "row-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function add(place?: TerminalPlace) {
    if (!chatId) return;
    if (!place) {
      newTerminal(chatId, places, notify);
      return;
    }
    void openTerminal(chatId, place.path).catch((error) => {
      setTerminalPicking(chatId, false);
      notify(`Couldn't open a Terminal: ${ipcErrorMessage(error)}`);
    });
  }

  // One key for every Chat: moving between two Chats with the panel shown keeps it in place; it rises and falls only
  // when it opens or closes. Closing, the panel goes on showing what it showed until it has fallen.
  return (
    <AnimatePresence>
      {chatId && open && (
        <TerminalSlide key="terminals" height={height}>
          <section ref={panel} data-terminal-panel aria-label="Terminals" className="relative flex h-full flex-col rounded-card border border-line bg-surface">
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize Terminals"
              onPointerDown={startResize}
              className="absolute inset-x-3 -top-1.5 z-10 h-2 cursor-row-resize"
            />
            <header className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-1.5">
              <div role="tablist" aria-label="Terminals" className="flex min-w-0 flex-1 items-center gap-1">
                {terminals.map((terminal) => {
                  const selected = terminal.id === active;
                  const asking = armed === terminal.id;
                  return (
                    <div
                      key={terminal.id}
                      className={`group flex h-7 min-w-0 max-w-[200px] shrink items-center rounded-control text-xs transition-colors ${selected ? "bg-hover text-ink" : "text-ink-3 hover:bg-hover hover:text-ink"}`}
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        data-terminal-tab={terminal.id}
                        onClick={() => {
                          showTerminal(chatId, terminal.id);
                          requestAnimationFrame(() => focusTerminal(terminal.id));
                        }}
                        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1 pl-2"
                      >
                        <HugeiconsIcon icon={ComputerTerminal01Icon} size={13} strokeWidth={1.8} color="currentColor" className="shrink-0" />
                        <span className="truncate font-mono">{terminal.title}</span>
                        {multiple && <span className="truncate text-[10px] text-ink-3">{terminal.label}</span>}
                      </button>
                      {asking ? (
                        // Focus stays in the Terminal, so a second ⌘W confirms.
                        <button
                          type="button"
                          onClick={() => close(terminal)}
                          className="mr-1 shrink-0 rounded-[5px] bg-red-tint px-1.5 py-0.5 text-[11px] font-medium text-red-ink"
                        >
                          End {terminal.title}
                        </button>
                      ) : (
                        <button
                          type="button"
                          aria-label={`Close ${terminal.title}`}
                          onClick={() => close(terminal)}
                          className={`relative mr-1 flex size-5 shrink-0 items-center justify-center rounded-[5px] hover:bg-inset before:absolute before:-inset-0.5 ${selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
                        >
                          <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} color="currentColor" />
                        </button>
                      )}
                    </div>
                  );
                })}
                <div ref={plus} className="relative shrink-0">
                  <Tooltip label="New Terminal" shortcut="⌘T" side="top">
                    <button
                      type="button"
                      aria-label="New Terminal"
                      aria-expanded={multiple ? picking : undefined}
                      onClick={() => (picking ? setTerminalPicking(chatId, false) : add())}
                      className="flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-hover hover:text-ink"
                    >
                      <HugeiconsIcon icon={Add01Icon} size={15} strokeWidth={1.8} color="currentColor" />
                    </button>
                  </Tooltip>
                  {picking && places && (
                    <PickerPanel
                      title="New Terminal in"
                      className="absolute top-full left-0 mt-1 w-56"
                      onKeyDown={(event) => {
                        if (event.key !== "Escape") return;
                        event.preventDefault();
                        event.stopPropagation();
                        setTerminalPicking(chatId, false);
                      }}
                    >
                      {places.map((place) => (
                        <PickerRow key={place.path} label={place.label} description={place.path} selected={false} onClick={() => add(place)} />
                      ))}
                    </PickerPanel>
                  )}
                </div>
              </div>
              {profiles && (
                <Select
                  label="Shell for new Terminals"
                  compact
                  value={profiles.selectedShell ?? ""}
                  disabled={savingShell}
                  width={320}
                  options={[
                    { value: "", label: "Automatic", description: `New Terminals use ${profiles.defaultShell}` },
                    ...profiles.shells.map((item) => ({ value: item.file, label: item.label, description: item.file })),
                  ]}
                  onChange={(value) => void chooseShell(value)}
                />
              )}
              <Tooltip label="Hide Terminals" shortcut="⌘J" side="top" align="end">
                <button
                  type="button"
                  aria-label="Hide Terminals"
                  onClick={() => setTerminalPanelOpen(chatId, false)}
                  className="flex size-7 shrink-0 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-hover hover:text-ink"
                >
                  <HugeiconsIcon icon={ArrowDown01Icon} size={15} strokeWidth={1.8} color="currentColor" />
                </button>
              </Tooltip>
            </header>
            <div ref={body} data-terminal-body className="min-h-0 flex-1 overflow-hidden px-2 pt-1.5 pb-1" />
          </section>
        </TerminalSlide>
      )}
    </AnimatePresence>
  );
}
