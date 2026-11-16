import { useEffect, useState } from "react";
import { ArrowLeft01Icon, ArrowRight01Icon, ComputerIcon, ShieldAlertIcon } from "@hugeicons/core-free-icons";
import {
  COMPUTER_PREFERENCES,
  MASCOT_COLORS,
  VETO_SECONDS,
  type AutopilotMode,
  type ComputerPreference,
  type OrchestratorComputer,
  type OrchestratorSettings as Settings,
} from "@milagre/shared/orchestrator";
import type { ModelOption } from "../../model";
import { useShortcutLabel } from "../../lib/keybindings";
import { ORCHESTRATOR_DESCRIPTION } from "../../lib/orchestrator-copy";
import { saveOrchestratorSettings, useOrchestrator } from "../../lib/orchestrator-store";
import { Button, IconButton } from "../primitives/Button";
import { SettingCheckbox } from "../primitives/Checkbox";
import { Input } from "../primitives/Field";
import { Icon } from "../primitives/Icon";
import { InlineError } from "../primitives/InlineError";
import { Select } from "../primitives/Select";
import { ShortcutKeys } from "../primitives/ShortcutKeys";
import { Mascot } from "../orchestrator/Mascot";
import { AUTOPILOT_TITLES } from "../../lib/orchestrator-names";
import { Group, Row } from "./SettingsGroup";
import { MODEL_SEPARATOR as SEP, modelOptions, splitModel } from "./orchestrator-models";
import { OrchestratorMemoryRow, OrchestratorMemorySettings } from "./OrchestratorMemorySettings";
import { OrchestratorProjectsSettings } from "./OrchestratorProjectsSettings";
import { OrchestratorRolesSettings } from "./OrchestratorRolesSettings";

const PREFERENCE_TITLES: Record<ComputerPreference, string> = { prefer: "Prefer", normal: "Normal", less: "Less often", manual: "Manual only", never: "Never" };
const VETO_TITLES: Record<number, string> = { 0: "None", 30: "30 seconds", 120: "2 minutes", 600: "10 minutes" };
function useSave() {
  const [error, setError] = useState<string | null>(null);
  const save = (patch: Partial<Settings>) => {
    setError(null);
    void saveOrchestratorSettings(patch).catch((cause: Error) => setError(cause.message));
  };
  return { error, save };
}

export function OrchestratorRow({ onOpen }: { onOpen: () => void }) {
  const { settings, loaded } = useOrchestrator();
  return (
    <button
      type="button"
      data-settings-row
      data-orchestrator-settings-row
      onClick={onOpen}
      className="flex min-h-12 w-full items-center justify-between gap-6 px-4 py-2 text-left transition-colors duration-fast hover:bg-hover"
    >
      <span className="grid min-w-0 gap-0.5">
        <span className="text-13 font-medium text-ink">Orchestrator</span>
        <span className="text-12 text-ink-3">{ORCHESTRATOR_DESCRIPTION}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-13 text-ink-2">
        {loaded && (settings.enabled ? "On" : "Off")}
        <span className="text-ink-3">
          <Icon icon={ArrowRight01Icon} size={16} />
        </span>
      </span>
    </button>
  );
}

function computerLine(computer: OrchestratorComputer) {
  if (!computer.online) return "Offline";
  const parts = [
    computer.cpu === null ? null : `${Math.round(computer.cpu * 100)}% CPU`,
    computer.memoryFree === null ? null : `${Math.round(computer.memoryFree * 100)}% memory free`,
    computer.agents === null ? null : `${computer.agents} ${computer.agents === 1 ? "agent" : "agents"} running`,
    computer.takesTasks ? null : "Update Milagre there to send it tasks",
  ];
  return parts.filter(Boolean).join(" · ") || "Online";
}

function ComputersGroup({ settings, save }: { settings: Settings; save: (patch: Partial<Settings>) => void }) {
  const [computers, setComputers] = useState<OrchestratorComputer[] | null>(null);
  useEffect(() => {
    void window.milagre
      .readOrchestratorComputers()
      .then((list) => {
        setComputers(list);
        return list;
      })
      .catch(() => setComputers([]));
  }, []);
  if (computers?.length === 0) return null;
  return (
    <Group title="Computers">
      <Row
        label="Use other computers"
        description="When a Project is on more than one computer, a task runs on the one with the most room: free CPU and memory, agents already running."
      >
        <SettingCheckbox label="Use other computers" checked={settings.useOtherComputers} onChange={(useOtherComputers) => save({ useOtherComputers })} />
      </Row>
      {computers?.map((computer) => (
        <div key={computer.id} className={`flex min-h-12 items-center gap-3 px-4 py-2 ${settings.useOtherComputers ? "" : "opacity-40"}`}>
          <span className="flex text-ink-3">
            <Icon icon={ComputerIcon} size={16} />
          </span>
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="text-13 font-medium text-ink">{computer.name}</span>
            <span className="text-12 text-ink-3">{computerLine(computer)}</span>
          </span>
          <Select<ComputerPreference>
            label={`How often to use ${computer.name}`}
            width={180}
            disabled={!settings.useOtherComputers}
            value={settings.computerPreferences[computer.id] ?? "normal"}
            options={COMPUTER_PREFERENCES.map((preference) => ({ value: preference, label: PREFERENCE_TITLES[preference] }))}
            onChange={(preference) => save({ computerPreferences: { ...settings.computerPreferences, [computer.id]: preference } })}
          />
        </div>
      ))}
    </Group>
  );
}

function NameField({ name, onSave }: { name: string; onSave: (name: string) => void }) {
  const [draft, setDraft] = useState(name);
  const commit = () => {
    const next = draft.replace(/\s+/g, " ").trim();
    if (next && next !== name) onSave(next);
    else setDraft(name);
  };
  return (
    <Input
      size={32}
      aria-label="Orchestrator name"
      value={draft}
      maxLength={40}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        else if (event.key === "Escape") {
          setDraft(name);
          event.currentTarget.blur();
        }
      }}
      className="w-[220px]"
    />
  );
}

function OrchestratorForm({
  settings,
  models,
  onOpenKeybindings,
  onOpenMemory,
}: {
  settings: Settings;
  models: ModelOption[];
  onOpenKeybindings?: () => void;
  onOpenMemory: () => void;
}) {
  const { error, save } = useSave();
  const shortcut = useShortcutLabel("orchestrator.open");
  return (
    <>
      <InlineError size={12} className="mt-3 px-1">
        {error}
      </InlineError>
      <Group>
        <Row
          label="Turn on the Orchestrator"
          description={`Pins the Orchestrator row atop the sidebar${shortcut ? ` and turns on ${shortcut}` : ""}. Turning it off keeps your tasks.`}
        >
          <SettingCheckbox label="Turn on the Orchestrator" checked={settings.enabled} onChange={(enabled) => save({ enabled })} />
        </Row>
      </Group>
      <div data-orchestrator-options inert={!settings.enabled} className={`transition-opacity duration-base ${settings.enabled ? "" : "opacity-40"}`}>
        <Group title="Mascot and shortcut">
          <Row label="Name" description="What the sidebar row and the page call it, up to 40 characters">
            <NameField key={settings.name} name={settings.name} onSave={(name) => save({ name })} />
          </Row>
          <Row label="Color" description="The color of Pebble, the mascot">
            <div role="radiogroup" aria-label="Mascot color" className="flex gap-2.5">
              {MASCOT_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={settings.mascotColor === color}
                  aria-label={color}
                  onClick={() => save({ mascotColor: color })}
                  className={`size-6 rounded-full shadow-hairline transition-shadow ${settings.mascotColor === color ? "ring-2 ring-ink ring-offset-2 ring-offset-surface" : ""}`}
                  style={{ background: color }}
                />
              ))}
            </div>
          </Row>
          <Row label="Open from anywhere" description="Drops the box over any Chat">
            <span className="flex items-center gap-2">
              {shortcut ? <ShortcutKeys shortcut={shortcut} /> : <span className="text-12 text-ink-3">No shortcut</span>}
              {onOpenKeybindings && (
                <Button variant="quiet" size={28} onClick={onOpenKeybindings}>
                  Change
                </Button>
              )}
            </span>
          </Row>
        </Group>
        <Group title="Routing">
          <Row label="Router model" description="Reads your prompt, your kept notes and the Project hints, on your own account">
            <Select
              label="Router model"
              width={280}
              searchable
              value={`${settings.router.provider}${SEP}${settings.router.model}`}
              options={modelOptions(models, settings.router)}
              onChange={(value) => save({ router: splitModel(value) })}
            />
          </Row>
          <Row
            label="When no Project fits"
            description={settings.whenUnsure === "ask" ? "The task waits in Needs you until you pick" : "Runs in the closest match; you can re-route it"}
          >
            <Select<Settings["whenUnsure"]>
              label="When no Project fits"
              width={180}
              value={settings.whenUnsure}
              options={[
                { value: "ask", label: "Ask me" },
                { value: "guess", label: "Best guess" },
              ]}
              onChange={(whenUnsure) => save({ whenUnsure })}
            />
          </Row>
          <Row
            label="Account"
            description={settings.account === "least-used" ? "Spreads work and skips an account at its limit" : "Uses the account each Project already picked"}
          >
            <Select<Settings["account"]>
              label="Account"
              width={220}
              value={settings.account}
              options={[
                { value: "least-used", label: "Least used today" },
                { value: "project", label: "The Project's account" },
              ]}
              onChange={(account) => save({ account })}
            />
          </Row>
        </Group>
        <ComputersGroup settings={settings} save={save} />
        <Group title="Autopilot">
          <Row
            label="Answer threads for me"
            description={
              settings.autopilot === "answer"
                ? "Answers questions and approvals in the tasks it started, and notes why. You can undo any answer."
                : settings.autopilot === "ask"
                  ? "Proposes an answer and waits for your OK."
                  : "Every question and approval waits for you."
            }
          >
            <Select<AutopilotMode>
              label="Answer threads for me"
              width={180}
              value={settings.autopilot}
              options={(Object.keys(AUTOPILOT_TITLES) as AutopilotMode[]).map((mode) => ({ value: mode, label: AUTOPILOT_TITLES[mode] }))}
              onChange={(autopilot) => save({ autopilot })}
            />
          </Row>
          {settings.autopilot !== "off" && (
            <>
              <Row label="Time to veto" description="When it isn't sure, it waits this long before answering so you can step in">
                <Select
                  label="Time to veto"
                  width={180}
                  value={String(settings.vetoSeconds)}
                  options={VETO_SECONDS.map((seconds) => ({ value: String(seconds), label: VETO_TITLES[seconds] ?? `${seconds} seconds` }))}
                  onChange={(value) => save({ vetoSeconds: Number(value) })}
                />
              </Row>
              <div className="flex items-center gap-2.5 px-4 py-3">
                <span className="flex text-orange">
                  <Icon icon={ShieldAlertIcon} size={16} />
                </span>
                <span className="text-12 text-ink-2">Always asks you before merging, pushing to main, deleting, deploying, paying or messaging someone.</span>
              </div>
            </>
          )}
        </Group>
        <OrchestratorMemoryRow onOpen={onOpenMemory} />
        <OrchestratorProjectsSettings settings={settings} save={save} />
        <OrchestratorRolesSettings settings={settings} models={models} save={save} />
        <Group title="Board">
          <Row label="Keep Orchestrator task Chats out of the sidebar" description="Move any task to the sidebar from its card or its Chat">
            <SettingCheckbox
              label="Keep Orchestrator task Chats out of the sidebar"
              checked={settings.hideTaskChats}
              onChange={(hideTaskChats) => save({ hideTaskChats })}
            />
          </Row>
          <Row label="Notify me when a task needs me" description="Approvals and questions from any task">
            <SettingCheckbox label="Notify me when a task needs me" checked={settings.notify} onChange={(notify) => save({ notify })} />
          </Row>
        </Group>
      </div>
    </>
  );
}

function PageTitle({ trail, back, onBack }: { trail: string[]; back: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <IconButton label={back} icon={ArrowLeft01Icon} onClick={onBack} />
      <h1 className="flex min-w-0 items-center gap-2 text-22 font-semibold tracking-[-0.02em] text-ink">
        {trail.map((part, index) => (
          <span key={part} className="flex items-center gap-2">
            {index > 0 && (
              <span className="text-ink-3">
                <Icon icon={ArrowRight01Icon} size={16} />
              </span>
            )}
            <span className={index < trail.length - 1 ? "text-ink-3" : ""}>{part}</span>
          </span>
        ))}
      </h1>
    </div>
  );
}

export function OrchestratorSettingsPage({ models, onBack, onOpenKeybindings }: { models: ModelOption[]; onBack: () => void; onOpenKeybindings?: () => void }) {
  const { settings, loaded } = useOrchestrator();
  const [page, setPage] = useState<"main" | "memory">("main");
  if (page === "memory")
    return (
      <div data-orchestrator-memory-page>
        <PageTitle trail={["Orchestrator", "Memory"]} back="Back to Orchestrator" onBack={() => setPage("main")} />
        <OrchestratorMemorySettings />
      </div>
    );
  return (
    <div data-orchestrator-settings-page>
      <PageTitle trail={["Church", "Orchestrator"]} back="Back to Church" onBack={onBack} />
      <div className="mt-4 flex items-center gap-4">
        <Mascot size={48} color={settings.mascotColor} followPointer />
        <p className="flex-1 text-13 text-ink-2">
          One box for every Project. It picks the Project, the role, the model and the account, then runs the work as a Chat.
        </p>
      </div>
      {loaded && <OrchestratorForm settings={settings} models={models} onOpenKeybindings={onOpenKeybindings} onOpenMemory={() => setPage("memory")} />}
    </div>
  );
}
