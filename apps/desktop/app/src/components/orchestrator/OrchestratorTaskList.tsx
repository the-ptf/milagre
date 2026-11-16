import { sinceLabel, type TaskCard } from "../../lib/orchestrator-board";
import { modelName } from "../../lib/orchestrator-names";
import { usePanelWidth } from "../agents/panel-width";
import { ResizeHandle } from "../primitives/ResizeHandle";
import { ScrollArea } from "../primitives/ScrollArea";
import { SectionLabel } from "../primitives/SectionLabel";
import { COLUMNS } from "./OrchestratorBoard";
import { OrchestratorBox } from "./OrchestratorBox";
import { ProjectIcon, StatusMark, type CardEnv } from "./TaskCards";

export function OrchestratorTaskList({
  cards,
  env,
  openKey,
  onOpen,
  onBoard,
}: {
  cards: readonly TaskCard[];
  env: CardEnv;
  openKey: string | null;
  onOpen: (key: string) => void;
  onBoard: () => void;
}) {
  const panel = usePanelWidth("orchestrator");
  return (
    <div data-orchestrator-task-list className="relative flex min-h-0 flex-1 flex-col gap-2 pl-1" style={{ width: panel.width }}>
      <ResizeHandle
        label="Resize the task list"
        side="right"
        width={panel.width}
        min={panel.min}
        max={560}
        reset={panel.reset}
        onResize={panel.onResize}
        onCommit={panel.onCommit}
        className="!right-[-18px]"
      />
      <OrchestratorBox size="compact" placeholder="Ask for something else…" />
      <ScrollArea className="min-h-0 flex-1 pb-3">
        {COLUMNS.map(({ id, name }) => {
          const list = cards.filter((card) => card.column === id);
          if (!list.length) return null;
          return (
            <section key={id} aria-label={name}>
              <SectionLabel className="flex items-center gap-1.5 px-2 pt-3 pb-1">
                {name}
                <span className="font-normal tabular-nums">{list.length}</span>
              </SectionLabel>
              {list.map((card) => {
                const { task } = card;
                const open = card.key !== null && card.key === openKey;
                return (
                  <button
                    key={task.id}
                    type="button"
                    aria-current={open ? "true" : undefined}
                    onClick={() => (card.key && card.kind === "chat" ? onOpen(card.key) : onBoard())}
                    className={`flex h-12 w-full items-center gap-2 rounded-control px-2 text-left transition-colors active:bg-hover-2 ${open ? "bg-hover-2" : "hover:bg-hover"}`}
                  >
                    <span className="flex w-3.5 shrink-0 justify-center">
                      <StatusMark card={card} />
                    </span>
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="truncate text-13 font-medium text-ink">{task.title}</span>
                      <span className="flex min-w-0 items-center gap-1.5 text-11 text-ink-3">
                        {task.projectPath && <ProjectIcon path={task.projectPath} name={env.projectName(task.projectPath)} />}
                        <span className="truncate">
                          {[env.projectName(task.projectPath), task.model && modelName(task.model)].filter(Boolean).join(" · ") || card.detail}
                        </span>
                      </span>
                    </span>
                    <span className="shrink-0 self-start pt-1.5 text-11 text-ink-3">{sinceLabel(task.createdAt, env.now)}</span>
                  </button>
                );
              })}
            </section>
          );
        })}
      </ScrollArea>
    </div>
  );
}
