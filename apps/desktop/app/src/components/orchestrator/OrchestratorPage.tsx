import { useEffect, useRef, useState } from "react";
import { KanbanIcon } from "@hugeicons/core-free-icons";
import type { OrchestratorTask } from "@milagre/shared/orchestrator";
import { followTask, followedTask, requestTaskOpen, saveOrchestratorSettings, useOrchestratorNav } from "../../lib/orchestrator-store";
import { gazeToward } from "../../lib/orchestrator-board";
import { useOrchestratorBoard } from "../../lib/use-orchestrator-board";
import { useMotionScale } from "../../lib/ease";
import { useControlsClearance } from "../../lib/window-chrome";
import { IconButton } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { FirstRunTour } from "./FirstRunTour";
import { Mascot, type Look, type MascotMood } from "./Mascot";
import { OrchestratorBoard } from "./OrchestratorBoard";
import { OrchestratorBox } from "./OrchestratorBox";
import { OrchestratorTaskList } from "./OrchestratorTaskList";
import { SendFlight, type Flight } from "./SendFlight";

const WATCHING_CARD: Look = { x: -0.35, y: 1 };

export function OrchestratorPage({
  pane,
  onOpen: onOpenTask,
  onBack: onClosePane,
}: {
  pane: string | null;
  onOpen: (key: string) => void;
  onBack: () => void;
}) {
  const { orchestrator, cards, env, names } = useOrchestratorBoard();
  const { settings } = orchestrator;
  const { pendingOpen, boxFocus } = useOrchestratorNav();
  const scale = useMotionScale();
  const home = useRef<HTMLSpanElement>(null);
  const [typingLook, setTypingLook] = useState<Look>(null);
  const [flight, setFlight] = useState<(Flight & { landed: boolean }) | null>(null);
  const [mood, setMood] = useState<MascotMood>("idle");
  const empty = cards.length === 0 && !flight;
  const collapsed = settings.boardHidden || empty;
  const clearance = useControlsClearance<HTMLDivElement>(true);

  const followedKey = cards.find((card) => card.task.id === followedTask() && card.key)?.key ?? null;
  useEffect(() => {
    if (!followedKey) return;
    followTask(null);
    requestTaskOpen(followedKey);
  }, [followedKey]);

  useEffect(() => {
    if (!pendingOpen) return;
    const timer = window.setTimeout(() => {
      requestTaskOpen(null);
      onOpenTask(pendingOpen);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pendingOpen, onOpenTask]);

  useEffect(() => {
    if (mood !== "happy" || flight) return;
    const timer = window.setTimeout(() => setMood("idle"), 900 * scale);
    return () => window.clearTimeout(timer);
  }, [mood, flight, scale]);

  if (!settings.enabled)
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState size="page" title="The Orchestrator is off.">
          Turn it on in Settings › Church › Orchestrator. Your tasks stay where they were.
        </EmptyState>
      </div>
    );
  if (!settings.tourDone) return <FirstRunTour memory={orchestrator.memory} settings={settings} project={names.projects[0]?.name ?? "Your Project"} />;
  if (pane)
    return (
      <OrchestratorTaskList
        cards={cards}
        env={env}
        openKey={pane}
        onOpen={onOpenTask}
        onBoard={() => {
          onClosePane();
          requestTaskOpen(null);
        }}
      />
    );

  const sent = (task: OrchestratorTask, from: DOMRect) => {
    const bot = home.current?.getBoundingClientRect();
    if (!bot || scale === 0) return;
    setMood("happy");
    setFlight({ id: task.id, text: task.prompt, from, bot, landed: false });
  };
  const deciding = cards.some((card) => card.kind === "deciding" && card.task.id !== flight?.id);
  const look = deciding && !typingLook ? WATCHING_CARD : typingLook;
  return (
    <div data-orchestrator-page className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={clearance.bar}
        style={{ paddingLeft: clearance.inset.paddingLeft + 12, paddingRight: clearance.inset.paddingRight }}
        className="flex h-[var(--window-chrome-height)] shrink-0 items-center gap-2"
      >
        <h1 className="text-13 font-semibold text-ink">{orchestrator.settings.name}</h1>
        <span className="text-13 text-ink-3">
          {names.projects.length} {names.projects.length === 1 ? "Project" : "Projects"}
        </span>
        <span className="flex-1" />
        {!empty && (
          <IconButton
            size={32}
            label={collapsed ? "Show the board" : "Hide the board"}
            icon={KanbanIcon}
            side="bottom"
            aria-pressed={!collapsed}
            className="no-drag z-[60]"
            onClick={() => void saveOrchestratorSettings({ boardHidden: !collapsed })}
          />
        )}
      </div>
      <div className={`flex flex-col items-center gap-3.5 px-6 ${collapsed ? "flex-1 justify-center pb-24" : "pt-5 pb-4"}`}>
        <div className="flex w-full max-w-[720px] items-center gap-3">
          <span ref={home} className="flex" style={{ opacity: flight ? 0 : 1 }}>
            <Mascot size={44} color={settings.mascotColor} mood={mood} look={look} followPointer />
          </span>
          <h2 className="text-22 font-semibold tracking-[-0.02em] text-ink">What should we work on?</h2>
        </div>
        <div className="w-full max-w-[720px]">
          <OrchestratorBox
            size="large"
            onSent={sent}
            onCaret={(caret) => setTypingLook(caret && home.current ? gazeToward(home.current.getBoundingClientRect(), caret) : null)}
            focusSignal={boxFocus}
            autoFocus
          />
        </div>
      </div>
      {!collapsed && <OrchestratorBoard cards={cards} env={env} hiddenTask={flight && !flight.landed ? flight.id : null} onOpen={onOpenTask} />}
      {flight && (
        <SendFlight
          key={flight.id}
          flight={flight}
          color={settings.mascotColor}
          onLand={() => setFlight((current) => (current ? { ...current, landed: true } : current))}
          onDone={() => setFlight(null)}
        />
      )}
    </div>
  );
}
