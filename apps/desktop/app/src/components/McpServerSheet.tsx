import { useEffect, useRef, useState } from "react";
import { CommandLineIcon, Globe02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { MCP_SECRET_MASK, validateMcpServer, type McpServerDefinition, type McpTarget } from "@milagre/shared/mcp";
import { Button, IconButton } from "./primitives/Button";
import { Dialog } from "./primitives/Dialog";
import { FIELD, FIELD_AREA, FIELD_LABEL } from "./primitives/Field";
import { InlineError } from "./primitives/InlineError";
import { RadioGroup, RadioGroupItem } from "./primitives/RadioGroup";
import { Segmented } from "./primitives/Segmented";

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
const label = `grid gap-1 ${FIELD_LABEL}`;
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
    // Dialog (a child, so its effect ran first) is modal by now: focus Name rather than the first field it picked.
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
  return (
    <Dialog
      as="form"
      data-mcp-sheet
      title={title}
      width={520}
      onClose={onClose}
      dismissOnScrim={!busy}
      onSubmit={() => void submit()}
      className="space-y-4 pt-3"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : initial ? "Save" : kind === "url" && !remote ? "Add and sign in" : "Add server"}
          </Button>
        </>
      }
    >
      <Segmented
        label="Server type"
        size="large"
        dataKey="mcp-kind"
        value={kind}
        options={[
          { value: "url", label: "URL", icon: Globe02Icon },
          { value: "command", label: remote ? "Command (on the Mac)" : "Command", icon: CommandLineIcon, disabled: remote },
        ]}
        onChange={(value) => {
          // Headers and environment variables don't carry over between a URL and a command.
          if (value !== kind) setPairs([]);
          setKind(value);
        }}
      />
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
      <div className="space-y-1">
        <span className={`block ${FIELD_LABEL}`}>{kind === "url" ? "Headers (optional)" : "Environment (optional)"}</span>
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
              size={32}
              variant="secondary"
              className={index === shown.length - 1 ? "" : "invisible"}
              onClick={() => setPairs([...shown, EMPTY])}
            />
          </div>
        ))}
      </div>
      <fieldset>
        <legend className={`mb-1 ${FIELD_LABEL}`}>Load it in</legend>
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
    </Dialog>
  );
}
