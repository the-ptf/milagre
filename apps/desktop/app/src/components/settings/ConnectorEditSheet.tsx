import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { CONNECTOR_SECRET_MASK, connectorPreset, type ConnectorSummary, type ConnectorUpdate } from "@milagre/shared/connectors";
import { ScrollArea } from "../primitives/ScrollArea";
import { CommandFields, Secret, UrlExtras, field, footerButton, headersOf, label, type Pair } from "./ConnectorFields";

const masked = (names: string[] | undefined): Pair[] =>
  names?.length ? names.map((key) => ({ key, value: CONNECTOR_SECRET_MASK })) : [{ key: "", value: "" }];

/** What changed, as `connectors:update` takes it: masked values keep what is stored, an empty secret keeps the saved one. */
function patchOf(connector: ConnectorSummary, form: { name: string; clientId: string; clientSecret: string; command: string; args: string; pairs: Pair[] }) {
  const patch: ConnectorUpdate = {};
  if (form.name.trim() !== connector.name) patch.name = form.name.trim();
  if (connector.kind === "command") {
    const args = form.args.split("\n").filter((arg) => arg.trim() !== "");
    if (form.command.trim() !== connector.command || args.join("\n") !== (connector.args ?? []).join("\n"))
      Object.assign(patch, { command: form.command.trim(), args });
    patch.env = headersOf(form.pairs);
  } else {
    if (form.clientId.trim() !== (connector.clientId ?? "")) patch.clientId = form.clientId.trim();
    if (form.clientSecret) patch.clientSecret = form.clientSecret;
    patch.headers = headersOf(form.pairs);
  }
  return patch;
}

/** Edit a connector; for one that needs its own app it leads with the app's Client ID and secret, then signs in. */
export function ConnectorEditSheet({
  connector,
  onSave,
  onClose,
}: {
  connector: ConnectorSummary;
  onSave: (patch: ConnectorUpdate, signIn: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const preset = connectorPreset(connector);
  const needsApp = connector.state === "needs-app";
  const [name, setName] = useState(connector.name);
  const [clientId, setClientId] = useState(connector.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [command, setCommand] = useState(connector.command ?? "");
  const [args, setArgs] = useState((connector.args ?? []).join("\n"));
  const [pairs, setPairs] = useState<Pair[]>(masked(connector.kind === "command" ? connector.env : connector.headers));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const set = (setter: (value: string) => void) => (value: string) => {
    setError("");
    setter(value);
  };
  const submit = async () => {
    if (busy) return;
    if (needsApp && !clientId.trim()) return setError(`Paste the Client ID of your ${preset?.name ?? connector.name} app.`);
    setBusy(true);
    setError("");
    try {
      const patch = patchOf(connector, { name, clientId, clientSecret, command, args, pairs });
      await onSave(patch, connector.kind === "url" && (needsApp || patch.clientId !== undefined));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const title = needsApp ? `Add your ${preset?.name ?? connector.name} app` : `Edit ${connector.name}`;
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
        data-connector-edit
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
          {needsApp ? (
            <section data-connector-app className="space-y-3 rounded-card border border-line p-4">
              <p className="text-13 text-ink-2">
                {preset?.appSteps ??
                  `${connector.name} can't register Milagre by itself. Make an app for it on the service and paste its Client ID and Client Secret.`}
              </p>
              {preset?.appUrl && (
                <a href={preset.appUrl} target="_blank" rel="noreferrer" className="inline-block text-13 font-medium text-ink underline">
                  Create a {preset.name} app
                </a>
              )}
              <label className={label}>
                Client ID
                <input
                  autoFocus
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
          ) : (
            <label className={label}>
              Name
              <input autoFocus aria-label="Name" className={field} value={name} onChange={(event) => set(setName)(event.target.value)} />
            </label>
          )}
          {connector.kind === "command" ? (
            <CommandFields command={command} args={args} pairs={pairs} onCommand={set(setCommand)} onArgs={set(setArgs)} onPairs={setPairs} />
          ) : (
            !needsApp && (
              <>
                <p className="text-12 text-ink-3">
                  Address <span className="font-mono">{connector.url}</span>. To use another address, add a new connector.
                </p>
                <UrlExtras
                  pairs={pairs}
                  onPairs={setPairs}
                  clientId={clientId}
                  onClientId={set(setClientId)}
                  clientSecret={clientSecret}
                  onClientSecret={set(setClientSecret)}
                />
                {connector.hasClientSecret && <p className="text-12 text-ink-3">A Client Secret is saved. Leave the field empty to keep it.</p>}
              </>
            )
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
            <button type="submit" data-connector-save className={`${footerButton} bg-ink font-semibold text-surface hover:opacity-90`} disabled={busy}>
              {busy ? "Saving…" : needsApp ? "Save and sign in" : "Save"}
            </button>
          </div>
        </ScrollArea>
      </form>
    </dialog>,
    document.body,
  );
}
