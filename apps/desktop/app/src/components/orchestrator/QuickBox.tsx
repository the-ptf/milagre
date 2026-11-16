import { useEffect, useRef, useState } from "react";
import { gazeToward } from "../../lib/orchestrator-board";
import { ShortcutKeys } from "../primitives/ShortcutKeys";
import { Mascot, type Look } from "./Mascot";
import { OrchestratorBox } from "./OrchestratorBox";

export function QuickBox({ color, onClose }: { color: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  const [look, setLook] = useState<Look>(null);
  const mascot = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);
  return (
    <dialog
      ref={dialog}
      aria-label="Orchestrator"
      data-orchestrator-quick-box
      className="command-palette no-drag fixed m-0 w-[min(640px,calc(100vw-32px))] overflow-visible bg-transparent p-0 text-ink"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div style={{ animation: "pop-in var(--duration-base) var(--ease-enter) backwards" }}>
        <OrchestratorBox
          size="compact"
          placeholder="What do you need?"
          autoFocus
          leading={
            <span ref={mascot} className="flex">
              <Mascot size={32} color={color} look={look} followPointer />
            </span>
          }
          onCaret={(caret) => setLook(caret && mascot.current ? gazeToward(mascot.current.getBoundingClientRect(), caret) : null)}
          onSent={onClose}
          onEscape={onClose}
        />
        <div className="mt-2 flex justify-center gap-4 text-11 text-ink-2">
          <span className="flex items-center gap-1">
            <ShortcutKeys shortcut="Enter" /> send
          </span>
          <span className="flex items-center gap-1">
            <ShortcutKeys shortcut="Shift+Enter" /> new line
          </span>
          <span className="flex items-center gap-1">
            <ShortcutKeys shortcut="Esc" /> close
          </span>
        </div>
      </div>
    </dialog>
  );
}
