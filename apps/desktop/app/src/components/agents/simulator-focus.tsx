import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowExpand01Icon, ArrowShrink01Icon } from "@hugeicons/core-free-icons";
import { IconButton } from "../primitives/Button";
import { shortcutCommand, useShortcutLabel } from "../../lib/keybindings";
import { isModalOpen } from "../../lib/modal";

export type SimulatorFocus = { focused: boolean; toggle(): void; closeFrame(): void };

/**
 * The simulator viewer filling the window. The `simulator.focus` shortcut toggles it while a device is on screen;
 * Escape leaves it before anything else takes the key, and `closeFrame`, Escape pressed inside the viewer, leaves it before
 * calling `close`. Closing the viewer or switching Chats leaves it too.
 */
export function useSimulatorFocus(shown: boolean, chatId: string, close: () => void): SimulatorFocus {
  const [focus, setFocus] = useState(false);
  const viewer = shown ? chatId : null;
  const [seen, setSeen] = useState(viewer);
  if (seen !== viewer) {
    setSeen(viewer);
    setFocus(false);
  }
  const focused = shown && focus;
  const live = useRef({ focused, close });
  useEffect(() => {
    live.current = { focused, close };
  });
  const toggle = useCallback(() => setFocus((current) => !current), []);
  useEffect(() => {
    if (!shown) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || isModalOpen()) return;
      const leaving = event.key === "Escape" && live.current.focused && !document.documentElement.hasAttribute("data-popover-open");
      if (!leaving && shortcutCommand(event) !== "simulator.focus") return;
      event.preventDefault();
      event.stopPropagation();
      if (leaving) setFocus(false);
      else toggle();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown, toggle]);
  const closeFrame = useCallback(() => {
    if (live.current.focused) setFocus(false);
    else live.current.close();
  }, []);
  return { focused, toggle, closeFrame };
}

/** Docked beside the Chat, or filling the window under the title bar, inset like the sidebar's card and above the other panels. */
export function simulatorDockLayout(focused: boolean, dock: { top: number; right: number; bottom: number } | null, width: number) {
  const top = dock?.top ?? 40,
    bottom = dock?.bottom ?? 12;
  const style: CSSProperties = focused ? { top, left: bottom, right: bottom, bottom } : { top, right: (dock?.right ?? 0) + 12, bottom };
  return {
    width: focused ? null : width,
    style,
    className: `fixed focus:outline-none ${focused ? "z-[45]" : "z-[42]"}`,
    "data-focused": focused || undefined,
  };
}

export function SimulatorFocusButton({ focus }: { focus: SimulatorFocus }) {
  const shortcut = useShortcutLabel("simulator.focus");
  return (
    <IconButton
      size={32}
      label={focus.focused ? "Exit full window" : "Fill the window"}
      shortcut={shortcut}
      icon={focus.focused ? ArrowShrink01Icon : ArrowExpand01Icon}
      aria-pressed={focus.focused}
      data-slot="simulator-focus"
      onClick={focus.toggle}
    />
  );
}
