import { useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import {
  CheckmarkCircle02Icon,
  ComputerIcon,
  Delete02Icon,
  GitMergeIcon,
  GitPullRequestIcon,
  HourglassIcon,
  Image01Icon,
  MoreHorizontalIcon,
  PanelLeftOpenIcon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";
import { roleById, type BoardColumn, type OrchestratorRole, type OrchestratorTask } from "@milagre/shared/orchestrator";
import type { ModelProvider } from "../../model";
import { sinceLabel, type TaskCard } from "../../lib/orchestrator-board";
import { routeLabel } from "../../lib/orchestrator-names";
import { deleteTask, dismissTask, pickTaskProject, rerouteTask, showTaskInSidebar } from "../../lib/orchestrator-store";
import { useMotionScale } from "../../lib/ease";
import { PR_ICONS, PR_TONES } from "../../lib/pr-look";
import { Button, IconButton } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { InlineError } from "../primitives/InlineError";
import { MenuLabel, MenuRow, MenuSeparator, Popover } from "../primitives/Popover";
import { useProjectImages } from "../../lib/project-images";
import { ProjectAvatar } from "../primitives/ProjectAvatar";
import { Select } from "../primitives/Select";
import { SpinnerRing } from "../primitives/SpinnerRing";
import { SweepText } from "../primitives/SweepText";
import Tooltip from "../primitives/Tooltip";
import { ProviderLogo } from "../ProviderLogo";
import { SplitPicker } from "./SplitPicker";

export const COLUMNS: { id: BoardColumn; name: string }[] = [
  { id: "running", name: "Running" },
  { id: "needs", name: "Needs you" },
  { id: "review", name: "In review" },
  { id: "done", name: "Done" },
];

export const TASK_DRAG_TYPE = "application/x-milagre-task";

export type CardEnv = {
  color: string;
  now: number;
  roles: readonly OrchestratorRole[];
  projects: readonly { path: string; name: string }[];
  accountLabels: readonly string[];
  projectName: (path: string | null) => string;
  accountLabel: (id: string | null) => string;
  computerName: (task: OrchestratorTask) => string;
  onMove: (taskId: string, column: BoardColumn) => void;
};

const CARD = "group relative flex w-full shrink-0 flex-col gap-1.5 rounded-card border border-line bg-surface px-3 py-2.5 text-left transition-colors";
const META = "flex min-w-0 items-center gap-1.5 overflow-hidden text-12 whitespace-nowrap text-ink-3";
const BADGE = "rounded-inline bg-field px-1.5 text-10 leading-4 font-medium text-ink-2";

const failed = (card: TaskCard) => card.kind === "failed" || card.state === "failed";

export function StatusMark({ card }: { card: TaskCard }) {
  if (card.column === "running" && (card.kind === "deciding" || card.run)) return <SpinnerRing size={14} />;
  if (card.column === "needs" || failed(card))
    return (
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <span className={`size-2 rounded-full ${failed(card) ? "bg-red" : "bg-orange"}`} />
      </span>
    );
  const mark = card.column === "review" || card.column === "done" ? card.pullRequestMark : null;
  if (mark)
    return (
      <Tooltip label={mark.label} asChild>
        <span className={`flex shrink-0 ${PR_TONES[mark.tone]}`} role="img" aria-label={mark.label} data-pr-mark={mark.icon}>
          <Icon icon={PR_ICONS[mark.icon]} size={14} />
        </span>
      </Tooltip>
    );
  if (card.column === "review" && card.pullRequest === "open")
    return (
      <span className="flex shrink-0 text-green" role="img" aria-label="Pull request open">
        <Icon icon={GitPullRequestIcon} size={14} />
      </span>
    );
  if (card.pullRequest === "merged")
    return (
      <span className="flex shrink-0 text-purple-ink" role="img" aria-label="Pull request merged">
        <Icon icon={GitMergeIcon} size={14} />
      </span>
    );
  return (
    <span className="flex shrink-0 text-ink-3">
      <Icon icon={CheckmarkCircle02Icon} size={14} />
    </span>
  );
}

/** When a card was sent, or on a Done card the time left before the host archives its Chat, as the sidebar's Done list shows it. */
export function CardTime({ card, now }: { card: TaskCard; now: number }) {
  if (!card.countdown) return <>{sinceLabel(card.task.createdAt, now)}</>;
  return (
    <span data-done-countdown title="Time left before it is archived" className="flex items-center gap-1 font-medium tabular-nums">
      <Icon icon={HourglassIcon} size={12} />
      {card.countdown}
    </span>
  );
}

/** The Project's own icon, as the sidebar shows it, with its initial while there is none. */
export function ProjectIcon({ path, name, size = 16, className }: { path: string | null; name: string; size?: 16 | 20 | 24; className?: string }) {
  const image = useProjectImages(path ? [path] : []);
  return <ProjectAvatar name={name || "?"} src={path ? image(path) : null} size={size} className={className} />;
}

export function ProjectLabel({ path, name, size = 16 }: { path: string | null; name: string; size?: 16 | 20 }) {
  return (
    <>
      <ProjectIcon path={path} name={name} size={size} />
      <span className="truncate">{name || path}</span>
    </>
  );
}

type Route = { provider: string | null; model: string | null; effort: string | null };

export function ModelLabel({ route }: { route: Route }) {
  return (
    <>
      {route.provider && <ProviderLogo provider={route.provider as ModelProvider} size={12} />}
      <span className="truncate">{routeLabel(route)}</span>
    </>
  );
}

function CardTitle({ lead, title, images = 0 }: { lead: ReactNode; title: string; images?: number }) {
  return (
    <div className="flex items-start gap-2 pr-7">
      <span className="mt-0.5 flex shrink-0">{lead}</span>
      <span className="min-w-0 text-13 font-medium text-ink">{title}</span>
      {images > 0 && (
        <span
          role="img"
          aria-label={images === 1 ? "1 image" : `${images} images`}
          className="mt-0.5 flex shrink-0 items-center gap-0.5 text-11 leading-4 text-ink-3"
        >
          <Icon icon={Image01Icon} size={12} />
          {images}
        </span>
      )}
    </div>
  );
}

function TaskMenu({
  card,
  anchor,
  point,
  env,
  onClose,
}: {
  card: TaskCard;
  anchor: RefObject<HTMLElement | null>;
  point: { x: number; y: number } | null;
  env: CardEnv;
  onClose: () => void;
}) {
  const { task } = card;
  const pick = (run: () => void) => {
    onClose();
    run();
  };
  return (
    <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <Popover anchor={point ?? anchor} width={220} label="Task" onClose={onClose}>
        <MenuLabel>Move to</MenuLabel>
        {COLUMNS.map((column) => (
          <MenuRow
            key={column.id}
            role="menuitemradio"
            checked={column.id === card.column}
            title={column.name}
            onClick={() => pick(() => column.id !== card.column && env.onMove(task.id, column.id))}
          />
        ))}
        <MenuSeparator />
        <MenuRow
          icon={card.inSidebar ? Undo02Icon : PanelLeftOpenIcon}
          title={card.inSidebar ? "Keep it on the board only" : "Move to the sidebar"}
          onClick={() => pick(() => void showTaskInSidebar(task.id, !card.inSidebar))}
        />
        <MenuRow icon={Delete02Icon} danger title="Delete task" onClick={() => pick(() => void deleteTask(task.id))} />
      </Popover>
    </span>
  );
}

export function ChatCard({ card, env, onOpen }: { card: TaskCard; env: CardEnv; onOpen: (key: string) => void }) {
  const { task } = card;
  const open = () => card.key && onOpen(card.key);
  const role = roleById(env.roles, task.role);
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<null | "button" | { x: number; y: number }>(null);
  return (
    <div
      role="button"
      tabIndex={0}
      data-task-card={task.id}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(TASK_DRAG_TYPE, task.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      onClick={open}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      }}
      className={`${CARD} cursor-pointer hover:border-line-strong`}
    >
      <CardTitle lead={<StatusMark card={card} />} title={task.title} images={task.images} />
      {card.column === "needs" && <span className="self-start rounded-chip bg-orange-tint px-2 py-0.5 text-12 text-orange-ink">{card.detail}</span>}
      {card.column === "running" && card.detail && (
        <span className={`line-clamp-2 min-w-0 text-12 break-words ${failed(card) ? "text-red-ink" : "text-ink-2"}`}>{card.detail}</span>
      )}
      <div className={META}>
        <ProjectLabel path={task.projectPath} name={env.projectName(task.projectPath)} />
        <span className="text-ink-3">·</span>
        <ModelLabel route={task} />
      </div>
      <div className={`${META} justify-between`}>
        <span className="flex min-w-0 items-center gap-1.5">
          {role && <span className={BADGE}>{role.name}</span>}
          {card.inSidebar && <span className={BADGE}>In sidebar</span>}
          <span className={`${BADGE} flex items-center gap-1`}>
            <Icon icon={ComputerIcon} size={12} />
            {env.computerName(task)}
          </span>
        </span>
        <span className="shrink-0 text-11">
          <CardTime card={card} now={env.now} />
        </span>
      </div>
      <span
        className={`absolute top-1.5 right-1.5 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 ${menu ? "opacity-100" : "opacity-0"}`}
      >
        <IconButton
          ref={more}
          size={24}
          label="Move or delete"
          icon={MoreHorizontalIcon}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={(event) => {
            event.stopPropagation();
            setMenu((value) => (value ? null : "button"));
          }}
        />
      </span>
      {menu && <TaskMenu card={card} anchor={more} point={menu === "button" ? null : menu} env={env} onClose={() => setMenu(null)} />}
    </div>
  );
}

export function PickProjectCard({ card, env }: { card: TaskCard; env: CardEnv }) {
  const [error, setError] = useState<string | null>(null);
  const { task } = card;
  return (
    <div data-task-card={task.id} className={CARD}>
      <CardTitle lead={<StatusMark card={card} />} title={task.title} images={task.images} />
      <span className="self-start rounded-chip bg-orange-tint px-2 py-0.5 text-12 text-orange-ink">{card.detail}</span>
      <div className="flex items-center gap-1.5">
        <Select
          label="Project"
          variant="chip"
          align="start"
          width={240}
          value=""
          searchable={env.projects.length > 8}
          options={[{ value: "", label: "Pick a Project" }, ...env.projects.map((project) => ({ value: project.path, label: project.name }))]}
          onChange={(path) => {
            if (!path) return;
            setError(null);
            void pickTaskProject(task.id, path).catch((cause: Error) => setError(cause.message));
          }}
        />
        <span className="flex-1" />
        <Button variant="quiet" size={24} onClick={() => void dismissTask(task.id)}>
          Dismiss
        </Button>
      </div>
      <InlineError size={12}>{error}</InlineError>
    </div>
  );
}

export function FailedCard({ card }: { card: TaskCard }) {
  const { task } = card;
  return (
    <div data-task-card={task.id} className={CARD}>
      <CardTitle lead={<StatusMark card={card} />} title={task.title} images={task.images} />
      <InlineError size={12}>{card.detail}</InlineError>
      <div className="flex items-center gap-1.5">
        <Button variant="secondary" size={24} onClick={() => void rerouteTask(task.id, {})}>
          Re-route
        </Button>
        <span className="flex-1" />
        <Button variant="quiet" size={24} onClick={() => void dismissTask(task.id)}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

function pickedChips(task: OrchestratorTask, env: CardEnv): ReactNode[] | null {
  if (task.state !== "started") return null;
  const account = env.accountLabel(task.accountId);
  return [
    <ProjectLabel key="project" path={task.projectPath} name={env.projectName(task.projectPath)} />,
    <ModelLabel key="model" route={task} />,
    <span key="role">{roleById(env.roles, task.role)?.name ?? task.role}</span>,
    <span key="account" className="truncate">
      {account}
    </span>,
  ];
}

export function DecidingCard({ card, env, hidden, onSettled }: { card: TaskCard; env: CardEnv; hidden: boolean; onSettled: (id: string) => void }) {
  const { task } = card;
  const scale = useMotionScale();
  const chips = pickedChips(task, env);
  const [merged, setMerged] = useState(false);
  const settled = useRef(onSettled);
  settled.current = onSettled;
  return (
    <div data-task-card={task.id} data-deciding className={CARD} style={hidden ? { visibility: "hidden" } : undefined}>
      <span
        key={hidden ? "away" : "home"}
        className="flex flex-col"
        style={scale ? { animation: "pop-in var(--duration-slow) var(--ease-enter) backwards" } : undefined}
      >
        <SplitPicker
          title={task.title}
          chips={chips ?? []}
          picked={chips !== null && !hidden}
          color={env.color}
          onDone={() => {
            setMerged(true);
            window.setTimeout(() => settled.current(task.id), 100 * scale);
          }}
        />
      </span>
      <span className={`${META} justify-between`}>
        <SweepText running className="text-ink-3">
          {merged ? "Starting the Chat…" : "Picking where it runs…"}
        </SweepText>
        <span className="text-11">now</span>
      </span>
    </div>
  );
}
