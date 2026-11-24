import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { connectorPresetInput, searchConnectorPresets, type ConnectorInput, type ConnectorPreset, type ConnectorSummary } from "@milagre/shared/connectors";
import { ScrollArea } from "../primitives/ScrollArea";
import { ConnectorTile } from "./ConnectorTile";

type Pair = { key: string; value: string };
const field = "w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-13 text-ink outline-none";
const pairField = "min-w-0 rounded-control border border-transparent bg-field px-3 py-2 text-13 text-ink outline-none placeholder:text-ink-3";
const footerButton = "rounded-control px-4 py-2 text-13 transition-colors disabled:opacity-40";
const label = "block space-y-1.5 text-12 font-medium text-ink-2";
const authLabel = (preset: ConnectorPreset) => (preset.auth === "token" ? "Token" : preset.auth === "app" ? "Your app" : "Sign in");
const headersOf = (pairs: Pair[]) => Object.fromEntries(pairs.filter((pair) => pair.key.trim() && pair.value).map((pair) => [pair.key.trim(), pair.value]));

function Catalog({ onChoose, onCustom }: { onChoose: (preset: ConnectorPreset) => void; onCustom: () => void }) {
  const [search, setSearch] = useState("");
  const found = searchConnectorPresets(search);
  return (
    <div data-connector-catalog className="space-y-4">
      <p className="text-13 text-ink-2">Choose a service, or add any MCP server with an address.</p>
      <input
        autoFocus
        aria-label="Search services"
        placeholder="Search services"
        className={field}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="divide-y divide-line overflow-hidden rounded-card border border-line">
        {found.map((preset) => (
          <button
            key={preset.id}
            type="button"
            data-connector-service={preset.id}
            onClick={() => onChoose(preset)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-hover active:bg-hover-2"
          >
            <ConnectorTile iconPath={preset.iconPath} />
            <span className="min-w-0 flex-1">
              <span className="block text-13 font-semibold text-ink">{preset.name}</span>
              <span className="block text-12 text-ink-2">{preset.description}</span>
            </span>
            <span className="shrink-0 text-11 text-ink-3">{authLabel(preset)}</span>
          </button>
        ))}
      </div>
      {found.length === 0 && (
        <p role="status" className="text-13 text-ink-2">
          No matching services. Add a custom connector with its address.
        </p>
      )}
      <button
        type="button"
        data-connector-custom
        onClick={onCustom}
        className="flex w-full items-center gap-3 rounded-control border border-line-strong px-4 py-3 text-left transition-colors hover:bg-hover"
      >
        <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.8} />
        <span>
          <span className="block text-13 font-medium">Custom connector</span>
          <span className="block text-12 text-ink-2">Any MCP server with an https address.</span>
        </span>
      </button>
    </div>
  );
}

function Secret({ name, value, onChange }: { name: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className={label}>
      {name}
      <input
        type="password"
        aria-label={name}
        autoComplete="off"
        spellCheck={false}
        className={field}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function ConnectorSheet({ onAdd, onClose }: { onAdd: (input: ConnectorInput) => Promise<ConnectorSummary>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<"choose" | "preset" | "custom">("choose");
  const [preset, setPreset] = useState<ConnectorPreset | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [pairs, setPairs] = useState<Pair[]>([{ key: "", value: "" }]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const set = (setter: (value: string) => void) => (value: string) => {
    setError("");
    setter(value);
  };
  const choose = (next: ConnectorPreset | null) => {
    setPreset(next);
    setStep(next ? "preset" : "custom");
    setName(next?.name ?? "");
    setUrl("");
    setToken("");
    setClientId("");
    setClientSecret("");
    setPairs([{ key: "", value: "" }]);
    setError("");
  };
  const submit = async () => {
    if (step === "choose" || busy) return;
    let input: ConnectorInput;
    try {
      input = preset
        ? connectorPresetInput(preset, { name: name.trim(), token, clientId, clientSecret })
        : {
            name: name.trim(),
            url: url.trim(),
            headers: headersOf(pairs),
            ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
            ...(clientSecret ? { clientSecret } : {}),
          };
    } catch (cause) {
      return setError(cause instanceof Error ? cause.message : String(cause));
    }
    setBusy(true);
    setError("");
    try {
      await onAdd(input);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const title = step === "choose" ? "Add connector" : preset ? `Add ${preset.name}` : "Custom connector";
  const shown = pairs.length ? pairs : [{ key: "", value: "" }];
  return createPortal(
    <dialog
      ref={dialog}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onMouseDown={(event) => !busy && event.target === dialog.current && onClose()}
      className="m-auto w-[520px] max-w-[calc(100vw-32px)] overflow-visible rounded-window bg-surface p-0 text-ink shadow-overlay backdrop:bg-black/20 backdrop:backdrop-blur-overlay"
    >
      <form
        data-connector-sheet
        className="flex max-h-[calc(100dvh-64px)] flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex shrink-0 items-center justify-between px-6 pt-6 pb-4">
          <h2 className="text-17 font-semibold text-ink">{title}</h2>
          <button type="button" aria-label="Close" disabled={busy} className="rounded-chip p-1 text-ink-2 hover:bg-hover" onClick={onClose}>
            <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.75} color="currentColor" />
          </button>
        </div>
        <ScrollArea className="space-y-4 px-6 pb-6">
          {step === "choose" ? (
            <Catalog onChoose={choose} onCustom={() => choose(null)} />
          ) : (
            <>
              <button
                type="button"
                data-connector-back
                disabled={busy}
                className="text-12 font-medium text-ink-2 hover:underline disabled:opacity-40"
                onClick={() => setStep("choose")}
              >
                All services
              </button>
              {preset && <p className="text-13 text-ink-2">{preset.description}</p>}
              <label className={label}>
                Name
                <input autoFocus aria-label="Name" className={field} value={name} onChange={(event) => set(setName)(event.target.value)} />
                <span className="block font-normal text-ink-3">Name each workspace, like Slack company A. Agents see it with the tools.</span>
              </label>
              {!preset && (
                <label className={label}>
                  Address
                  <input aria-label="Address" className={field} placeholder="https://" value={url} onChange={(event) => set(setUrl)(event.target.value)} />
                </label>
              )}
              {preset?.auth === "token" && (
                <>
                  <Secret name="Personal access token" value={token} onChange={set(setToken)} />
                  {preset.tokenUrl && (
                    <a href={preset.tokenUrl} target="_blank" rel="noreferrer" className="inline-block text-12 text-ink underline">
                      Create a token on {preset.name}
                    </a>
                  )}
                </>
              )}
              {preset?.auth === "app" && (
                <section data-connector-app className="space-y-3 rounded-card border border-line p-4">
                  <p className="text-13 text-ink-2">{preset.appSteps}</p>
                  {preset.appUrl && (
                    <a
                      href={preset.appUrl}
                      target="_blank"
                      rel="noreferrer"
                      data-connector-create-app
                      className="inline-block text-13 font-medium text-ink underline"
                    >
                      Create a {preset.name} app
                    </a>
                  )}
                  <label className={label}>
                    Client ID
                    <input
                      aria-label="Client ID"
                      autoComplete="off"
                      spellCheck={false}
                      className={field}
                      value={clientId}
                      onChange={(event) => set(setClientId)(event.target.value)}
                    />
                  </label>
                  <Secret name="Client Secret" value={clientSecret} onChange={set(setClientSecret)} />
                </section>
              )}
              {preset?.auth === "browser" && (
                <p className="text-13 text-ink-2">Your browser opens to sign in to {preset.name}. Choose the account and the access to allow.</p>
              )}
              {!preset && (
                <details className="space-y-3">
                  <summary className="cursor-pointer text-12 font-medium text-ink-2">Headers and OAuth app (optional)</summary>
                  <div className="space-y-1 pt-3">
                    <span className="block text-12 font-medium text-ink-2">Headers, for servers that take an API key</span>
                    {shown.map((pair, index) => (
                      <div key={index} className="flex gap-2">
                        <input
                          aria-label="Header"
                          className={`${pairField} w-[170px] shrink-0`}
                          placeholder="Header"
                          value={pair.key}
                          onChange={(event) => setPairs(Object.assign([...shown], { [index]: { ...pair, key: event.target.value } }))}
                        />
                        <input
                          aria-label="Value"
                          type="password"
                          className={`${pairField} flex-1`}
                          placeholder="Value"
                          value={pair.value}
                          onChange={(event) => setPairs(Object.assign([...shown], { [index]: { ...pair, value: event.target.value } }))}
                        />
                        <button
                          type="button"
                          aria-label="Add a header"
                          className={`flex size-9 shrink-0 items-center justify-center rounded-control border border-line-strong bg-surface text-ink-2 hover:bg-hover ${index === shown.length - 1 ? "" : "invisible"}`}
                          onClick={() => setPairs([...shown, { key: "", value: "" }])}
                        >
                          <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={1.75} color="currentColor" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="text-12 text-ink-3">
                    Only for a server that can't register Milagre by itself: the client ID and secret of the app you made for it.
                  </p>
                  <label className={label}>
                    Client ID
                    <input
                      aria-label="Client ID"
                      autoComplete="off"
                      spellCheck={false}
                      className={field}
                      value={clientId}
                      onChange={(event) => set(setClientId)(event.target.value)}
                    />
                  </label>
                  <Secret name="Client Secret" value={clientSecret} onChange={set(setClientSecret)} />
                </details>
              )}
              {error && (
                <p role="alert" className="text-12 break-words text-red-ink">
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
                <button type="submit" data-connector-submit className={`${footerButton} bg-ink font-semibold text-surface hover:opacity-90`} disabled={busy}>
                  {busy ? "Adding…" : preset?.auth === "token" ? "Add connector" : "Add and sign in"}
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
