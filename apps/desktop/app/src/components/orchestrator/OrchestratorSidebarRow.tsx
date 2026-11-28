import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { shortcutCommand, useShortcutLabel } from "../../lib/keybindings";
import { isModalOpen } from "../../lib/modal";
import { focusOrchestratorBox, onOrchestratorFlight, requestTaskOpen, saveOrchestratorSettings } from "../../lib/orchestrator-store";
import { useDismiss } from "../../lib/use-dismiss";
import { cardsIn, type TaskCard } from "../../lib/orchestrator-board";
import { useOrchestratorBoard } from "../../lib/use-orchestrator-board";
import { RenameField } from "../sidebar/RenameField";
import GlideMenu from "../primitives/GlideMenu";
import { SpinnerRing } from "../primitives/SpinnerRing";
import Tooltip from "../primitives/Tooltip";
import { Mascot } from "./Mascot";
import { QuickBox } from "./QuickBox";
import { SendFlight, type Flight } from "./SendFlight";
import { StartedToast } from "./StartedToast";
import { WaitingPanel } from "./WaitingPanel";

const AWAY = { x: 1, y: -0.35 };
const TOWARD_PANEL = { x: 1, y: 0 };
const OPEN_DELAY_MS = 160;
const CLOSE_DELAY_MS = 350;
const MENU_WIDTH = 160;

function RenameMenu({ x, y, onRename, onClose }: { x: number; y: number; onRename: () => void; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    menu.current?.querySelector<HTMLElement>("[data-menu-row]")?.focus();
  }, []);
  useDismiss(true, onClose, (target) => Boolean(menu.current?.contains(target)));
  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label="Orchestrator"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (event.key === "Tab" || event.key.startsWith("Arrow")) event.preventDefault();
      }}
      className="fixed z-[70] rounded-card bg-surface p-1.5 shadow-overlay"
      style={{
        top: Math.min(y, window.innerHeight - 52),
        left: Math.min(x, window.innerWidth - MENU_WIDTH - 8),
        width: MENU_WIDTH,
        animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) backwards",
        transformOrigin: "top left",
      }}
    >
      <GlideMenu className="flex flex-col gap-px" rowSelector="[data-menu-row]:not(:disabled)" highlightClassName="inset-x-0 rounded-control bg-hover-2">
        <button
          data-menu-row
          role="menuitem"
          type="button"
          onClick={onRename}
          className="relative z-10 flex h-8 w-full items-center rounded-control px-2 text-left text-13 text-ink outline-none focus-visible:bg-hover-2"
        >
          Rename
        </button>
      </GlideMenu>
    </div>,
    document.body,
  );
}

export function OrchestratorSidebarRow({ active, onShow }: { active: boolean; onShow: () => void }) {
  const { orchestrator, cards, counts, names, env } = useOrchestratorBoard();
  const { settings } = orchestrator;
  const [quick, setQuick] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [flight, setFlight] = useState<Flight | null>(null);
  const rowMascot = useRef<HTMLSpanElement>(null);
  const row = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef(0);
  const [waitingAt, setWaitingAt] = useState<DOMRect | null>(null);
  const waiting = counts.needs > 0;
  const hold = () => window.clearTimeout(timer.current);
  const openWaiting = () => {
    hold();
    if (!waiting || waitingAt) return;
    timer.current = window.setTimeout(() => {
      const box = row.current?.closest("[data-sidebar-collapsed]")?.getBoundingClientRect();
      const at = row.current?.getBoundingClientRect();
      if (at) setWaitingAt(new DOMRect(at.x, at.y, (box?.right ?? at.right) - at.x, at.height));
    }, OPEN_DELAY_MS);
  };
  const closeWaiting = () => {
    hold();
    timer.current = window.setTimeout(() => {
      if (!panel.current?.contains(document.activeElement)) setWaitingAt(null);
    }, CLOSE_DELAY_MS);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useDismiss(
    Boolean(waitingAt),
    () => setWaitingAt(null),
    (target) => Boolean(panel.current?.contains(target) || row.current?.contains(target)),
  );
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
  useEffect(
    () =>
      onOrchestratorFlight((request) => {
        const home = rowMascot.current?.getBoundingClientRect();
        if (home) setFlight({ ...request, bot: home, rest: home });
      }),
    [],
  );
  if (!settings.enabled) return null;
  const openTask = (key: string) => {
    onShow();
    requestTaskOpen(key);
  };
  const needs = cardsIn(cards, "needs");
  const openCard = (card: TaskCard) => {
    setWaitingAt(null);
    if (card.key) openTask(card.key);
    else {
      requestTaskOpen(null);
      onShow();
    }
  };
  const label = (
    <span className="sidebar-copy min-w-0 flex-1 truncate text-[length:calc(13px+var(--sidebar-delta))] font-semibold text-ink in-data-[sidebar-collapsed=true]:hidden">
      {settings.name}
    </span>
  );
  return (
    <div className="shrink-0 border-b border-line px-1.5 py-1.5">
      {renaming ? (
        <div className="flex h-8 w-full items-center gap-2 rounded-control bg-hover-2 px-2">
          <Mascot size={20} color={settings.mascotColor} look={AWAY} />
          <RenameField
            initial={settings.name}
            onDone={(title) => {
              setRenaming(false);
              if (title && title !== settings.name) void saveOrchestratorSettings({ name: title });
            }}
          />
        </div>
      ) : (
        <Tooltip label={settings.name} shortcut={shortcut} side="bottom" className="w-full">
          <button
            ref={row}
            type="button"
            data-orchestrator-row
            aria-current={active ? "page" : undefined}
            onClick={() => {
              requestTaskOpen(null);
              onShow();
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY });
            }}
            onPointerEnter={() => {
              setHovered(true);
              openWaiting();
            }}
            onPointerLeave={() => {
              setHovered(false);
              closeWaiting();
            }}
            className={`flex h-8 w-full items-center gap-2 rounded-control px-2 text-left transition-colors active:bg-hover-2 ${active ? "bg-hover-2" : "hover:bg-hover"}`}
          >
            <span ref={rowMascot} className="relative flex" style={{ opacity: flight ? 0 : 1 }}>
              <span className={`flex ${waiting && !waitingAt ? "orchestrator-asking" : ""}`}>
                <Mascot size={20} color={settings.mascotColor} look={waiting ? TOWARD_PANEL : hovered ? null : AWAY} followPointer={hovered && !waiting} />
              </span>
              {waiting && (
                <span
                  aria-hidden
                  data-orchestrator-bubble
                  className={`absolute -top-2.5 left-3 transition-[opacity,scale] duration-fast ${waitingAt ? "scale-50 opacity-0" : ""}`}
                >
                  <span className="orchestrator-bubble flex h-3.5 min-w-3.5 items-center justify-center rounded-[7px_7px_7px_2px] bg-orange px-[3px] text-[9px] font-bold text-on-orange tabular-nums ring-2 ring-page">
                    {counts.needs > 1 ? counts.needs : "?"}
                  </span>
                </span>
              )}
            </span>
            {label}
            {counts.running > 0 && (
              <span
                aria-label={`${counts.running} running`}
                className="flex items-center gap-1 text-11 text-ink-3 tabular-nums in-data-[sidebar-collapsed=true]:hidden"
              >
                <SpinnerRing size={12} />
                {counts.running}
              </span>
            )}
            {waiting && (
              <span
                aria-label={`${counts.needs} need you`}
                className="flex h-5 items-center rounded-full bg-orange-tint px-1.5 text-11 font-semibold text-orange-ink tabular-nums in-data-[sidebar-collapsed=true]:hidden"
              >
                {counts.needs === 1 ? "Needs you" : `${counts.needs} waiting`}
              </span>
            )}
          </button>
        </Tooltip>
      )}
      {menu && (
        <RenameMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onRename={() => {
            setMenu(null);
            setRenaming(true);
          }}
        />
      )}
      {quick && (
        <QuickBox
          name={settings.name}
          onClose={() => setQuick(false)}
          onSent={(task, from, pebble) => {
            if (pebble) setFlight({ id: task.id, text: task.prompt, from, bot: pebble, rest: rowMascot.current?.getBoundingClientRect() });
          }}
        />
      )}
      {waitingAt && (
        <WaitingPanel
          ref={panel}
          cards={needs}
          projects={env.projects}
          projectName={names.projectName}
          anchor={waitingAt}
          onOpen={openCard}
          onClose={() => setWaitingAt(null)}
          onPointerEnter={hold}
          onPointerLeave={closeWaiting}
        />
      )}
      {flight && <SendFlight key={flight.id} flight={flight} color={settings.mascotColor} onLand={() => {}} onDone={() => setFlight(null)} />}
      <StartedToast tasks={orchestrator.tasks} color={settings.mascotColor} projectName={names.projectName} onOpen={openTask} />
    </div>
  );
}
