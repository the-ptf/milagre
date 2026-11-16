import { useEffect, useRef, useState } from "react";
import { ShortcutKeys } from "../primitives/ShortcutKeys";
import { Mascot } from "./Mascot";
import { OrchestratorBox } from "./OrchestratorBox";

export function QuickBox({ color, onClose }: { color: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
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
      style={{ animation: "pop-in var(--duration-base) var(--ease-enter) backwards" }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <OrchestratorBox
        size="compact"
        placeholder="What do you need?"
        autoFocus
        leading={<Mascot size={32} color={color} followPointer />}
        onSent={onClose}
        onEscape={onClose}
      />
      <div className="mt-2 flex justify-center gap-4 text-11 text-ink-3">
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
    </dialog>
  );
}
