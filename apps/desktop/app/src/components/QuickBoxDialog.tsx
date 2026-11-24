import { useEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { ShortcutKeys } from "./primitives/ShortcutKeys";

export function QuickBoxDialog({
  label,
  hints,
  onClose,
  children,
  ...dialog
}: {
  label: string;
  hints: readonly (readonly [shortcut: string, action: string])[];
  onClose: () => void;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<"dialog">, "children">) {
  const node = useRef<HTMLDialogElement>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    if (node.current && !node.current.open) node.current.showModal();
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);
  return (
    <dialog
      {...dialog}
      ref={node}
      aria-label={label}
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
        {children}
        <div className="mt-2 flex justify-center gap-4 text-11 text-ink-2">
          {hints.map(([shortcut, action]) => (
            <span key={action} className="flex items-center gap-1">
              <ShortcutKeys shortcut={shortcut} /> {action}
            </span>
          ))}
        </div>
      </div>
    </dialog>
  );
}
