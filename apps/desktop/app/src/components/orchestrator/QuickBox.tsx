import { useEffect, useRef, useState } from "react";
import type { OrchestratorTask } from "@milagre/shared/orchestrator";
import { ShortcutKeys } from "../primitives/ShortcutKeys";
import { PebbleBox } from "./PebbleBox";

export function QuickBox({
  name,
  onSent,
  onClose,
}: {
  name: string;
  onSent: (task: OrchestratorTask, from: DOMRect, pebble: DOMRect | null) => void;
  onClose: () => void;
}) {
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
      aria-label={name}
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
        <PebbleBox
          placeholder="What do you need?"
          autoFocus
          onSent={(task, from, pebble) => {
            onSent(task, from, pebble);
            onClose();
          }}
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
