import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { OrchestratorTask } from "@milagre/shared/orchestrator";
import { taskChatKey } from "../../lib/orchestrator-board";
import { undoTask, wasSentHere } from "../../lib/orchestrator-store";
import { Mascot } from "./Mascot";

const TOAST_MS = 5000;
const ACTION = "relative shrink-0 rounded-chip px-2 py-1 text-13 font-medium text-on-ink transition-opacity before:absolute before:-inset-1 hover:opacity-80";

export function StartedToast({
  tasks,
  color,
  projectName,
  onOpen,
}: {
  tasks: readonly OrchestratorTask[];
  color: string;
  projectName: (path: string | null) => string;
  onOpen: (key: string) => void;
}) {
  const before = useRef(new Map<string, OrchestratorTask["state"]>());
  const [shown, setShown] = useState<OrchestratorTask | null>(null);
  const [center, setCenter] = useState<number | null>(null);

  useEffect(() => {
    let started: OrchestratorTask | null = null;
    for (const task of tasks) {
      const was = before.current.get(task.id);
      if (task.state === "started" && was && was !== "started" && wasSentHere(task.id)) started = task;
    }
    before.current = new Map(tasks.map((task) => [task.id, task.state]));
    if (started) setShown(started);
  }, [tasks]);

  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => setShown(null), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [shown]);

  useLayoutEffect(() => {
    if (!shown) return;
    const main = document.querySelector("[data-workspace-main]")?.getBoundingClientRect();
    setCenter(main ? main.left + main.width / 2 : window.innerWidth / 2);
  }, [shown]);

  if (!shown || center === null) return null;
  const key = taskChatKey(shown);
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      data-orchestrator-toast
      className="fixed bottom-4 z-[80] flex -translate-x-1/2 items-center gap-2 rounded-card bg-ink py-1.5 pr-1.5 pl-3 text-13 whitespace-nowrap text-on-ink shadow-raised"
      style={{ left: center, animation: "fade-up var(--duration-slow) var(--ease-enter) backwards" }}
    >
      <Mascot size={20} color={color} mood="happy" />
      <span>
        Started in <span className="font-semibold">{projectName(shown.projectPath)}</span>
      </span>
      <button
        type="button"
        className={ACTION}
        onClick={() => {
          setShown(null);
          void undoTask(shown.id);
        }}
      >
        Undo
      </button>
      {key && (
        <button
          type="button"
          className={ACTION}
          onClick={() => {
            setShown(null);
            onOpen(key);
          }}
        >
          Open
        </button>
      )}
    </div>,
    document.body,
  );
}
