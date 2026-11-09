import { useEffect, useRef, useState, type ReactNode } from "react";
import { MenuRow, Popover } from "../primitives/Popover";

/** Secondary comment actions, without changing the button's normal click. */
export function CommentOptions({ children, shown, onChange }: { children: ReactNode; shown: boolean; onChange: (shown: boolean) => void }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const held = useRef(false);
  const [open, setOpen] = useState(false);
  const cancel = () => clearTimeout(timer.current);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <span
      ref={anchor}
      className="inline-flex"
      onContextMenu={(event) => {
        event.preventDefault();
        cancel();
        setOpen(true);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        held.current = false;
        cancel();
        timer.current = setTimeout(() => {
          held.current = true;
          setOpen(true);
        }, 500);
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onClickCapture={(event) => {
        if (held.current) {
          event.preventDefault();
          event.stopPropagation();
          held.current = false;
        }
      }}
    >
      {children}
      {open && (
        <Popover anchor={anchor} label="Comment options" onClose={() => setOpen(false)}>
          <MenuRow
            title="Show resolved comments"
            checked={shown}
            onClick={() => {
              onChange(!shown);
              setOpen(false);
            }}
          />
        </Popover>
      )}
    </span>
  );
}
