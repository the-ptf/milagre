import { useRef, useState } from "react";
import { ArrowDown01Icon, ArrowUp01Icon, Cancel01Icon, PanelLeftOpenIcon, ShuffleIcon, Undo02Icon } from "@hugeicons/core-free-icons";
import { activeRoles, roleById, type OrchestratorTask } from "@milagre/shared/orchestrator";
import { bridgeForKey } from "../../lib/computer-bridge";
import { routeReason, taskChatKey, taskScope, taskSession } from "../../lib/orchestrator-board";
import { useScopeStates } from "../../lib/sidebar-scopes";
import { useOrchestratorNames } from "../../lib/orchestrator-names";
import { followTask, rerouteTask, showTaskInSidebar, useOrchestrator } from "../../lib/orchestrator-store";
import { Button, IconButton } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { MenuLabel, MenuRow, MenuSeparator, Popover } from "../primitives/Popover";
import { Mascot } from "./Mascot";
import { ModelLabel, ProjectLabel } from "./TaskCards";

function Reroute({ task, onClose }: { task: OrchestratorTask; onClose: () => void }) {
  const { settings } = useOrchestrator();
  const { projects } = useOrchestratorNames();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const go = (change: { projectPath?: string; role?: string }) => {
    setOpen(false);
    followTask(task.id, taskChatKey(task));
    onClose();
    void rerouteTask(task.id, change);
  };
  return (
    <>
      <Button ref={anchor} variant="ghost" size={28} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((value) => !value)}>
        <Icon icon={ShuffleIcon} size={14} />
        Re-route
      </Button>
      {open && (
        <Popover anchor={anchor} width={260} label="Re-route" onClose={() => setOpen(false)}>
          <MenuRow title="Route it again" onClick={() => go({})} />
          <MenuSeparator />
          <MenuLabel>Project</MenuLabel>
          {projects.map((project) => (
            <MenuRow
              key={project.path}
              role="menuitemradio"
              checked={project.path === task.projectPath}
              title={project.name}
              onClick={() => go({ projectPath: project.path })}
            />
          ))}
          <MenuSeparator />
          <MenuLabel>Role</MenuLabel>
          {activeRoles(settings.roles).map((role) => (
            <MenuRow key={role.id} role="menuitemradio" checked={role.id === task.role} title={role.name} onClick={() => go({ role: role.id })} />
          ))}
        </Popover>
      )}
    </>
  );
}

export function OrchestratorTaskHeader({
  task,
  chatKey,
  running,
  onClose,
}: {
  task: OrchestratorTask;
  chatKey: string;
  running: boolean;
  onClose: () => void;
}) {
  const { settings } = useOrchestrator();
  const { projectName } = useOrchestratorNames();
  const [why, setWhy] = useState(false);
  const scope = taskScope(task);
  const { states } = useScopeStates(scope !== null, scope ? [scope] : []);
  const session = taskSession(task, states);
  const inSidebar = session ? !session.orchestrator?.hidden : false;
  const role = roleById(settings.roles, task.role);
  return (
    <header data-orchestrator-task-header={task.id} className="flex shrink-0 flex-col gap-1.5 border-b border-line py-2 pr-2 pl-3">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={why}
          onClick={() => setWhy((value) => !value)}
          className="flex h-7 min-w-0 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-12 whitespace-nowrap text-ink-2 transition-colors hover:bg-hover"
        >
          <Mascot size={16} color={settings.mascotColor} />
          <span className="text-ink-3">Routed to</span>
          <span className="flex min-w-0 items-center gap-1.5 text-ink">
            <ProjectLabel path={task.projectPath} name={projectName(task.projectPath)} />
          </span>
          {role && (
            <>
              <span className="text-ink-3">·</span>
              {role.name}
            </>
          )}
          <span className="text-ink-3">·</span>
          <ModelLabel route={task} />
          <span className="text-ink-3">
            <Icon icon={why ? ArrowUp01Icon : ArrowDown01Icon} size={12} />
          </span>
        </button>
        <span className="flex-1" />
        <Button variant="ghost" size={28} onClick={() => void showTaskInSidebar(task.id, !inSidebar)}>
          <Icon icon={inSidebar ? Undo02Icon : PanelLeftOpenIcon} size={14} />
          {inSidebar ? "Board only" : "Move to sidebar"}
        </Button>
        <Reroute task={task} onClose={onClose} />
        {running && (
          <Button variant="danger-ghost" size={28} onClick={() => void bridgeForKey(chatKey).interruptAgent(chatKey)}>
            Stop
          </Button>
        )}
        <span aria-hidden className="mx-1 h-4 w-px bg-line-strong" />
        <IconButton label="Close" shortcut="Esc" icon={Cancel01Icon} side="bottom" onClick={onClose} />
      </div>
      {why && (
        <p className="px-2.5 text-12 text-ink-3" style={{ animation: "fade-in var(--duration-base) var(--ease-enter)" }}>
          {routeReason(task, "this computer")}
        </p>
      )}
    </header>
  );
}
