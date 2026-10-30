import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cancel01Icon, CommandLineIcon, Globe02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { MCP_SECRET_MASK, validateMcpServer, type McpServerDefinition, type McpTarget } from "@milagre/shared/mcp";
import { Button, IconButton } from "./primitives/Button";
import { FIELD, FIELD_AREA } from "./primitives/Field";
import { Icon } from "./primitives/Icon";
import { InlineError } from "./primitives/InlineError";
import { RadioGroup, RadioGroupItem } from "./primitives/RadioGroup";

// `stored` is the value the server came with (the mask, for secrets); `edited` is set once the user types a new value.
type Pair = { key: string; value: string; stored?: string; edited?: boolean };
const EMPTY: Pair = { key: "", value: "" };
const toPairs = (record: Record<string, string>): Pair[] => Object.entries(record).map(([key, value]) => ({ key, value, stored: value }));
// An untouched value goes back as it came, so a masked secret is kept by the runtime rather than saved as "".
const sent = (pair: Pair) => (pair.edited || pair.stored === undefined ? pair.value : pair.stored);
const toRecord = (pairs: Pair[]) => Object.fromEntries(pairs.filter((pair) => pair.key || sent(pair)).map((pair) => [pair.key, sent(pair)]));
// The app's global rule drops the outline on inputs, so fields show focus as FIELD's accent border. In a pair row,
// flex-basis wins over FIELD's w-full.
const pairField = `${FIELD} min-w-0`;
const label = "block space-y-1.5 text-12 font-medium text-ink-2";
const TARGETS: { value: McpTarget; label: string; hint: string }[] = [
  { value: "everywhere", label: "Everywhere", hint: "Milagre Chats on every provider" },
  { value: "claude", label: "Claude only", hint: "Written to Claude’s config" },
  { value: "codex", label: "Codex only", hint: "Written to Codex’s config" },
];

/** Add or edit one server. `initial` set means edit; `remote` limits it to URL servers. */
export function McpServerSheet({
  initial,
  initialTarget = "everywhere",
  remote,
  onSave,
  onClose,
}: {
  initial?: McpServerDefinition;
  initialTarget?: McpTarget;
  remote: boolean;
  onSave: (def: McpServerDefinition, target: McpTarget) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<"url" | "command">(initial?.type === "stdio" ? "command" : "url");
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial && initial.type !== "stdio" ? initial.url : "");
  // An SSE server stays SSE through an edit; new URL servers are streamable HTTP.
  const urlType = initial?.type === "sse" ? "sse" : "http";
  // The command and its arguments are kept apart, one argument per line, so an argument with a space survives an edit.
  const [command, setCommand] = useState(initial?.type === "stdio" ? initial.command : "");
  const [args, setArgs] = useState(initial?.type === "stdio" ? initial.args.join("\n") : "");
  const [pairs, setPairs] = useState<Pair[]>(toPairs(initial ? (initial.type === "stdio" ? initial.env : initial.headers) : {}));
  const [target, setTarget] = useState<McpTarget>(initialTarget);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    // autoFocus fires before the dialog opens, so focus Name once it is modal.
    nameInput.current?.focus();
  }, []);
  const def: McpServerDefinition =
    kind === "url"
      ? { name: name.trim(), type: urlType, url: url.trim(), headers: toRecord(pairs) }
      : { name: name.trim(), type: "stdio", command: command.trim(), args: args.split("\n").filter((arg) => arg.trim() !== ""), env: toRecord(pairs) };
  // Typing again clears the last problem.
  const edit = (set: (value: string) => void, value: string) => {
    setError("");
    set(value);
  };
  const shown = pairs.length ? pairs : [EMPTY];
  const setPair = (index: number, pair: Pair) => setPairs(Object.assign([...shown], { [index]: pair }));
  const submit = async () => {
    const problem = validateMcpServer(def);
    if (problem) return setError(problem);
    setBusy(true);
    setError("");
    try {
      await onSave(def, target);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const title = initial ? "Edit MCP server" : "Add MCP server";
  return createPortal(
    <dialog
      ref={dialog}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => event.target === dialog.current && onClose()}
      className="m-auto w-[520px] max-w-[calc(100vw-32px)] overflow-visible rounded-window bg-surface p-0 text-ink shadow-overlay backdrop:bg-scrim backdrop:backdrop-blur-overlay"
      style={{ animation: "pop-in var(--duration-base) var(--ease-enter) both" }}
    >
      <form
        data-mcp-sheet
        className="space-y-4 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-17 font-semibold text-ink">{title}</h2>
          <IconButton label="Close" icon={Cancel01Icon} className="-mr-1" onClick={onClose} />
        </div>
        {/* Drawn as primitives/Segmented (large); kept by hand for the data-mcp-kind hooks and aria-pressed the tests read. */}
        <div className="flex gap-0.5 rounded-control bg-field p-0.5">
          {(["url", "command"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={kind === value}
              disabled={value === "command" && remote}
              data-mcp-kind={value}
              onClick={() => {
                // Headers and environment variables don't carry over between a URL and a command.
                if (value !== kind) setPairs([]);
                setKind(value);
              }}
              className={`flex h-7 flex-1 items-center justify-center gap-1.5 rounded-chip px-3 text-13 font-medium transition-colors duration-fast disabled:opacity-40 ${kind === value ? "bg-surface text-ink shadow-card" : "text-ink-2 enabled:hover:text-ink"}`}
            >
              <Icon icon={value === "url" ? Globe02Icon : CommandLineIcon} size={14} />
              {value === "url" ? "URL" : remote ? "Command (on the Mac)" : "Command"}
            </button>
          ))}
        </div>
        <label className={label}>
          Name
          <input ref={nameInput} aria-label="Name" className={FIELD} value={name} onChange={(event) => edit(setName, event.target.value)} />
        </label>
        {kind === "url" ? (
          <label className={label}>
            URL
            <input aria-label="URL" className={FIELD} placeholder="https://" value={url} onChange={(event) => edit(setUrl, event.target.value)} />
            <span className="block font-normal text-ink-3">If the server asks you to sign in, your browser opens after you add it.</span>
          </label>
        ) : (
          <>
            <label className={label}>
              Command
              <input aria-label="Command" className={FIELD} placeholder="npx" value={command} onChange={(event) => edit(setCommand, event.target.value)} />
            </label>
            <label className={label}>
              Arguments (optional)
              <textarea
                aria-label="Arguments"
                rows={3}
                className={`${FIELD_AREA} resize-y font-mono`}
                placeholder={"-y\n@scope/server"}
                value={args}
                onChange={(event) => edit(setArgs, event.target.value)}
              />
              <span className="block font-normal text-ink-3">One per line.</span>
            </label>
          </>
        )}
        <div className="space-y-1.5">
          <span className="block text-12 font-medium text-ink-2">{kind === "url" ? "Headers (optional)" : "Environment (optional)"}</span>
          {shown.map((pair, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                aria-label={kind === "url" ? "Header" : "Variable"}
                className={`${pairField} shrink-0 basis-[168px]`}
                placeholder={kind === "url" ? "Header" : "Variable"}
                value={pair.key}
                onChange={(event) => setPair(index, { ...pair, key: event.target.value })}
              />
              <input
                aria-label="Value"
                className={`${pairField} flex-1`}
                placeholder="Value"
                value={pair.value}
                // A focused masked value clears so a new one can be typed; left untouched, the mask comes back.
                onFocus={() => pair.value === MCP_SECRET_MASK && !pair.edited && setPair(index, { ...pair, value: "" })}
                onBlur={() => !pair.edited && pair.stored === MCP_SECRET_MASK && setPair(index, { ...pair, value: MCP_SECRET_MASK })}
                onChange={(event) => setPair(index, { ...pair, value: event.target.value, edited: true })}
              />
              <IconButton
                label={kind === "url" ? "Add a header" : "Add a variable"}
                icon={PlusSignIcon}
                iconSize={14}
                size={32}
                variant="secondary"
                className={index === shown.length - 1 ? "" : "invisible"}
                onClick={() => setPairs([...shown, EMPTY])}
              />
            </div>
          ))}
        </div>
        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-12 font-medium text-ink-2">Load it in</legend>
          <RadioGroup aria-label="Load it in" value={target} onValueChange={(value) => setTarget(value as McpTarget)}>
            <div className="divide-y divide-line rounded-card border border-line">
              {TARGETS.map((option) => (
                <label key={option.value} className="flex min-h-11 cursor-pointer items-center gap-2 px-3">
                  <RadioGroupItem value={option.value} aria-label={option.label} />
                  <span className={`flex-1 text-13 ${target === option.value ? "font-medium text-ink" : "text-ink-2"}`}>{option.label}</span>
                  <span className="text-12 text-ink-3">{option.hint}</span>
                </label>
              ))}
            </div>
          </RadioGroup>
        </fieldset>
        <InlineError size={12}>{error}</InlineError>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : initial ? "Save" : kind === "url" && !remote ? "Add and sign in" : "Add server"}
          </Button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}
