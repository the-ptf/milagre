import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";
import { GitMergeIcon, MinusSignIcon, SquareArrowUpRightIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { MEMORY_GROUPS, isMemoryImporting, type OrchestratorMemory, type OrchestratorSettings } from "@milagre/shared/orchestrator";
import { useMotionScale } from "../../lib/ease";
import { AUTOPILOT_TITLES, GROUP_TITLES } from "../../lib/orchestrator-names";
import { importMemory, saveMemoryNotes, saveOrchestratorSettings } from "../../lib/orchestrator-store";
import { Button } from "../primitives/Button";
import { Checkbox } from "../primitives/Checkbox";
import { Icon } from "../primitives/Icon";
import { InlineError } from "../primitives/InlineError";
import { ScrollArea } from "../primitives/ScrollArea";
import { SectionLabel } from "../primitives/SectionLabel";
import { SpinnerRing } from "../primitives/SpinnerRing";
import { Mascot } from "./Mascot";
import { Reel, type ReelItem, type ReelPhase } from "./Reel";

const DEMO = "the sign-in button does nothing on Safari, fix it";
const AGENTS = ["Claude Code", "Codex", "Antigravity", "Kiro"];
const SUMMARY_AT = 15_200;
const item = (label: string): ReelItem => ({ key: label, node: label });
const sourceCount = ({ count, unit }: { count: number; unit: "notes" | "rules" }) => `${count} ${count === 1 ? unit.slice(0, -1) : unit}`;

function Sources({ memory, reading }: { memory: OrchestratorMemory; reading: boolean }) {
  const names = [...new Set([...AGENTS, ...memory.sources.map((source) => source.name)])];
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {names.map((name) => {
        const source = memory.sources.find((entry) => entry.name === name);
        return (
          <span key={name} data-memory-source={name} className="flex h-7 items-center gap-1.5 rounded-full bg-surface px-2.5 text-12 text-ink-2 shadow-btn">
            {source ? (
              <span className={source.found ? "flex text-green-ink" : "flex text-ink-3"}>
                <Icon icon={source.found ? Tick02Icon : MinusSignIcon} size={14} />
              </span>
            ) : reading ? (
              <SpinnerRing size={14} />
            ) : (
              <span className="flex text-ink-3">
                <Icon icon={MinusSignIcon} size={14} />
              </span>
            )}
            <span className={source?.found ? "text-ink" : ""}>{name}</span>
            {source && <span className="text-ink-3">· {source.found ? sourceCount(source) : "nothing found"}</span>}
          </span>
        );
      })}
    </div>
  );
}

function Summary({ memory, settings, error, color }: { memory: OrchestratorMemory; settings: OrchestratorSettings; error: string | null; color: string }) {
  const [off, setOff] = useState<ReadonlySet<string>>(() => new Set(memory.notes.filter((note) => !note.enabled).map((note) => note.id)));
  const [saving, setSaving] = useState(false);
  const start = async () => {
    setSaving(true);
    try {
      await saveMemoryNotes(memory.notes.map((note) => ({ ...note, enabled: !off.has(note.id) })));
    } finally {
      await saveOrchestratorSettings({ tourDone: true });
    }
  };
  return (
    <ScrollArea className="h-full">
      <div
        data-tour-summary
        className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-6 pt-14 pb-10"
        style={{ animation: "fade-up var(--duration-slow) var(--ease-enter) backwards" }}
      >
        <div className="flex items-center gap-3.5">
          <Mascot size={56} color={color} mood="happy" followPointer />
          <div className="grid gap-0.5">
            <h1 className="text-22 font-semibold tracking-[-0.02em] text-ink">Here's what I already know about you</h1>
            <p className="text-13 text-ink-2">Read on this computer from your agents' instructions and memories. Untick anything I shouldn't keep.</p>
          </div>
        </div>
        <Sources memory={memory} reading={false} />
        <InlineError size={12}>{error}</InlineError>
        {memory.notes.length === 0 && (
          <p className="rounded-card border border-line bg-surface px-4 py-3 text-13 text-ink-2">
            I didn't find any notes from your agents on this computer. I'll learn from how you correct me.
          </p>
        )}
        {MEMORY_GROUPS.map((group) => {
          const notes = memory.notes.filter((note) => note.group === group);
          if (!notes.length) return null;
          return (
            <section key={group}>
              <SectionLabel className="px-1 pb-1.5">{GROUP_TITLES[group]}</SectionLabel>
              <div className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
                {notes.map((note) => (
                  <label key={note.id} className="flex min-h-10 cursor-pointer items-center gap-2.5 px-3.5 py-1.5 transition-colors hover:bg-hover">
                    <Checkbox
                      checked={!off.has(note.id)}
                      onCheckedChange={(on) =>
                        setOff((previous) => {
                          const next = new Set(previous);
                          if (on) next.delete(note.id);
                          else next.add(note.id);
                          return next;
                        })
                      }
                    />
                    <span className={`min-w-0 flex-1 text-13 ${off.has(note.id) ? "text-ink-3" : "text-ink"}`}>{note.text}</span>
                    <span className="shrink-0 text-11 text-ink-3">{note.source}</span>
                  </label>
                ))}
              </div>
            </section>
          );
        })}
        <div className="flex items-center gap-2 pt-1">
          <span className="flex-1 text-12 text-ink-3">
            Autopilot starts on {AUTOPILOT_TITLES[settings.autopilot]}. I'll learn the rest from how you correct me.
          </span>
          <Button disabled={saving} onClick={() => void start()}>
            Start
          </Button>
        </div>
      </div>
    </ScrollArea>
  );
}

function DemoCard({ t, color, project }: { t: number; color: string; project: string }) {
  const step = t < 7500 ? -1 : t < 8400 ? 0 : t < 9300 ? 1 : t < 10200 ? 2 : 3;
  const phase = (index: number): ReelPhase => (step < 0 ? (index === 0 ? "spin" : "wait") : step === index ? "land" : step > index ? "done" : "wait");
  const reel = (index: number, items: string[]) => <Reel items={items.map(item)} final={item(items[0]!)} phase={phase(index)} />;
  return (
    <div
      className="flex w-60 flex-col gap-1.5 rounded-card border border-line bg-surface px-3 py-2.5"
      style={{ animation: "pop-in var(--duration-base) var(--ease-enter) backwards" }}
    >
      <div className="flex items-start gap-2">
        <Mascot size={20} color={color} mood={step < 3 ? "thinking" : "happy"} look={step < 3 ? { x: 0.3, y: 1 } : null} />
        <span className="text-13 font-medium text-ink">Sign-in button on Safari</span>
      </div>
      <div className="flex items-center gap-1.5 overflow-hidden text-12 whitespace-nowrap text-ink-3">
        <span className="truncate">{project}</span>
        <span>·</span>
        {reel(0, ["Opus 5.5 · High", "GPT 6.1 Sol", "Sonnet 5.5"])}
      </div>
      <div className="flex items-center gap-1.5 overflow-hidden text-12 whitespace-nowrap text-ink-3">
        {reel(1, ["Least used account", "Your team account"])}
        <span>·</span>
        {reel(2, ["This computer", "Your other computer"])}
      </div>
    </div>
  );
}

function Bubbles({ t }: { t: number }) {
  if (t < 10_400) return null;
  return (
    <div className="flex w-60 flex-col gap-2">
      <div
        className="flex flex-col gap-1.5 rounded-card border border-line-strong bg-surface px-2.5 py-2 text-12"
        style={{ animation: "fade-up var(--duration-slow) var(--ease-enter) backwards" }}
      >
        <span className="flex items-center gap-1.5 text-ink">
          <Icon icon={SquareArrowUpRightIcon} size={14} />
          Run <code className="rounded-inline bg-field px-1 font-mono">npm test</code>?
        </span>
        {t < 11_600 ? (
          <span className="text-ink-3">Waiting…</span>
        ) : (
          <span className="flex items-center gap-1.5 text-green-ink">
            <Icon icon={Tick02Icon} size={14} />
            Answered for you: Allow
          </span>
        )}
      </div>
      {t >= 12_600 && (
        <div
          className="flex flex-col gap-1.5 rounded-card border border-line-strong bg-surface px-2.5 py-2 text-12"
          style={{ animation: "fade-up var(--duration-slow) var(--ease-enter) backwards" }}
        >
          <span className="flex items-center gap-1.5 text-ink">
            <Icon icon={GitMergeIcon} size={14} />
            Merge the PR into main?
          </span>
          <span className="flex items-center gap-1.5 text-orange-ink">
            <span aria-hidden className="size-2 rounded-full bg-orange" />
            Waiting for you
          </span>
        </div>
      )}
    </div>
  );
}

export function FirstRunTour({ memory, settings, project }: { memory: OrchestratorMemory; settings: OrchestratorSettings; project: string }) {
  const motion = useMotionScale();
  const scale = useReducedMotion() ? 0 : motion || 1;
  const [t, setT] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(false);
  const [imported] = useState(() => memory.importedAt != null && memory.notes.length > 0 && !isMemoryImporting(memory));
  const [reading, setReading] = useState(!imported);
  useEffect(() => {
    if (imported) return;
    void importMemory()
      .catch((cause: Error) => setError(`Couldn't read your agents' notes: ${cause.message}`))
      .finally(() => setReading(false));
  }, [imported]);
  useEffect(() => {
    if (scale === 0) return;
    const began = performance.now();
    const timer = window.setInterval(() => setT((performance.now() - began) / scale), 50);
    return () => window.clearInterval(timer);
  }, [scale]);
  const color = settings.mascotColor;
  if (skipped || ((scale === 0 || t >= SUMMARY_AT) && !reading)) return <Summary memory={memory} settings={settings} error={error} color={color} />;
  const typed = DEMO.slice(0, Math.max(0, Math.min(DEMO.length, Math.floor((t - 3700) / 36))));
  const caption =
    t < 10_400
      ? "Type anything. I pick the Project, the model, the account and the computer."
      : "I answer the small stuff for you. Anything you can't undo waits for you.";
  return (
    <div data-first-run-tour className="relative flex h-full min-h-0 flex-col items-center px-6 pt-14 pb-6">
      {scale === 0 || t < 3000 ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-4 text-center"
          style={{ animation: "fade-up var(--duration-slow) var(--ease-enter) backwards" }}
        >
          <Mascot size={96} color={color} mood="happy" followPointer />
          <h1 className="text-26 font-semibold text-ink">Hi, I'm your Orchestrator.</h1>
          <p className="max-w-[440px] text-15 text-ink-2">
            One box for every Project. Let me show you how it works, while I read what your agents already know about you.
          </p>
        </div>
      ) : (
        <div
          key={caption}
          className="flex w-full max-w-[720px] flex-1 flex-col items-center gap-5"
          style={{ animation: "fade-in var(--duration-slow) var(--ease-enter)" }}
        >
          <p className="text-17 font-semibold text-ink">{caption}</p>
          <div className="flex w-full items-start gap-3">
            <Mascot
              size={48}
              color={color}
              mood={t < 7200 ? "idle" : "thinking"}
              look={t < 5800 ? { x: Math.min(1, -0.1 + typed.length / 48), y: 0.4 } : { x: -0.2, y: 1 }}
            />
            <div className="flex min-h-[72px] flex-1 flex-col rounded-window bg-surface px-4 pt-3 pb-2 shadow-raised">
              <span className={`text-15 ${typed && t < 5800 ? "text-ink" : "text-ink-3"}`}>
                {t < 5800 ? typed || "Ask for anything, in any Project…" : "Ask for anything, in any Project…"}
              </span>
            </div>
          </div>
          <div className="flex items-start gap-3">
            {t >= 6400 && <DemoCard t={t} color={color} project={project} />}
            <Bubbles t={t} />
          </div>
        </div>
      )}
      {t >= SUMMARY_AT && reading && (
        <span className="flex items-center gap-2 pt-4 text-13 text-ink-2">
          <SpinnerRing size={14} />
          Still reading what your agents already know…
        </span>
      )}
      <Button variant="quiet" size={28} className="no-drag mt-4" onClick={() => setSkipped(true)}>
        Skip tour
      </Button>
    </div>
  );
}
