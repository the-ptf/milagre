import { useEffect, useState } from "react";
import { shortcutCommand, useShortcutLabel } from "../../lib/keybindings";
import { isModalOpen } from "../../lib/modal";
import { focusOrchestratorBox, requestTaskOpen } from "../../lib/orchestrator-store";
import { useOrchestratorBoard } from "../../lib/use-orchestrator-board";
import { SpinnerRing } from "../primitives/SpinnerRing";
import Tooltip from "../primitives/Tooltip";
import { Mascot } from "./Mascot";
import { QuickBox } from "./QuickBox";
import { StartedToast } from "./StartedToast";

export function OrchestratorSidebarRow({ active, onShow }: { active: boolean; onShow: () => void }) {
  const { orchestrator, counts, names } = useOrchestratorBoard();
  const { settings } = orchestrator;
  const [quick, setQuick] = useState(false);
  const shortcut = useShortcutLabel("orchestrator.open");
  useEffect(() => {
    if (!settings.enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || shortcutCommand(event) !== "orchestrator.open") return;
      if (isModalOpen() && !document.querySelector("dialog[data-orchestrator-quick-box]")) return;
      event.preventDefault();
      if (active) focusOrchestratorBox();
      else setQuick((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settings.enabled, active]);
  if (!settings.enabled) return null;
  const openTask = (key: string) => {
    onShow();
    requestTaskOpen(key);
  };
  return (
    <div className="shrink-0 border-b border-line px-1.5 py-1.5">
      <Tooltip label="Orchestrator" shortcut={shortcut} side="bottom" className="w-full">
        <button
          type="button"
          data-orchestrator-row
          aria-current={active ? "page" : undefined}
          onClick={() => {
            requestTaskOpen(null);
            onShow();
          }}
          className={`flex h-8 w-full items-center gap-2 rounded-control px-2 text-left transition-colors active:bg-hover-2 ${active ? "bg-hover-2" : "hover:bg-hover"}`}
        >
          <Mascot size={20} color={settings.mascotColor} />
          <span className="sidebar-copy min-w-0 flex-1 truncate text-[length:calc(13px+var(--sidebar-delta))] font-semibold text-ink in-data-[sidebar-collapsed=true]:hidden">
            Orchestrator
          </span>
          {counts.running > 0 && (
            <span
              aria-label={`${counts.running} running`}
              className="flex items-center gap-1 text-11 text-ink-3 tabular-nums in-data-[sidebar-collapsed=true]:hidden"
            >
              <SpinnerRing size={12} />
              {counts.running}
            </span>
          )}
          {counts.needs > 0 && (
            <span
              aria-label={`${counts.needs} need you`}
              className="flex items-center gap-1 text-11 text-orange-ink tabular-nums in-data-[sidebar-collapsed=true]:hidden"
            >
              <span aria-hidden className="size-1.5 rounded-full bg-orange" />
              {counts.needs}
            </span>
          )}
        </button>
      </Tooltip>
      {quick && <QuickBox color={settings.mascotColor} onClose={() => setQuick(false)} />}
      <StartedToast tasks={orchestrator.tasks} color={settings.mascotColor} projectName={names.projectName} onOpen={openTask} />
    </div>
  );
}
