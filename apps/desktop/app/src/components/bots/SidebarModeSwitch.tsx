import { BotIcon, Folder01Icon } from "@hugeicons/core-free-icons";
import { IconButton } from "@/components/primitives/Button";
import { Segmented } from "@/components/primitives/Segmented";

export type SidebarMode = "projects" | "bots";

const MODES = [
  { value: "projects", label: "Projects", icon: Folder01Icon },
  { value: "bots", label: "Bots", icon: BotIcon },
] as const;

/** Projects | Bots at the top of the sidebar; collapsed, two icon buttons on the rail, the open one pressed. */
export function SidebarModeSwitch({ mode, onMode, collapsed }: { mode: SidebarMode; onMode: (mode: SidebarMode) => void; collapsed: boolean }) {
  if (collapsed)
    return (
      <div data-sidebar-mode-switch className="mx-auto mb-2 flex w-8 flex-col items-center gap-1">
        {MODES.map((item) => (
          <IconButton
            key={item.value}
            label={item.label}
            icon={item.icon}
            size={32}
            aria-pressed={mode === item.value}
            data-sidebar-mode={item.value}
            onClick={() => onMode(item.value)}
          />
        ))}
      </div>
    );
  return (
    <div data-sidebar-mode-switch className="mx-2 mb-3 shrink-0">
      <Segmented label="Sidebar" size="large" dataKey="sidebar-mode" value={mode} options={MODES} onChange={onMode} />
    </div>
  );
}
