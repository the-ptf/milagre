import { useEffect, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, Cancel01Icon, FileEditIcon, PlusSignIcon, Search01Icon, Undo02Icon } from "@hugeicons/core-free-icons";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import {
  KEYBINDING_COMMANDS,
  WHEN_KEYS,
  canonicalKey,
  conflictsFor,
  defaultRulesFor,
  hasCommandModifier,
  isDefault,
  keyFromEvent,
  keyLabelFor,
  keybindingCommand,
  parseWhen,
  whenNames,
  type KeybindingCommand,
  type KeybindingCommandId,
  type KeybindingRule,
  type KeybindingsState,
} from "@milagre/shared/keybindings";
import { bridgeFor } from "../../lib/computer-bridge";
import { useComputers } from "../../lib/computers";
import { useKeybindings } from "../../lib/keybindings";
import { isMac, ThisComputer } from "../../lib/shortcut-hints";
import { Select } from "../primitives/Select";
import { ShortcutKeys } from "../primitives/ShortcutKeys";
import Tooltip from "../primitives/Tooltip";
import { SettingCheckbox } from "../primitives/Checkbox";
import { Group, Row } from "./SettingsGroup";

// Settings › Keybindings, as T3 Code has it: the rules of a computer's keybindings.json, edited on one computer or on all
// of them at once. A key is recorded by pressing it; one another command already has asks before taking it over.

type IconData = Parameters<typeof HugeiconsIcon>[0]["icon"];
const Icon = ({ icon, size = 15 }: { icon: IconData; size?: number }) => <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" />;

const ALL = "all";
/** This window's Advanced switch: conditions (`when`) are edited only while it is on. */
const ADVANCED_KEY = "milagre.keybindings.advanced";
const GROUPS = ["General", "Navigation", "Chat", "Panels"] as const;
type Edit = Array<{ command: KeybindingCommandId; rules: Array<{ key: string; when?: string }> }>;
/** The key being recorded: a rule of a command, or a new one (`index` -1). */
type Recording = { command: KeybindingCommandId; index: number };
/** A recorded key waiting on the user: it needs a modifier, or another command has it. */
type Pending = Recording & { key: string; conflicts: KeybindingCommandId[]; error?: string };

const label = (key: string) => keyLabelFor(key, isMac) ?? key;
const title = (command: KeybindingCommandId) => keybindingCommand(command)?.title ?? command;
const own = (rules: readonly KeybindingRule[], command: KeybindingCommandId) =>
  rules.filter((rule) => rule.command === command).map(({ key, when }) => (when ? { key, when } : { key }));

/** A computer's keybindings, live: this Mac's from the shared store, a paired one's read through its bridge. */
function useComputerKeybindings(computerId: string): { state: KeybindingsState | null; error: string | null } {
  const local = useKeybindings();
  const [remote, setRemote] = useState<{ id: string; state: KeybindingsState | null; error: string | null }>({ id: "", state: null, error: null });
  const isLocal = computerId === LOCAL_COMPUTER;
  useEffect(() => {
    if (isLocal) return;
    const bridge = bridgeFor(computerId);
    let live = true;
    const off = bridge.onKeybindings?.((state) => live && setRemote({ id: computerId, state: state?.rules ? state : null, error: null }));
    Promise.resolve()
      .then(() => bridge.readKeybindings())
      .then(
        (state) => live && setRemote({ id: computerId, state: state?.rules ? state : null, error: null }),
        (error: unknown) => live && setRemote({ id: computerId, state: null, error: error instanceof Error ? error.message : String(error) }),
      );
    return () => {
      live = false;
      off?.();
    };
  }, [computerId, isLocal]);
  if (isLocal) return { state: local.path ? local : null, error: null };
  return remote.id === computerId ? remote : { state: null, error: null };
}

export function KeybindingsSettings() {
  const { thisMac, computers } = useComputers();
  const [scope, setScope] = useState<string>(ALL);
  const shownId = scope === ALL ? LOCAL_COMPUTER : scope;
  const { state, error: readError } = useComputerKeybindings(shownId);
  const online = computers.filter((computer) => computer.state === "online");
  const targets = scope === ALL ? [LOCAL_COMPUTER, ...online.map((computer) => computer.id)] : [scope];
  const nameOf = (id: string) => (id === LOCAL_COMPUTER ? thisMac : (computers.find((computer) => computer.id === id)?.name ?? "Computer"));

  const [query, setQuery] = useState("");
  const [advanced, setAdvancedState] = useState(() => localStorage.getItem(ADVANCED_KEY) === "1");
  const setAdvanced = (on: boolean) => {
    setAdvancedState(on);
    localStorage.setItem(ADVANCED_KEY, on ? "1" : "0");
  };
  const [recording, setRecording] = useState<Recording | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const [confirmReset, setConfirmReset] = useState(false);
  const rules = state?.rules ?? [];

  // Applies an edit, worked out from each computer's own rules, on every computer in scope.
  async function apply(edit: (rules: readonly KeybindingRule[]) => Edit) {
    const results = await Promise.allSettled(
      targets.map(async (id) => {
        const bridge = bridgeFor(id);
        const current = id === shownId && state ? state : await bridge.readKeybindings();
        if (!current?.rules) throw new Error("its Milagre has no keybindings yet; update it first.");
        for (const { command, rules: next } of edit(current.rules)) await bridge.setKeybindingCommand(command, next);
      }),
    );
    setFailures(
      results.flatMap((result, index) =>
        result.status === "rejected" ? [`${nameOf(targets[index]!)}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : [],
      ),
    );
  }

  /** Puts `key` on the recorded rule, taking it from `take` first. */
  function save({ command, index, key }: Recording & { key: string }, take: KeybindingCommandId[] = []) {
    setPending(null);
    setRecording(null);
    void apply((current) => {
      const mine = own(current, command);
      const next = index < 0 || index >= mine.length ? [...mine, { key }] : mine.map((rule, at) => (at === index ? { ...rule, key } : rule));
      const when = index >= 0 ? mine[index]?.when : undefined;
      const taken: Edit = take.map((other) => ({
        command: other,
        rules: own(current, other).filter((rule) => (rule.when ?? "") !== (when ?? "") || canonicalKey(rule.key, isMac) !== canonicalKey(key, isMac)),
      }));
      return [...taken, { command, rules: next }];
    });
  }

  function removeRule(command: KeybindingCommandId, index: number) {
    setRecording(null);
    setPending(null);
    void apply((current) => [{ command, rules: own(current, command).filter((_, at) => at !== index) }]);
  }

  function setWhen(command: KeybindingCommandId, index: number, when: string) {
    void apply((current) => [
      {
        command,
        rules: own(current, command).map((rule, at) => (at !== index ? rule : when.trim() ? { key: rule.key, when: when.trim() } : { key: rule.key })),
      },
    ]);
  }

  function resetCommand(command: KeybindingCommandId) {
    void apply(() => [{ command, rules: defaultRulesFor(command).map(({ key }) => ({ key })) }]);
  }

  async function resetAll() {
    setConfirmReset(false);
    const results = await Promise.allSettled(targets.map((id) => bridgeFor(id).resetKeybindings()));
    setFailures(
      results.flatMap((result, index) =>
        result.status === "rejected" ? [`${nameOf(targets[index]!)}: ${String(result.reason?.message ?? result.reason)}`] : [],
      ),
    );
  }

  // While a key is recorded every press goes here first, so the app's own shortcuts don't run. Escape stops; Backspace
  // or Delete takes the key off.
  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.isComposing || event.repeat) return;
      const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      if (plain && event.key === "Escape") {
        setRecording(null);
        return;
      }
      if (plain && (event.key === "Backspace" || event.key === "Delete")) {
        if (recording.index >= 0) removeRule(recording.command, recording.index);
        else setRecording(null);
        return;
      }
      const key = keyFromEvent(event, isMac);
      if (!key) return;
      const when = recording.index >= 0 ? own(rules, recording.command)[recording.index]?.when : undefined;
      const conflicts = conflictsFor(rules, { key, command: recording.command, ...(when ? { when } : {}) }, isMac);
      if (!hasCommandModifier(key)) {
        setPending({ ...recording, key, conflicts, error: `${label(key)} would run while you type. Add ${isMac ? "⌘, ⌃ or ⌥" : "Ctrl or Alt"}.` });
        setRecording(null);
      } else if (conflicts.length) {
        setPending({ ...recording, key, conflicts });
        setRecording(null);
      } else save({ ...recording, key });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = (command: KeybindingCommand) => {
    const text = `${command.title} ${command.id} ${command.group} ${own(rules, command.id)
      .map((rule) => `${label(rule.key)} ${rule.key} ${rule.when ?? ""}`)
      .join(" ")}`.toLowerCase();
    return words.every((word) => text.includes(word));
  };
  const shown = KEYBINDING_COMMANDS.filter(matches);

  const scopeOptions = [
    { value: ALL, label: "All computers", description: online.length ? `${ThisComputer} and ${online.length} more` : ThisComputer },
    { value: LOCAL_COMPUTER, label: thisMac, description: ThisComputer },
    ...computers.map((computer) => ({
      value: computer.id,
      label: computer.name,
      description: computer.state === "online" ? (computer.address ?? "Online") : "Offline",
      disabled: computer.state !== "online",
    })),
  ];

  return (
    <div data-keybindings-settings>
      <div className="mt-1 flex items-center gap-1 text-[13px] text-ink-2">
        <span>Applying to</span>
        <Select label="Computers" variant="text" value={scope} options={scopeOptions} onChange={(value) => setScope(value)} width={260} />
      </div>
      <p className="mt-1 text-[12px] text-ink-3">
        Each computer keeps its keys in a keybindings.json; the last rule whose key and condition match runs.
        {scope === ALL && online.length > 0 ? " Changes here go to every computer that is online." : ""}
      </p>

      <div className="mt-5 flex items-center gap-2">
        <label className="flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-field px-2.5 text-ink-3 focus-within:border-line-strong">
          <Icon icon={Search01Icon} size={14} />
          <input
            data-keybindings-search
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search keybindings"
            aria-label="Search keybindings"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
          />
        </label>
        {shownId === LOCAL_COMPUTER && window.milagre.openKeybindingsFile && (
          <Tooltip label="Open keybindings.json" side="bottom">
            <button
              type="button"
              aria-label="Open keybindings.json"
              data-keybindings-open-file
              onClick={() => void window.milagre.openKeybindingsFile?.()}
              className="flex size-[34px] items-center justify-center rounded-lg border border-line-strong bg-surface text-ink-2 transition-colors hover:bg-hover"
            >
              <Icon icon={FileEditIcon} />
            </button>
          </Tooltip>
        )}
        <Select<KeybindingCommandId | "">
          label="Add keybinding"
          variant="field"
          value=""
          searchable
          width={300}
          leading={<Icon icon={PlusSignIcon} size={14} />}
          options={[
            { value: "", label: "Add keybinding", disabled: true },
            ...KEYBINDING_COMMANDS.map((command) => ({ value: command.id, label: command.title, group: command.group })),
          ]}
          onChange={(command) => {
            if (!command) return;
            setPending(null);
            setQuery("");
            setRecording({ command, index: -1 });
            requestAnimationFrame(() => document.querySelector(`[data-keybinding-row="${command}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
          }}
        />
      </div>

      {readError && (
        <Notice tone="warn">
          Couldn't read keybindings on {nameOf(shownId)}: {readError}
        </Notice>
      )}
      {state && state.issues.length > 0 && (
        <Notice tone="warn">
          <span className="font-medium">keybindings.json has problems.</span>
          <ul className="mt-1 list-disc pl-4">
            {state.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </Notice>
      )}
      {failures.map((failure) => (
        <Notice key={failure} tone="warn">
          Couldn't save on {failure}
        </Notice>
      ))}

      {GROUPS.map((group) => {
        const commands = shown.filter((command) => command.group === group);
        if (!commands.length) return null;
        return (
          <section key={group} className="mt-6">
            <h2 className="mb-2 px-1 text-[12px] font-medium text-ink-3">{group}</h2>
            <div className="divide-y divide-line overflow-hidden rounded-[12px] bg-surface shadow-card">
              {commands.map((command) => (
                <CommandRow
                  key={command.id}
                  command={command}
                  rules={own(rules, command.id)}
                  customized={state ? !isDefault(rules, command.id) : false}
                  advanced={advanced}
                  recording={recording?.command === command.id ? recording.index : null}
                  pending={pending?.command === command.id ? pending : null}
                  onRecord={(index) => {
                    setPending(null);
                    setRecording({ command: command.id, index });
                  }}
                  onRemove={(index) => removeRule(command.id, index)}
                  onWhen={(index, when) => setWhen(command.id, index, when)}
                  onReset={() => resetCommand(command.id)}
                  onReplace={() => pending && save(pending, pending.conflicts)}
                  onCancel={() => setPending(null)}
                />
              ))}
            </div>
          </section>
        );
      })}
      {shown.length === 0 && <p className="mt-6 px-1 text-[13px] text-ink-3">No keybindings match “{query}”.</p>}

      <Group title="Advanced">
        <Row label="Conditions" description="Adds When to each keybinding, to run a key only in some places (for example not in a Terminal).">
          <SettingCheckbox label="Conditions" checked={advanced} onChange={setAdvanced} />
        </Row>
      </Group>

      <div className="mt-6 flex items-center justify-end gap-3 px-1 text-[12px]">
        {confirmReset ? (
          <>
            <span className="text-ink-2">Put every key back to its default{targets.length > 1 ? " on every computer" : ""}?</span>
            <button type="button" className="font-medium text-ink-3 hover:text-ink" onClick={() => setConfirmReset(false)}>
              Cancel
            </button>
            <button type="button" data-keybindings-reset-all className="font-medium text-red hover:underline" onClick={() => void resetAll()}>
              Reset all
            </button>
          </>
        ) : (
          <button type="button" className="font-medium text-accent-ink hover:underline" onClick={() => setConfirmReset(true)}>
            Reset all to defaults
          </button>
        )}
      </div>
    </div>
  );
}

function Notice({ tone, children }: { tone: "warn"; children: ReactNode }) {
  return (
    <div data-keybindings-notice={tone} className="mt-4 flex gap-2 rounded-[10px] bg-hover px-3 py-2 text-[12.5px] text-ink-2">
      <span className="mt-px shrink-0 text-orange">
        <Icon icon={Alert02Icon} size={14} />
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function CommandRow({
  command,
  rules,
  customized,
  advanced,
  recording,
  pending,
  onRecord,
  onRemove,
  onWhen,
  onReset,
  onReplace,
  onCancel,
}: {
  command: KeybindingCommand;
  rules: Array<{ key: string; when?: string }>;
  customized: boolean;
  /** Settings' Advanced switch: shows When and the condition fields. */
  advanced: boolean;
  /** The rule being recorded, -1 for a new one; null while none is. */
  recording: number | null;
  pending: Pending | null;
  onRecord: (index: number) => void;
  onRemove: (index: number) => void;
  onWhen: (index: number, when: string) => void;
  onReset: () => void;
  onReplace: () => void;
  onCancel: () => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div data-keybinding-row={command.id} className="px-4 py-2.5">
      <div className="flex min-h-8 items-center justify-between gap-4">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-[13.5px] font-medium text-ink">{command.title}</span>
          <span className="truncate font-mono text-[11px] text-ink-3">{command.id}</span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {rules.map((rule, index) => (
            <KeyChip
              key={`${rule.key}|${rule.when ?? ""}`}
              rule={rule}
              recording={recording === index}
              onClick={() => onRecord(index)}
              onRemove={() => onRemove(index)}
            />
          ))}
          {recording === -1 ? (
            <KeyChip recording rule={{ key: "" }} onClick={() => {}} />
          ) : rules.length === 0 ? (
            <button
              type="button"
              data-keybinding-add
              className="h-[26px] rounded-[7px] px-2 text-[12px] text-ink-3 hover:bg-hover hover:text-ink"
              onClick={() => onRecord(-1)}
            >
              Unbound · Add key
            </button>
          ) : (
            <Tooltip label="Add another key" side="bottom">
              <button
                type="button"
                aria-label={`Add a key for ${command.title}`}
                data-keybinding-add
                className="flex size-[26px] items-center justify-center rounded-[7px] text-ink-3 hover:bg-hover hover:text-ink"
                onClick={() => onRecord(-1)}
              >
                <Icon icon={PlusSignIcon} size={13} />
              </button>
            </Tooltip>
          )}
          {advanced && rules.length > 0 && (
            <button
              type="button"
              data-keybinding-conditions
              aria-expanded={editing}
              className={`h-[26px] rounded-[7px] px-1.5 text-[11.5px] hover:bg-hover hover:text-ink ${editing ? "text-ink" : "text-ink-3"}`}
              onClick={() => setEditing((value) => !value)}
            >
              When
            </button>
          )}
          <Tooltip label="Back to default" side="bottom">
            <button
              type="button"
              aria-label={`Reset ${command.title}`}
              data-keybinding-reset
              disabled={!customized}
              className="flex size-[26px] items-center justify-center rounded-[7px] text-ink-3 hover:bg-hover hover:text-ink disabled:invisible"
              onClick={onReset}
            >
              <Icon icon={Undo02Icon} size={13} />
            </button>
          </Tooltip>
        </div>
      </div>
      {pending && (
        <div data-keybinding-pending className="mt-2 flex items-center justify-between gap-3 rounded-[8px] bg-hover px-2.5 py-1.5 text-[12px] text-ink-2">
          <span>
            {pending.error ??
              `${label(pending.key)} already runs ${pending.conflicts.map((other) => `“${title(other)}”`).join(", ")}. Replace takes it from ${pending.conflicts.length > 1 ? "them" : "it"}.`}
          </span>
          <span className="flex shrink-0 gap-3">
            <button type="button" className="font-medium text-ink-3 hover:text-ink" onClick={onCancel}>
              {pending.error ? "OK" : "Cancel"}
            </button>
            {!pending.error && (
              <button type="button" data-keybinding-replace className="font-medium text-accent-ink hover:underline" onClick={onReplace}>
                Replace
              </button>
            )}
          </span>
        </div>
      )}
      {advanced && editing && rules.length > 0 && (
        <div className="mt-2 grid gap-1.5">
          {rules.map((rule, index) => (
            <WhenField key={`${rule.key}|${rule.when ?? ""}`} rule={rule} onChange={(when) => onWhen(index, when)} />
          ))}
        </div>
      )}
    </div>
  );
}

function KeyChip({
  rule,
  recording,
  onClick,
  onRemove,
}: {
  rule: { key: string; when?: string };
  recording?: boolean;
  onClick: () => void;
  onRemove?: () => void;
}) {
  if (recording) {
    return (
      <span
        data-keybinding-recording
        className="inline-flex h-[26px] items-center rounded-[7px] border border-accent px-2 text-[12px] text-accent-ink [animation:pulse_1.6s_ease-in-out_infinite]"
      >
        Press keys… <span className="ml-1.5 text-ink-3">Esc cancels</span>
      </span>
    );
  }
  return (
    <span className="group/chip relative inline-flex items-center">
      <button
        type="button"
        data-keybinding-chip={rule.key}
        title={rule.when ? `${rule.key} when ${rule.when}` : rule.key}
        className="inline-flex items-center gap-1 rounded-[7px] p-0.5 transition-colors hover:bg-hover"
        onClick={onClick}
      >
        <ShortcutKeys shortcut={label(rule.key)} />
        {rule.when && <span className="max-w-[120px] truncate font-mono text-[10.5px] text-ink-3">{rule.when}</span>}
      </button>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${label(rule.key)}`}
          data-keybinding-remove
          className="absolute -top-1.5 -right-1.5 hidden size-4 items-center justify-center rounded-full bg-ink text-surface group-hover/chip:flex"
          onClick={onRemove}
        >
          <Icon icon={Cancel01Icon} size={9} />
        </button>
      )}
    </span>
  );
}

/** A rule's condition, saved on Enter or leaving the field, once it reads. */
function WhenField({ rule, onChange }: { rule: { key: string; when?: string }; onChange: (when: string) => void }) {
  // Keyed by the saved condition, so a change from elsewhere starts the field over.
  const saved = rule.when ?? "";
  const [draft, setDraft] = useState(saved);
  const tree = draft.trim() ? parseWhen(draft) : null;
  const invalid = Boolean(draft.trim()) && !tree;
  const unknown = whenNames(tree).filter((name) => !(name in WHEN_KEYS));
  const commit = () => {
    if (invalid || draft.trim() === saved) return;
    onChange(draft);
  };
  return (
    <div className="flex items-center gap-2">
      <span className="w-[88px] shrink-0 text-right">
        <ShortcutKeys shortcut={label(rule.key)} compact />
      </span>
      <div className="min-w-0 flex-1">
        <input
          data-keybinding-when
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") {
              event.stopPropagation();
              setDraft(saved);
            }
          }}
          placeholder="Always (e.g. !terminalFocus && chatView)"
          aria-label={`Condition for ${label(rule.key)}`}
          aria-invalid={invalid}
          className={`h-7 w-full rounded-[7px] border bg-field px-2 font-mono text-[11.5px] text-ink outline-none placeholder:font-sans placeholder:text-ink-3 ${invalid ? "border-red" : "border-line focus:border-line-strong"}`}
        />
        {(invalid || unknown.length > 0) && (
          <p className="mt-0.5 text-[11px] text-ink-3">
            {invalid
              ? "Use names with !, &&, || and parentheses."
              : `${unknown.join(", ")} ${unknown.length > 1 ? "are" : "is"} never true. Known: ${Object.keys(WHEN_KEYS).join(", ")}.`}
          </p>
        )}
      </div>
    </div>
  );
}
