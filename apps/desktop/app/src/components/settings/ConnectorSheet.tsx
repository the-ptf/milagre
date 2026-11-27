import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import {
  EMAIL_PRESET,
  connectorPresetInput,
  searchConnectorPresets,
  type ConnectorInput,
  type ConnectorPreset,
  type ConnectorSummary,
  type EmailConnectInput,
} from "@milagre/shared/connectors";
import { ipcErrorMessage } from "@milagre/shared/result";
import { ScrollArea } from "../primitives/ScrollArea";
import { Segmented } from "../primitives/Segmented";
import { ConnectorTile } from "./ConnectorTile";
import { EMPTY_EMAIL, EmailFields, emailInput, type EmailDraft } from "./EmailFields";
import { emailSetupPrompt } from "@milagre/shared/email";
import { requestDraftChat } from "../../lib/draft-chat-request";

import { CommandFields, Secret, UrlExtras, field, footerButton, headersOf, label, type Pair } from "./ConnectorFields";

const authLabel = (preset: ConnectorPreset) =>
  preset.auth === "token" ? "Token" : preset.auth === "app" ? "Your app" : preset.auth === "email" ? "App password" : "Sign in";

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
            <ConnectorTile iconPath={preset.iconPath} mail={preset.auth === "email"} />
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
          <span className="block text-12 text-ink-2">Any MCP server, by its https address or the command that starts it.</span>
        </span>
      </button>
    </div>
  );
}

function LinearChoice({ onMcp }: { onMcp: () => void }) {
  return (
    <div className="space-y-2">
      <p className="text-13 text-ink-2">
        Linear signs in with Milagre's own Linear app: Chats can start from issues, Worktrees show their issue, Routines follow Linear, and agents get its
        tools.
      </p>
      <button type="button" data-connector-linear-mcp className="text-12 font-medium text-ink-2 hover:underline" onClick={onMcp}>
        Use Linear's MCP server instead
      </button>
    </div>
  );
}

/** The token or OAuth app fields a preset signs in with. */
function PresetAuth({
  preset,
  token,
  onToken,
  clientId,
  onClientId,
  clientSecret,
  onClientSecret,
}: {
  preset: ConnectorPreset;
  token: string;
  onToken: (value: string) => void;
  clientId: string;
  onClientId: (value: string) => void;
  clientSecret: string;
  onClientSecret: (value: string) => void;
}) {
  return (
    <>
      {preset.auth === "token" && (
        <>
          <Secret name="Personal access token" value={token} onChange={onToken} />
          {preset.tokenUrl && (
            <a href={preset.tokenUrl} target="_blank" rel="noreferrer" className="inline-block text-12 text-ink underline">
              Create a token on {preset.name}
            </a>
          )}
        </>
      )}
      {preset.auth === "app" && (
        <section data-connector-app className="space-y-3 rounded-card border border-line p-4">
          <p className="text-13 text-ink-2">{preset.appSteps}</p>
          {preset.appUrl && (
            <a href={preset.appUrl} target="_blank" rel="noreferrer" data-connector-create-app className="inline-block text-13 font-medium text-ink underline">
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
              onChange={(event) => onClientId(event.target.value)}
            />
          </label>
          <Secret name="Client Secret" value={clientSecret} onChange={onClientSecret} />
        </section>
      )}
    </>
  );
}

export function ConnectorSheet({
  onAdd,
  onLinear,
  onEmail,
  email = false,
  onClose,
}: {
  onAdd: (input: ConnectorInput) => Promise<ConnectorSummary>;
  /** Milagre's own Linear sign-in, which the Linear preset uses instead of Linear's MCP server. */
  onLinear: () => Promise<void>;
  /** Milagre's own Email connector: checks the mailbox's sign-in, then saves it. */
  onEmail: (input: EmailConnectInput) => Promise<unknown>;
  /** Opens straight on the Email form, from the Email row's Add mailbox. */
  email?: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<"choose" | "preset" | "custom">(email ? "preset" : "choose");
  const [preset, setPreset] = useState<ConnectorPreset | null>(email ? EMAIL_PRESET : null);
  const [mailbox, setMailbox] = useState<EmailDraft>(EMPTY_EMAIL);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<"url" | "command">("url");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
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
    setMailbox(EMPTY_EMAIL);
    setError("");
  };
  const builtInLinear = preset?.id === "linear";
  const builtInEmail = preset?.auth === "email";
  const submit = async () => {
    if (step === "choose" || busy) return;
    if (builtInLinear || builtInEmail) {
      setBusy(true);
      setError("");
      try {
        if (builtInEmail) await onEmail(emailInput(mailbox));
        else await onLinear();
        onClose();
      } catch (cause) {
        setError(ipcErrorMessage(cause));
      } finally {
        setBusy(false);
      }
      return;
    }
    let input: ConnectorInput;
    try {
      input = preset
        ? connectorPresetInput(preset, { name: name.trim(), token, clientId, clientSecret })
        : kind === "command"
          ? { name: name.trim(), command: command.trim(), args: args.split("\n").filter((arg) => arg.trim() !== ""), env: headersOf(pairs) }
          : {
              name: name.trim(),
              url: url.trim(),
              headers: headersOf(pairs),
              ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
              ...(clientSecret ? { clientSecret } : {}),
            };
    } catch (cause) {
      return setError(ipcErrorMessage(cause));
    }
    setBusy(true);
    setError("");
    try {
      await onAdd(input);
      onClose();
    } catch (cause) {
      setError(ipcErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const title = step === "choose" ? "Add connector" : builtInEmail ? "Add mailbox" : preset ? `Add ${preset.name}` : "Custom connector";
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
              {builtInEmail && (
                <EmailFields
                  onConfigure={() => {
                    requestDraftChat(emailSetupPrompt(mailbox.address));
                    onClose();
                  }}
                  draft={mailbox}
                  onChange={(next) => {
                    setError("");
                    setMailbox(next);
                  }}
                />
              )}
              {!builtInLinear && !builtInEmail && (
                <label className={label}>
                  Name
                  <input autoFocus aria-label="Name" className={field} value={name} onChange={(event) => set(setName)(event.target.value)} />
                  <span className="block font-normal text-ink-3">Name each workspace, like Slack company A. Agents see it with the tools.</span>
                </label>
              )}
              {!preset && (
                <Segmented
                  label="Starts from"
                  dataKey="connector-kind"
                  value={kind}
                  options={[
                    { value: "url", label: "Address" },
                    { value: "command", label: "Command" },
                  ]}
                  onChange={(value) => {
                    setKind(value);
                    setPairs([{ key: "", value: "" }]);
                    setError("");
                  }}
                />
              )}
              {!preset && kind === "url" && (
                <label className={label}>
                  Address
                  <input aria-label="Address" className={field} placeholder="https://" value={url} onChange={(event) => set(setUrl)(event.target.value)} />
                </label>
              )}
              {!preset && kind === "command" && (
                <CommandFields command={command} args={args} pairs={pairs} onCommand={set(setCommand)} onArgs={set(setArgs)} onPairs={setPairs} />
              )}
              {preset && (
                <PresetAuth
                  preset={preset}
                  token={token}
                  onToken={set(setToken)}
                  clientId={clientId}
                  onClientId={set(setClientId)}
                  clientSecret={clientSecret}
                  onClientSecret={set(setClientSecret)}
                />
              )}
              {builtInLinear ? (
                <LinearChoice
                  onMcp={() => {
                    choose(null);
                    setName("Linear MCP");
                    setUrl(preset.url);
                  }}
                />
              ) : (
                preset?.auth === "browser" && (
                  <p className="text-13 text-ink-2">Your browser opens to sign in to {preset.name}. Choose the account and the access to allow.</p>
                )
              )}
              {!preset && kind === "url" && (
                <UrlExtras
                  pairs={pairs}
                  onPairs={setPairs}
                  clientId={clientId}
                  onClientId={set(setClientId)}
                  clientSecret={clientSecret}
                  onClientSecret={set(setClientSecret)}
                />
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
                  {busy
                    ? builtInEmail
                      ? "Checking…"
                      : "Adding…"
                    : builtInEmail
                      ? "Add mailbox"
                      : builtInLinear
                        ? "Sign in to Linear"
                        : preset?.auth === "token" || (!preset && kind === "command")
                          ? "Add connector"
                          : "Add and sign in"}
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
