import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, CommandLineIcon, Globe02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import {
  MCP_SECRET_MASK,
  searchMcpCatalog,
  mcpCatalogDefinition,
  mcpCatalogAuthHint,
  validateMcpServer,
  type McpCatalogEntry,
  type McpServerDefinition,
  type McpTarget,
} from "@milagre/shared/mcp";

import { ScrollArea } from "./primitives/ScrollArea";

// `stored` is the value the server came with (the mask, for secrets); `edited` is set once the user types a new value.
type Pair = { key: string; value: string; stored?: string; edited?: boolean };
const EMPTY: Pair = { key: "", value: "" };
const toPairs = (record: Record<string, string>): Pair[] => Object.entries(record).map(([key, value]) => ({ key, value, stored: value }));
// An untouched value goes back as it came, so a masked secret is kept by the runtime rather than saved as "".
const sent = (pair: Pair) => (pair.edited || pair.stored === undefined ? pair.value : pair.stored);
const toRecord = (pairs: Pair[]) => Object.fromEntries(pairs.filter((pair) => pair.key || sent(pair)).map((pair) => [pair.key, sent(pair)]));
// The app's global rule drops the outline on inputs, so focus shows as an ink border.
const field = "w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-ink focus:ring-1 focus:ring-ink";
const pairField =
  "min-w-0 rounded-lg border border-transparent bg-field px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-ink focus:ring-1 focus:ring-ink";
const footerButton = "rounded-lg px-4 py-2 text-[13px] transition-colors disabled:opacity-40";
const label = "block space-y-1.5 text-[12px] font-medium text-ink-2";
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
  const heading = useRef<HTMLHeadingElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const tokenInput = useRef<HTMLInputElement>(null);
  const [choosing, setChoosing] = useState(!initial);
  const [service, setService] = useState<McpCatalogEntry | null>(null);
  const [search, setSearch] = useState("");
  const [token, setToken] = useState("");
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
  }, []);
  useEffect(() => {
    if (choosing) searchInput.current?.focus();
    else if (service?.auth === "token") tokenInput.current?.focus();
    else if (service) heading.current?.focus();
    else nameInput.current?.focus();
  }, [choosing, service]);
  const choose = (entry: McpCatalogEntry | null) => {
    setService(entry);
    setChoosing(false);
    setKind("url");
    setName(entry?.id ?? "");
    setUrl(entry?.url ?? "");
    setPairs([]);
    setCommand("");
    setArgs("");
    setToken("");
    setError("");
  };
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
    if (choosing || busy) return;
    let payload = def;
    try {
      if (service) payload = mcpCatalogDefinition(service, token);
    } catch (cause) {
      return setError(cause instanceof Error ? cause.message : String(cause));
    }
    const problem = validateMcpServer(payload);
    if (problem) return setError(problem);
    setBusy(true);
    setError("");
    try {
      await onSave(payload, target);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const title = initial ? "Edit MCP server" : service ? `Add ${service.name}` : choosing ? "Add MCP" : "Custom MCP";
  return createPortal(
    <dialog
      ref={dialog}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onMouseDown={(event) => !busy && event.target === dialog.current && onClose()}
      className="m-auto w-[520px] max-w-[calc(100vw-32px)] overflow-visible rounded-2xl bg-surface p-0 text-ink shadow-overlay backdrop:bg-black/20 backdrop:backdrop-blur-overlay"
    >
      <form
        data-mcp-sheet
        className="flex max-h-[calc(100dvh-64px)] flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex shrink-0 items-center justify-between px-6 pt-6 pb-4">
          <h2 ref={heading} tabIndex={-1} className="text-[17px] font-semibold text-ink outline-none">
            {title}
          </h2>
          <button type="button" aria-label="Close" disabled={busy} className="rounded-md p-1 text-ink-2 hover:bg-hover" onClick={onClose}>
            <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.75} color="currentColor" />
          </button>
        </div>
        <ScrollArea className="space-y-4 px-6 pb-6">
          {choosing ? (
            <div data-mcp-catalog className="space-y-4">
              <p className="text-13 text-ink-2">Choose a service. Its connection settings are ready to use.</p>
              <input
                ref={searchInput}
                aria-label="Search services"
                placeholder="Search services"
                className={field}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <div className="divide-y divide-line overflow-hidden rounded-card border border-line">
                {searchMcpCatalog(search).map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    data-mcp-service={entry.id}
                    onClick={() => choose(entry)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-hover active:bg-hover-2"
                  >
                    <span
                      aria-hidden="true"
                      className="flex size-8 shrink-0 items-center justify-center rounded-control bg-field text-15 font-semibold text-ink"
                    >
                      <svg viewBox="0 0 24 24" width={20} height={20} fill="currentColor" focusable="false">
                        <path d={entry.iconPath} />
                      </svg>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-13 font-semibold text-ink">{entry.name}</span>
                      <span className="block text-12 text-ink-2">{entry.description}</span>
                    </span>
                    <span className="shrink-0 text-11 text-ink-3">{entry.auth === "token" ? "Token" : "Sign in"}</span>
                  </button>
                ))}
              </div>
              {searchMcpCatalog(search).length === 0 && (
                <p role="status" className="text-13 text-ink-2">
                  No matching services. You can add a custom MCP with its URL or command.
                </p>
              )}
              <button
                type="button"
                data-mcp-custom
                onClick={() => choose(null)}
                className="flex w-full items-center gap-3 rounded-control border border-line-strong px-4 py-3 text-left transition-colors hover:bg-hover"
              >
                <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.8} />
                <span>
                  <span className="block text-13 font-medium">Custom MCP</span>
                  <span className="block text-12 text-ink-2">
                    {remote ? "Connect another service with a URL." : "Connect another service with a URL or command."}
                  </span>
                </span>
              </button>
            </div>
          ) : (
            <>
              {!initial && (
                <button
                  type="button"
                  data-mcp-back
                  disabled={busy}
                  className="text-12 font-medium text-ink-2 hover:underline disabled:opacity-40"
                  onClick={() => {
                    setChoosing(true);
                    setService(null);
                    setToken("");
                    setError("");
                  }}
                >
                  All services
                </button>
              )}
              {service ? (
                <section className="space-y-4" aria-label={`${service.name} connection`}>
                  <p className="text-13 text-ink-2">{service.description}</p>
                  <p className="text-13 text-ink-2">{mcpCatalogAuthHint(service, remote)}</p>
                  {service.auth === "token" && (
                    <label className={label}>
                      Personal access token
                      <input
                        ref={tokenInput}
                        type="password"
                        aria-label="Personal access token"
                        autoComplete="off"
                        spellCheck={false}
                        className={field}
                        value={token}
                        onChange={(event) => edit(setToken, event.target.value)}
                        disabled={busy}
                      />
                      <a href={service.tokenUrl} target="_blank" rel="noreferrer" className="inline-block text-12 text-ink underline">
                        Create a token on {service.name}
                      </a>
                    </label>
                  )}
                  <a href={service.docsUrl} target="_blank" rel="noreferrer" className="inline-block text-12 text-ink-2 underline">
                    {service.name} setup guide
                  </a>
                </section>
              ) : (
                <>
                  <div className="flex gap-1 rounded-[10px] bg-field p-[3px]">
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
                        className={`flex flex-1 items-center justify-center gap-1.5 rounded-[8px] py-1.5 text-[13px] disabled:opacity-40 ${kind === value ? "bg-surface font-medium text-ink shadow-card" : "text-ink-2"}`}
                      >
                        <HugeiconsIcon icon={value === "url" ? Globe02Icon : CommandLineIcon} size={14} strokeWidth={1.75} color="currentColor" />
                        {value === "url" ? "URL" : remote ? "Command (on the computer)" : "Command"}
                      </button>
                    ))}
                  </div>
                  <label className={label}>
                    Name
                    <input ref={nameInput} aria-label="Name" className={field} value={name} onChange={(event) => edit(setName, event.target.value)} />
                  </label>
                  {kind === "url" ? (
                    <label className={label}>
                      URL
                      <input aria-label="URL" className={field} placeholder="https://" value={url} onChange={(event) => edit(setUrl, event.target.value)} />
                      <span className="block font-normal text-ink-3">
                        {remote
                          ? "After adding, finish sign-in on the connected computer if needed."
                          : "If the server asks you to sign in, your browser opens after you add it."}
                      </span>
                    </label>
                  ) : (
                    <>
                      <label className={label}>
                        Command
                        <input
                          aria-label="Command"
                          className={field}
                          placeholder="npx"
                          value={command}
                          onChange={(event) => edit(setCommand, event.target.value)}
                        />
                      </label>
                      <label className={label}>
                        Arguments (optional)
                        <textarea
                          aria-label="Arguments"
                          rows={3}
                          className={`${field} resize-y font-mono text-[12.5px]`}
                          placeholder={"-y\n@scope/server"}
                          value={args}
                          onChange={(event) => edit(setArgs, event.target.value)}
                        />
                        <span className="block font-normal text-ink-3">One per line.</span>
                      </label>
                    </>
                  )}
                  <div className="space-y-1.5">
                    <span className="block text-[12px] font-medium text-ink-2">{kind === "url" ? "Headers (optional)" : "Environment (optional)"}</span>
                    {shown.map((pair, index) => (
                      <div key={index} className="flex gap-2">
                        <input
                          aria-label={kind === "url" ? "Header" : "Variable"}
                          className={`${pairField} w-[170px] shrink-0`}
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
                        <button
                          type="button"
                          aria-label={kind === "url" ? "Add a header" : "Add a variable"}
                          className={`flex size-9 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-surface text-ink-2 hover:bg-hover ${index === shown.length - 1 ? "" : "invisible"}`}
                          onClick={() => setPairs([...shown, EMPTY])}
                        >
                          <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={1.75} color="currentColor" />
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
              <fieldset disabled={busy} className="space-y-1.5">
                <legend className="mb-1.5 text-[12px] font-medium text-ink-2">Load it in</legend>
                <div className="divide-y divide-line rounded-[10px] border border-line">
                  {TARGETS.map((option) => (
                    <label key={option.value} className="flex min-h-11 cursor-pointer items-center gap-2.5 px-3">
                      <input
                        type="radio"
                        name="target"
                        className="size-4 shrink-0 cursor-pointer appearance-none rounded-full border border-line-strong bg-surface transition-[border] checked:border-[5px] checked:border-ink focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2"
                        checked={target === option.value}
                        onChange={() => setTarget(option.value)}
                      />
                      <span className={`flex-1 text-[13px] ${target === option.value ? "font-medium text-ink" : "text-ink-2"}`}>{option.label}</span>
                      <span className="text-[12px] text-ink-3">{option.hint}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {error && (
                <p role="alert" className="text-[12.5px] break-words text-red-ink">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  className={`${footerButton} border border-line-strong bg-surface font-medium text-ink hover:bg-hover`}
                  disabled={busy}
                  onClick={onClose}
                >
                  Cancel
                </button>
                <button type="submit" className={`${footerButton} bg-ink font-semibold text-surface hover:opacity-90`} disabled={busy}>
                  {busy ? "Saving…" : initial ? "Save" : kind === "url" && !remote && service?.auth !== "token" ? "Add and sign in" : "Add server"}
                </button>
              </div>
            </>
          )}
        </ScrollArea>
      </form>
    </dialog>,
    document.body,
  );
}
