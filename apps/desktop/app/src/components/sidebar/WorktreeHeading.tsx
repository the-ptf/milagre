import { Add01Icon } from "@hugeicons/core-free-icons";
import Tooltip from "@/components/primitives/Tooltip";
import { IconButton } from "../primitives/Button";

/**
 * One Worktree under a Project in the Tree layout: a dot (green while one of its Chats runs) and
 * its branch. A label only: its Chats always show under it. With `onNewChat` a + shows on hover.
 */
export function WorktreeHeading({
  name,
  running = false,
  current = false,
  onNewChat,
}: {
  name: string;
  running?: boolean;
  current?: boolean;
  onNewChat?: () => void;
}) {
  const content = (
    <>
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${running ? "bg-green" : "bg-ink-4"}`} />
      <span className={`min-w-0 truncate ${current ? "font-medium text-ink" : "text-ink-2"}`}>{name}</span>
    </>
  );
  const row = "flex h-7 min-w-0 flex-1 items-center gap-2 rounded-control pr-8 pl-[30px] text-left text-[length:calc(12px+var(--sidebar-delta))]";
  return (
    <div className="group/worktree relative mx-2 flex items-center">
      <div className={row}>{content}</div>
      {onNewChat && (
        <Tooltip label={`New chat in ${name}`} align="end" className="absolute right-1">
          <IconButton
            size={24}
            data-scope-action
            label={`New chat in ${name}`}
            icon={Add01Icon}
            onClick={onNewChat}
            className="opacity-0 group-hover/worktree:opacity-100 focus-visible:opacity-100"
          />
        </Tooltip>
      )}
    </div>
  );
}
