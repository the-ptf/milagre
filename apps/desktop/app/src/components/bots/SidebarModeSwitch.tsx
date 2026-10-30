import { BotIcon, Folder01Icon } from "@hugeicons/core-free-icons";
import Tooltip from "@/components/primitives/Tooltip";
import { Icon } from "@/components/primitives/Icon";

export type SidebarMode = "projects" | "bots";

const MODES = [
  { mode: "projects", label: "Projects", icon: Folder01Icon },
  { mode: "bots", label: "Bots", icon: BotIcon },
] as const;

/** Projects | Bots at the top of the sidebar; collapsed, two icon buttons on the rail. */
export function SidebarModeSwitch({ mode, onMode, collapsed }: { mode: SidebarMode; onMode: (mode: SidebarMode) => void; collapsed: boolean }) {
  if (collapsed)
    return (
      <div data-sidebar-mode-switch className="mx-auto mb-2 flex w-8 flex-col items-center gap-1">
        {MODES.map((item) => (
          <Tooltip key={item.mode} label={item.label}>
            <button
              type="button"
              aria-label={item.label}
              aria-pressed={mode === item.mode}
              data-sidebar-mode={item.mode}
              onClick={() => onMode(item.mode)}
              className={`flex size-8 items-center justify-center rounded-control transition-colors duration-fast hover:text-ink ${
                mode === item.mode ? "bg-hover-2 text-ink" : "text-ink-3 hover:bg-hover-sidebar"
              }`}
            >
              <Icon icon={item.icon} size={16} />
            </button>
          </Tooltip>
        ))}
      </div>
    );
  return (
    <div data-sidebar-mode-switch role="group" aria-label="Sidebar" className="mx-2 mb-3 flex h-8 shrink-0 gap-0.5 rounded-control bg-field p-0.5">
      {MODES.map((item) => (
        <button
          key={item.mode}
          type="button"
          aria-pressed={mode === item.mode}
          data-sidebar-mode={item.mode}
          onClick={() => onMode(item.mode)}
          className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-chip text-13 font-medium transition-[background-color,color,box-shadow] duration-fast ${
            mode === item.mode ? "bg-surface text-ink shadow-card" : "text-ink-3 hover:text-ink"
          }`}
        >
          <Icon icon={item.icon} size={14} className="shrink-0" />
          <span className="truncate">{item.label}</span>
        </button>
      ))}
    </div>
  );
}
