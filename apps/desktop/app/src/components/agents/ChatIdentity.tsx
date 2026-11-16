import { useLayoutEffect, useRef } from "react";
import { setBookmarkReserve } from "../../lib/bookmark-reserve";
import { useControlsClearance } from "../../lib/window-chrome";

export function ChatIdentity({ title, project, corner }: { title: string; project?: string; corner: number }) {
  const { bar, inset } = useControlsClearance<HTMLDivElement>(true, corner);
  const group = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = bar.current?.offsetParent;
    const box = group.current;
    if (!(host instanceof HTMLElement) || !box) return;
    const update = () => setBookmarkReserve(box.getBoundingClientRect().right - host.getBoundingClientRect().left + 8);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(box);
    observer.observe(host);
    return () => {
      observer.disconnect();
      setBookmarkReserve(0);
    };
  }, [bar]);
  return (
    <div
      ref={bar}
      data-chat-identity
      style={inset}
      className="pointer-events-none absolute inset-x-3 top-[var(--window-chrome-top)] z-[55] flex h-8 select-none items-center"
    >
      <div ref={group} className="flex min-w-0 max-w-full items-baseline gap-2 text-13">
        <span data-chat-identity-title className="min-w-0 truncate font-medium text-ink">
          {title}
        </span>
        {project && (
          <span data-chat-identity-project className="shrink-0 truncate text-ink-3">
            {project}
          </span>
        )}
      </div>
    </div>
  );
}
