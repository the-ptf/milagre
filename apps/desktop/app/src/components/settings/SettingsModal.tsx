import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { IconButton } from "../primitives/Button";

/**
 * Settings over whatever the window shows: a native modal <dialog> in the top layer, the nav on the left and the page
 * on the right, at most 1120 × 800 and inset from the window's top bar so the traffic lights stay clear. Esc, the ×
 * and a press on the scrim close it; the Chat behind keeps its state. Pickers inside find the dialog as their layer
 * host (Tooltip's layerHost, Select), as in any other dialog.
 */
export function SettingsModal({ nav, children, onClose }: { nav: ReactNode; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  // A press that starts inside and ends on the scrim (a text drag out of a field) isn't a press on the scrim.
  const downInside = useRef(false);
  useEffect(() => {
    const node = dialog.current;
    if (!node?.open) node?.showModal();
    // Focus the dialog, not its first control: the nav's search loads lazily, so showModal would land on the × and ring it.
    node?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      if (opener?.isConnected && (!active || active === document.body || node?.contains(active))) opener.focus({ preventScroll: true });
    };
  }, [opener]);
  return createPortal(
    <dialog
      ref={dialog}
      aria-label="Settings"
      data-settings-modal
      tabIndex={-1}
      onCancel={(event) => {
        // Nested dialogs portal to the body, but their cancel events still follow the React tree.
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        downInside.current = event.target !== dialog.current;
      }}
      onClick={(event) => {
        if (!downInside.current && event.target === dialog.current) onClose();
        downInside.current = false;
      }}
      className="m-auto overflow-hidden rounded-window outline-none bg-surface p-0 text-ink shadow-overlay backdrop:bg-scrim backdrop:backdrop-blur-overlay"
      style={{
        width: "min(1120px, calc(100vw - 48px))",
        height: "min(800px, calc(100vh - 2 * max(24px, var(--window-chrome-height))))",
        maxWidth: "none",
        maxHeight: "none",
        animation: "pop-in var(--duration-base) var(--ease-enter) backwards",
      }}
    >
      <div className="relative flex h-full min-h-0">
        {nav}
        <main className="relative min-w-0 flex-1">{children}</main>
        <span className="absolute top-3 right-3 z-10 flex">
          <IconButton label="Close Settings" icon={Cancel01Icon} size={28} tooltip={false} onClick={onClose} />
        </span>
      </div>
    </dialog>,
    document.body,
  );
}
