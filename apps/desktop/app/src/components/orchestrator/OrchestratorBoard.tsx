import { useEffect, useState } from "react";
import type { BoardColumn } from "@milagre/shared/orchestrator";
import type { TaskCard } from "../../lib/orchestrator-board";
import { ScrollArea } from "../primitives/ScrollArea";
import { Select } from "../primitives/Select";
import { ChatCard, DecidingCard, FailedCard, PickProjectCard, type CardEnv } from "./TaskCards";

export const COLUMNS: { id: BoardColumn; name: string }[] = [
  { id: "running", name: "Running" },
  { id: "needs", name: "Needs you" },
  { id: "review", name: "In review" },
  { id: "done", name: "Done" },
];

const ALL = "all";

function useSettling(cards: readonly TaskCard[]) {
  const [settling, setSettling] = useState<ReadonlySet<string>>(() => new Set());
  const routing = cards.filter((card) => card.kind === "deciding").map((card) => card.task.id);
  const fresh = routing.filter((id) => !settling.has(id)).join("\n");
  useEffect(() => {
    if (fresh) setSettling((previous) => new Set([...previous, ...fresh.split("\n")]));
  }, [fresh]);
  const settle = (id: string) =>
    setSettling((previous) => {
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  const deciding = (card: TaskCard) => card.kind === "deciding" || (card.kind === "chat" && settling.has(card.task.id));
  return { deciding, settle, column: (card: TaskCard): BoardColumn => (deciding(card) ? "running" : card.column) };
}

export function OrchestratorBoard({
  cards,
  env,
  hiddenTask,
  onOpen,
}: {
  cards: readonly TaskCard[];
  env: CardEnv;
  hiddenTask: string | null;
  onOpen: (key: string) => void;
}) {
  const [filter, setFilter] = useState(ALL);
  const { deciding, settle, column } = useSettling(cards);
  const shown = cards.filter((card) => filter === ALL || card.task.projectPath === filter);
  const paths = new Set(cards.flatMap((card) => (card.task.projectPath ? [card.task.projectPath] : [])));
  const render = (card: TaskCard) => {
    if (deciding(card)) return <DecidingCard key={card.task.id} card={card} env={env} hidden={card.task.id === hiddenTask} onSettled={settle} />;
    if (card.kind === "pick-project") return <PickProjectCard key={card.task.id} card={card} env={env} />;
    if (card.kind === "failed") return <FailedCard key={card.task.id} card={card} />;
    return <ChatCard key={card.task.id} card={card} env={env} onOpen={onOpen} />;
  };
  return (
    <section
      data-orchestrator-board
      aria-label="Tasks"
      className="flex min-h-0 flex-1 flex-col"
      style={{ animation: "fade-in var(--duration-base) var(--ease-enter)" }}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 px-6">
        <h2 className="text-15 font-semibold text-ink">Tasks</h2>
        <span className="text-12 text-ink-3 tabular-nums">{shown.length}</span>
        <span className="flex-1" />
        <Select
          label="Project"
          variant="chip"
          width={240}
          value={filter}
          options={[
            { value: ALL, label: "All Projects" },
            ...env.projects.filter((project) => paths.has(project.path)).map((project) => ({ value: project.path, label: project.name })),
          ]}
          onChange={setFilter}
        />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-4 gap-3 px-6 pb-4">
        {COLUMNS.map(({ id, name }) => {
          const list = shown.filter((card) => column(card) === id);
          return (
            <div key={id} data-board-column={id} className="flex min-h-0 flex-col rounded-card bg-canvas p-2 shadow-hairline">
              <div className="flex h-7 shrink-0 items-center gap-2 px-1 pb-1 text-12 font-medium text-ink-2">
                {id === "needs" && <span aria-hidden className="size-2 rounded-full bg-orange" />}
                {name}
                <span className="font-normal text-ink-3 tabular-nums">{list.length}</span>
              </div>
              <ScrollArea className="flex min-h-0 flex-1 flex-col gap-2">
                {list.map(render)}
                {list.length === 0 && <p className="px-2 py-4 text-center text-12 text-ink-3">Nothing here</p>}
              </ScrollArea>
            </div>
          );
        })}
      </div>
    </section>
  );
}
