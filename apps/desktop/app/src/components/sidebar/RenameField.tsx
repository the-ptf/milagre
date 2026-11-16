import { useLayoutEffect, useRef } from "react";

export function RenameField({
  initial,
  onDone,
  inbox = false,
  edge = false,
  className,
}: {
  initial: string;
  onDone: (title: string | null) => void;
  inbox?: boolean;
  edge?: boolean;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(title);
  };

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      defaultValue={initial}
      aria-label="Chat name"
      maxLength={120}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(event.currentTarget.value.trim());
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(null);
        }
      }}
      onBlur={(event) => finish(event.currentTarget.value.trim())}
      className={
        className
          ? `min-w-0 flex-1 bg-transparent text-ink outline-none ${className}`
          : `sidebar-copy min-w-0 flex-1 bg-transparent font-medium text-ink outline-none ${edge ? "h-5 text-[length:calc(14px+var(--sidebar-delta))] leading-5" : inbox ? "h-[18px] text-[length:calc(13px+var(--sidebar-delta))] leading-[18px]" : "text-[length:calc(14px+var(--sidebar-delta))]"}`
      }
    />
  );
}
