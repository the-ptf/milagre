import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CheckmarkCircle02Icon, GitPullRequestIcon, PanelLeftOpenIcon, Undo02Icon } from "@hugeicons/core-free-icons";
import { roleById, type OrchestratorRole, type OrchestratorTask } from "@milagre/shared/orchestrator";
import type { ModelProvider } from "../../model";
import { sinceLabel, type TaskCard } from "../../lib/orchestrator-board";
import { routeLabel } from "../../lib/orchestrator-names";
import { dismissTask, pickTaskProject, rerouteTask, showTaskInSidebar } from "../../lib/orchestrator-store";
import { useMotionScale } from "../../lib/ease";
import { Button, IconButton } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { InlineError } from "../primitives/InlineError";
import { ProjectAvatar } from "../primitives/ProjectAvatar";
import { Select } from "../primitives/Select";
import { SpinnerRing } from "../primitives/SpinnerRing";
import { SweepText } from "../primitives/SweepText";
import { ProviderLogo } from "../ProviderLogo";
import { lookToward, Mascot, type Look } from "./Mascot";
import { Reel, type ReelItem, type ReelPhase } from "./Reel";

export type CardEnv = {
  color: string;
  now: number;
  roles: readonly OrchestratorRole[];
  projects: readonly { path: string; name: string }[];
  accountLabels: readonly string[];
  projectName: (path: string | null) => string;
  accountLabel: (id: string | null) => string;
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
  if (card.column === "review")
    return (
      <span className="flex shrink-0 text-green">
        <Icon icon={GitPullRequestIcon} size={14} />
      </span>
    );
  return (
    <span className="flex shrink-0 text-ink-3">
      <Icon icon={CheckmarkCircle02Icon} size={14} />
    </span>
  );
}

export function ProjectLabel({ path, name, size = 16 }: { path: string | null; name: string; size?: 16 | 20 }) {
  return (
    <>
      <ProjectAvatar name={name || "?"} size={size} />
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

function CardTitle({ lead, title }: { lead: ReactNode; title: string }) {
  return (
    <div className="flex items-start gap-2 pr-7">
      <span className="mt-0.5 flex shrink-0">{lead}</span>
      <span className="min-w-0 text-13 font-medium text-ink">{title}</span>
    </div>
  );
}

export function ChatCard({ card, env, onOpen }: { card: TaskCard; env: CardEnv; onOpen: (key: string) => void }) {
  const { task } = card;
  const open = () => card.key && onOpen(card.key);
  const role = roleById(env.roles, task.role);
  return (
    <div
      role="button"
      tabIndex={0}
      data-task-card={task.id}
      onClick={open}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      }}
      className={`${CARD} cursor-pointer hover:border-line-strong`}
    >
      <CardTitle lead={<StatusMark card={card} />} title={task.title} />
      {card.column === "needs" && <span className="self-start rounded-chip bg-orange-tint px-2 py-0.5 text-12 text-orange-ink">{card.detail}</span>}
      {card.column === "running" && card.detail && <span className={`${META} ${failed(card) ? "text-red-ink" : "text-ink-2"}`}>{card.detail}</span>}
      <div className={META}>
        <ProjectLabel path={task.projectPath} name={env.projectName(task.projectPath)} />
        <span className="text-ink-3">·</span>
        <ModelLabel route={task} />
      </div>
      <div className={`${META} justify-between`}>
        <span className="flex min-w-0 items-center gap-1.5">
          {role && <span className={BADGE}>{role.name}</span>}
          {card.inSidebar && <span className={BADGE}>In sidebar</span>}
          {task.computer && <span className={BADGE}>On {task.computer}</span>}
        </span>
        <span className="text-11">{sinceLabel(task.createdAt, env.now)}</span>
      </div>
      <span className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <IconButton
          size={24}
          label={card.inSidebar ? "Keep it on the board only" : "Move to the sidebar"}
          icon={card.inSidebar ? Undo02Icon : PanelLeftOpenIcon}
          onClick={(event) => {
            event.stopPropagation();
            void showTaskInSidebar(task.id, !card.inSidebar);
          }}
        />
      </span>
    </div>
  );
}

export function PickProjectCard({ card, env }: { card: TaskCard; env: CardEnv }) {
  const [error, setError] = useState<string | null>(null);
  const { task } = card;
  return (
    <div data-task-card={task.id} className={CARD}>
      <CardTitle lead={<StatusMark card={card} />} title={task.title} />
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
      <CardTitle lead={<StatusMark card={card} />} title={task.title} />
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

function reelItems(env: CardEnv) {
  const projects: ReelItem[] = env.projects.map((project) => ({ key: project.path, node: <ProjectLabel path={project.path} name={project.name} /> }));
  const roles: ReelItem[] = env.roles.filter((role) => role.model).map((role) => ({ key: role.id, node: role.name }));
  const models: ReelItem[] = env.roles.filter((role) => role.model).map((role) => ({ key: `${role.id}:${role.model}`, node: <ModelLabel route={role} /> }));
  const accounts: ReelItem[] = env.accountLabels.map((label) => ({ key: label, node: <span className="truncate">{label}</span> }));
  return { projects, roles, models, accounts };
}

function finals(task: OrchestratorTask, env: CardEnv): ReelItem[] | null {
  if (task.state !== "started") return null;
  return [
    { key: task.projectPath ?? "", node: <ProjectLabel path={task.projectPath} name={env.projectName(task.projectPath)} /> },
    { key: task.role, node: roleById(env.roles, task.role)?.name ?? task.role },
    { key: `${task.role}:${task.model}`, node: <ModelLabel route={task} /> },
    { key: env.accountLabel(task.accountId), node: <span className="truncate">{env.accountLabel(task.accountId)}</span> },
  ];
}

export function DecidingCard({ card, env, hidden, onSettled }: { card: TaskCard; env: CardEnv; hidden: boolean; onSettled: (id: string) => void }) {
  const { task } = card;
  const scale = useMotionScale();
  const picked = finals(task, env);
  const [step, setStep] = useState(-1);
  const [look, setLook] = useState<Look>(null);
  const mascot = useRef<HTMLSpanElement>(null);
  const reels = useRef<(HTMLSpanElement | null)[]>([]);
  const items = useState(() => reelItems(env))[0];
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const isPicked = picked !== null;
  useEffect(() => {
    if (isPicked && step < 0 && !hidden) setStep(0);
  }, [isPicked, step, hidden]);
  useEffect(() => {
    if (step < 4) return;
    const timer = window.setTimeout(() => settled.current(task.id), 500 * scale);
    return () => window.clearTimeout(timer);
  }, [step, scale, task.id]);
  useLayoutEffect(() => {
    const target = reels.current[Math.max(0, step)];
    setLook(step >= 4 ? null : lookToward(mascot.current, target ?? null));
  }, [step, hidden]);
  const phase = (index: number): ReelPhase => {
    if (!picked) return index === 0 && !hidden ? "spin" : "wait";
    return step === index ? "land" : step > index ? "done" : "wait";
  };
  const reel = (index: number, list: ReelItem[], badge = false) => (
    <Reel
      ref={(node) => {
        reels.current[index] = node;
      }}
      items={list}
      final={picked?.[index] ?? null}
      phase={phase(index)}
      badge={badge}
      onLanded={() => window.setTimeout(() => setStep((current) => (current === index ? index + 1 : current)), 160 * scale)}
    />
  );
  return (
    <div data-task-card={task.id} data-deciding className={CARD} style={hidden ? { visibility: "hidden" } : undefined}>
      <CardTitle
        lead={
          <span
            ref={mascot}
            key={hidden ? "away" : "home"}
            className="-mt-0.5 flex"
            style={scale ? { animation: "pop-in var(--duration-slow) var(--ease-enter) backwards" } : undefined}
          >
            <Mascot size={20} color={env.color} mood={step >= 4 ? "happy" : "thinking"} look={look} />
          </span>
        }
        title={task.title}
      />
      <span className={META}>
        <SweepText running className="text-ink-3">
          {step >= 4 ? "Starting the Chat…" : "Picking the Project, model and account…"}
        </SweepText>
      </span>
      <div className={META}>
        {reel(0, items.projects)}
        <span className="text-ink-3">·</span>
        {reel(2, items.models)}
      </div>
      <div className={`${META} justify-between`}>
        <span className="flex min-w-0 items-center gap-1.5">
          {reel(1, items.roles, true)}
          {reel(3, items.accounts)}
        </span>
        <span className="text-11">now</span>
      </div>
    </div>
  );
}
