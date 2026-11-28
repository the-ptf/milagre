import { useEffect, useEffectEvent, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import {
  Alert02Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  BubbleChatQuestionIcon,
  Folder01Icon,
  ShieldAlertIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { asksInComposer } from "@milagre/shared/question-composer";
import type { QuestionRequest } from "../../model";
import { bridgeForKey } from "../../lib/computer-bridge";
import type { TaskCard } from "../../lib/orchestrator-board";
import { dismissTask, pickTaskProject, rerouteTask } from "../../lib/orchestrator-store";
import { answerSummary } from "../../lib/question-answers";
import { CompactQuestionComposer } from "../agents/ComposerQuestion";
import { PermissionCard } from "../agents/PermissionCard";
import { Button, IconButton } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { InlineError } from "../primitives/InlineError";
import { ShortcutKeys } from "../primitives/ShortcutKeys";

const CAUGHT_UP_MS = 1100;

type Projects = readonly { path: string; name: string }[];
type Act = (run: () => Promise<unknown>) => void;

const sentId = (card: TaskCard) => `${card.task.id}:${card.ask ? card.ask.request.requestId : card.kind}`;

function kindIcon(card: TaskCard): IconSvgElement {
  if (card.kind === "pick-project") return Folder01Icon;
  if (card.ask?.kind === "approval") return ShieldAlertIcon;
  if (card.ask?.kind === "question") return BubbleChatQuestionIcon;
  return Alert02Icon;
}

function projectQuestion(card: TaskCard, projects: Projects): QuestionRequest {
  return {
    requestId: `project:${card.task.id}`,
    questions: [
      {
        id: "project",
        header: "Project",
        question: card.detail,
        options: projects.map((project) => ({ label: project.name })),
        multiSelect: false,
        allowOther: false,
        secret: false,
      },
    ],
  };
}

function CardBody({ card, projects, busy, act }: { card: TaskCard; projects: Projects; busy: boolean; act: Act }) {
  const { task, key, ask } = card;
  if (card.kind === "pick-project")
    return (
      <CompactQuestionComposer
        busy={busy}
        question={{
          request: projectQuestion(card, projects),
          waiting: 0,
          onAnswer: (answers) => {
            const project = projects.find((item) => item.name === answers?.project?.[0]);
            act(() => (project ? pickTaskProject(task.id, project.path) : dismissTask(task.id)));
          },
        }}
      />
    );
  if (card.kind === "failed")
    return (
      <>
        <InlineError size={12}>{card.detail}</InlineError>
        <div className="flex items-center gap-1.5">
          <Button variant="secondary" size={24} disabled={busy} onClick={() => act(() => rerouteTask(task.id, {}))}>
            Re-route
          </Button>
          <span className="flex-1" />
          <Button variant="quiet" size={24} disabled={busy} onClick={() => act(() => dismissTask(task.id))}>
            Dismiss
          </Button>
        </div>
      </>
    );
  if (key && ask?.kind === "question" && asksInComposer(ask.request))
    return (
      <CompactQuestionComposer
        key={ask.request.requestId}
        busy={busy}
        question={{
          request: ask.request,
          waiting: 0,
          onAnswer: (answers, images) =>
            act(() =>
              bridgeForKey(key).answerQuestion(
                key,
                ask.request.requestId,
                answers,
                answers ? answerSummary(ask.request.questions, answers, images) : undefined,
                answers ? images : undefined,
              ),
            ),
        }}
      />
    );
  if (key && ask?.kind === "approval")
    return (
      <PermissionCard
        variant="inline"
        request={ask.request}
        waiting={0}
        answering={busy ? "allow" : null}
        onAnswer={(decision) => act(() => bridgeForKey(key).respondToPermission(key, ask.request.requestId, decision))}
      />
    );
  return <p className="text-13 text-ink-2">{card.detail}</p>;
}

const editable = (target: EventTarget | null) => target instanceof HTMLElement && Boolean(target.closest("input, textarea, [contenteditable=true]"));

/** Beside the Orchestrator row: every task that needs the user, one at a time, answered with the composer's own question card. */
export function WaitingPanel({
  cards,
  projects,
  projectName,
  anchor,
  ref,
  onOpen,
  onClose,
  onPointerEnter,
  onPointerLeave,
}: {
  cards: readonly TaskCard[];
  projects: Projects;
  projectName: (path: string | null) => string;
  anchor: DOMRect;
  ref: Ref<HTMLDivElement>;
  onOpen: (card: TaskCard) => void;
  onClose: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const [sent, setSent] = useState<ReadonlySet<string>>(() => new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [step, setStep] = useState(0);
  const pending = useRef(false);
  const panel = useRef<HTMLDivElement | null>(null);
  const shown = cards.filter((card) => !sent.has(sentId(card)));
  const at = Math.max(
    0,
    shown.findIndex((entry) => entry.task.id === focus),
  );
  const card = shown[at];
  const close = useEffectEvent(() => onClose());
  useEffect(() => {
    if (card) return;
    const timer = window.setTimeout(close, CAUGHT_UP_MS);
    return () => window.clearTimeout(timer);
  }, [card]);
  const move = (by: number) => {
    if (shown.length < 2) return;
    setFocus(shown[(at + by + shown.length) % shown.length]?.task.id ?? null);
    setStep(by);
    setError("");
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      const inside = event.target instanceof Node && Boolean(panel.current?.contains(event.target));
      if (editable(event.target) && !inside) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && !editable(event.target)) {
        event.preventDefault();
        move(event.key === "ArrowRight" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const send = async (id: string, next: string | null, run: () => Promise<unknown>) => {
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if ((await run()) === false) throw new Error("This is no longer waiting.");
      setSent((previous) => new Set(previous).add(id));
      setFocus(next);
      setStep(1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't send your answer.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const act: Act = (run) => {
    if (pending.current || !card) return;
    const rest = shown.filter((entry) => entry !== card);
    void send(sentId(card), rest[Math.min(at, rest.length - 1)]?.task.id ?? null, run);
  };
  return createPortal(
    <div
      ref={(node) => {
        panel.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      role="dialog"
      aria-label="Waiting on you"
      data-orchestrator-waiting
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className="no-drag fixed z-[60] w-[360px] text-ink"
      style={{
        top: Math.max(8, Math.min(anchor.top - 6, window.innerHeight - 240)),
        left: anchor.right + 8,
        transformOrigin: "top left",
        animation: "pop-in var(--duration-base) var(--ease-enter) backwards",
      }}
    >
      <div className="overflow-hidden rounded-card bg-surface p-3 shadow-overlay">
        {card ? (
          <div
            key={`${sentId(card)}:${at}`}
            className="grid grid-cols-[minmax(0,1fr)] gap-2.5"
            style={{ animation: `${step < 0 ? "waiting-in-back" : "waiting-in"} var(--duration-base) var(--ease-enter) backwards` }}
          >
            <div className="flex h-5 items-center gap-1.5 text-12 text-ink-3">
              <span className={`flex ${card.kind === "failed" || card.state === "failed" ? "text-red" : "text-orange"}`}>
                <Icon icon={kindIcon(card)} size={14} />
              </span>
              <span className="min-w-0 flex-1 truncate font-semibold text-ink-2">{card.task.title}</span>
              {shown.length > 1 && (
                <>
                  <span className="tabular-nums">
                    {at + 1} of {shown.length}
                  </span>
                  <IconButton label="Previous" icon={ArrowLeft01Icon} size={20} variant="ghost" tooltip={false} onClick={() => move(-1)} />
                  <IconButton label="Next" icon={ArrowRight01Icon} size={20} variant="ghost" tooltip={false} onClick={() => move(1)} />
                </>
              )}
            </div>
            <CardBody card={card} projects={projects} busy={busy} act={act} />
            <InlineError size={12}>{error}</InlineError>
            <div className="flex items-center justify-between gap-2 text-12">
              <span className="min-w-0 truncate text-ink-3">{card.task.projectPath ? projectName(card.task.projectPath) : "No Project yet"}</span>
              {card.key && (
                <button
                  type="button"
                  onClick={() => onOpen(card)}
                  className="flex shrink-0 items-center gap-0.5 rounded-control text-accent-ink hover:underline"
                >
                  Open task Chat
                  <Icon icon={ArrowUpRight01Icon} size={12} />
                </button>
              )}
            </div>
          </div>
        ) : (
          <p className="py-1 text-13 text-ink">All caught up.</p>
        )}
      </div>
      {card && (
        <div className="mt-2 flex justify-center gap-4 text-11 text-ink-2">
          {shown.length > 1 && (
            <span className="flex items-center gap-1">
              <ShortcutKeys shortcut="←" /> <ShortcutKeys shortcut="→" /> move
            </span>
          )}
          <span className="flex items-center gap-1">
            <ShortcutKeys shortcut="Esc" /> close
          </span>
        </div>
      )}
    </div>,
    document.body,
  );
}
