import { Add01Icon, Notification01Icon } from "@hugeicons/core-free-icons";
import type { BotsSnapshot } from "@milagre/shared/bots";
import { BotAvatar } from "./BotAvatar";
import { Icon } from "../primitives/Icon";
import { SectionLabel } from "../primitives/SectionLabel";

/** 08:05 today; Oct 14 before that. */
function botTime(at: number | null, now = Date.now()) {
  if (at == null) return "";
  const date = new Date(at);
  return new Date(now).toDateString() === date.toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The Bots side of the sidebar: what waits on the user, then each bot with its last line. */
export function BotList({
  snapshot,
  selectedBotId,
  onPickBot,
  collapsed,
}: {
  snapshot: BotsSnapshot | null;
  selectedBotId: string | null;
  onPickBot: (id: string) => void;
  collapsed: boolean;
}) {
  const bots = snapshot?.bots ?? [];
  const pending = (snapshot?.gates ?? []).filter((gate) => gate.status === "pending" && bots.some((bot) => bot.id === gate.botId));
  return (
    <div data-bot-list className="flex flex-col">
      {pending.length > 0 && (
        <button
          type="button"
          data-needs-you
          aria-label={`Needs you: ${pending.length}`}
          onClick={() => {
            const first = [...pending].sort((a, b) => a.createdAt - b.createdAt)[0];
            if (first) onPickBot(first.botId);
          }}
          className={`sidebar-rail-button mb-3 flex h-8 items-center rounded-control border border-orange/30 bg-orange-tint text-orange-ink transition-transform duration-fast ease-enter active:scale-press ${
            collapsed ? "mx-auto w-8 justify-center" : "mx-2 gap-1.5 px-2"
          }`}
        >
          <Icon icon={Notification01Icon} size={16} className="shrink-0" />
          <span className="sidebar-copy min-w-0 flex-1 truncate text-left text-13 font-medium">Needs you</span>
          <span data-needs-you-count className="sidebar-copy shrink-0 text-12 font-semibold tabular-nums">
            {pending.length}
          </span>
        </button>
      )}
      <SectionLabel as="p" className="sidebar-copy mx-2 mb-1 h-6 pl-2 leading-6">
        Bots
      </SectionLabel>
      {bots.map((bot) => {
        const active = bot.id === selectedBotId;
        return (
          <button
            key={bot.id}
            type="button"
            data-row
            data-bot-id={bot.id}
            aria-current={active ? "page" : undefined}
            onClick={() => onPickBot(bot.id)}
            title={collapsed ? bot.name : undefined}
            className={`sidebar-row relative mx-2 mb-px flex h-12 items-center gap-2 rounded-control px-1.5 text-left transition-[background-color,transform] duration-fast ease-enter active:scale-press ${
              active ? "bg-hover-2" : "hover:bg-hover-sidebar"
            }`}
          >
            <BotAvatar color={bot.color} body={bot.body} size={28} />
            <span className="sidebar-copy flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-1.5">
                <span className={`min-w-0 flex-1 truncate text-13 ${bot.unread ? "font-semibold text-ink" : "font-medium text-ink"}`}>{bot.name}</span>
                {bot.unread && <span aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-ink" />}
                <span className="shrink-0 text-12 tabular-nums text-ink-3">{botTime(bot.lastAt)}</span>
              </span>
              <span data-bot-preview className="truncate text-12 text-ink-3">
                {bot.preview || bot.role}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The sidebar's last row in Bots: starts the New bot sheet. */
export function NewBotButton({ onClick, collapsed }: { onClick: () => void; collapsed: boolean }) {
  return (
    <button
      type="button"
      data-new-bot
      aria-label="New bot"
      onClick={onClick}
      className={`sidebar-rail-button flex h-8 items-center rounded-control text-13 text-ink-2 transition-colors duration-fast hover:bg-hover-sidebar hover:text-ink ${
        collapsed ? "mx-auto w-8 justify-center" : "mx-2 gap-1.5 px-2"
      }`}
    >
      <Icon icon={Add01Icon} size={16} className="shrink-0" />
      <span className="sidebar-copy truncate">New bot</span>
    </button>
  );
}
