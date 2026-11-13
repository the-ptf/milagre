import { useLayoutEffect, useRef } from "react";
import { setBookmarkReserve } from "../../lib/bookmark-reserve";
import { useControlsClearance } from "../../lib/window-chrome";

/**
 * The open Chat's name in the window's top strip, at the left of <main>: its title (13 medium ink), then its Project
 * (13 ink-3). The title truncates first; the Project stays. Its first glyph starts on the strip's edge, with no padding of
 * its own: 12px in from <main>, or one gap after the window controls and the sidebar's bar when they reach over it (the
 * sidebar collapsed), where a Subchat's parent crumb starts too. A Subchat shows its SubchatBookmark there instead, which names
 * it with its parent. Its right edge goes into the bookmark reserve (bookmark-reserve.ts), so the Routine chip keeps clear
 * of it; `corner` is the width (px) of the corner's buttons, which it stops short of. With no cap of its own, the title
 * runs as far as that room allows before it truncates.
 */
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
