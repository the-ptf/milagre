import { useState } from "react";
import { ArrowLeft01Icon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import {
  CONNECTOR_CALLBACK_URL,
  connectorPresetInput,
  type ConnectorInput,
  type ConnectorPreset,
  type ConnectorSummary,
  type EmailConnectInput,
} from "@milagre/shared/connectors";
import { emailSetupPrompt } from "@milagre/shared/email";
import { ipcErrorMessage } from "@milagre/shared/result";
import { Icon } from "../primitives/Icon";
import { ScrollArea } from "../primitives/ScrollArea";
import { Segmented } from "../primitives/Segmented";
import { requestDraftChat } from "../../lib/draft-chat-request";
import { CommandFields, Secret, UrlExtras, field, footerButton, headersOf, label, type Pair } from "./ConnectorFields";
import { ConnectorTile } from "./ConnectorTile";
import { EMPTY_EMAIL, EmailFields, emailInput, type EmailDraft } from "./EmailFields";

export type SetupHandlers = {
  onAdd: (input: ConnectorInput) => Promise<ConnectorSummary>;
  onLinear: () => Promise<void>;
  onEmail: (input: EmailConnectInput) => Promise<unknown>;
  onClose: () => void;
};

function RedirectUrl() {
  const [copied, setCopied] = useState(false);
  return (
    <div className={label}>
      Redirect URL
      <span className="flex items-center gap-2">
        <code className={`${field} min-w-0 flex-1 truncate font-mono text-12 leading-[34px] text-ink-2`}>{CONNECTOR_CALLBACK_URL}</code>
        <button
          type="button"
          aria-label="Copy redirect URL"
          className="flex size-9 shrink-0 items-center justify-center rounded-control text-ink-3 hover:bg-hover"
          onClick={() => {
            void navigator.clipboard.writeText(CONNECTOR_CALLBACK_URL);
            setCopied(true);
          }}
        >
          <Icon icon={copied ? Tick02Icon : Copy01Icon} size={16} />
        </button>
      </span>
    </div>
  );
}

/** How a preset signs in: its token, OAuth app or command environment, and what happens when you press Add. */
function PresetFields({ preset, values, set }: { preset: ConnectorPreset; values: Record<string, string>; set: (key: string) => (value: string) => void }) {
  if (preset.auth === "token")
    return (
      <>
        <Secret name="Access token" value={values.token ?? ""} onChange={set("token")} />
        {preset.tokenUrl && (
          <a href={preset.tokenUrl} target="_blank" rel="noreferrer" className="inline-block text-12 font-medium text-accent-ink hover:underline">
            Create a token on {preset.name}
          </a>
        )}
      </>
    );
  if (preset.auth === "app")
    return (
      <section data-connector-app className="space-y-3 rounded-card border border-line p-4">
        <p className="text-13 text-ink-2">{preset.appSteps}</p>
        {preset.appUrl && (
          <a
            href={preset.appUrl}
            target="_blank"
            rel="noreferrer"
            data-connector-create-app
            className="inline-block text-13 font-medium text-accent-ink hover:underline"
          >
            Create a {preset.name} app
          </a>
        )}
        {preset.id !== "slack" && <RedirectUrl />}
        <label className={label}>
          Client ID
          <input
            aria-label="Client ID"
            autoComplete="off"
            spellCheck={false}
            className={field}
            value={values.clientId ?? ""}
            onChange={(event) => set("clientId")(event.target.value)}
          />
        </label>
        <Secret name="Client Secret" value={values.clientSecret ?? ""} onChange={set("clientSecret")} />
      </section>
    );
  if (preset.command)
    return (
      <>
        {preset.command.env.map((variable) =>
          variable.secret ? (
            <Secret key={variable.name} name={variable.label} value={values[variable.name] ?? ""} onChange={set(variable.name)} />
          ) : (
            <label key={variable.name} className={label}>
              {variable.label}
              <input
                aria-label={variable.label}
                autoComplete="off"
                spellCheck={false}
                placeholder={variable.placeholder}
                className={field}
                value={values[variable.name] ?? ""}
                onChange={(event) => set(variable.name)(event.target.value)}
              />
            </label>
          ),
        )}
        <p className="text-12 text-ink-3">
          {preset.command.note} It runs <code className="font-mono">{[preset.command.command, ...preset.command.args].join(" ")}</code>.
        </p>
      </>
    );
  return <p className="text-13 text-ink-2">Your browser opens to sign in to {preset.name}. Choose the account and the access to allow.</p>;
}

/** A custom connector: an address with optional headers or OAuth app, or a command with arguments and environment. */
function CustomFields({
  kind,
  onKind,
  values,
  set,
  pairs,
  onPairs,
}: {
  kind: "url" | "command";
  onKind: (kind: "url" | "command") => void;
  values: Record<string, string>;
  set: (key: string) => (value: string) => void;
  pairs: Pair[];
  onPairs: (pairs: Pair[]) => void;
}) {
  return (
    <>
      <Segmented
        label="Starts from"
        dataKey="connector-kind"
        value={kind}
        options={[
          { value: "url", label: "Address" },
          { value: "command", label: "Command" },
        ]}
        onChange={onKind}
      />
      {kind === "url" ? (
        <>
          <label className={label}>
            Address
            <input
              aria-label="Address"
              className={field}
              placeholder="https://"
              value={values.url ?? ""}
              onChange={(event) => set("url")(event.target.value)}
            />
          </label>
          <UrlExtras
            pairs={pairs}
            onPairs={onPairs}
            clientId={values.clientId ?? ""}
            onClientId={set("clientId")}
            clientSecret={values.clientSecret ?? ""}
            onClientSecret={set("clientSecret")}
          />
        </>
      ) : (
        <CommandFields
          command={values.command ?? ""}
          args={values.args ?? ""}
          pairs={pairs}
          onCommand={set("command")}
          onArgs={set("args")}
          onPairs={onPairs}
        />
      )}
    </>
  );
}

const submitLabel = (preset: ConnectorPreset | null, kind: "url" | "command") => {
  if (preset?.auth === "email") return "Add mailbox";
  if (preset?.id === "linear") return "Sign in to Linear";
  if (preset?.auth === "token" || preset?.auth === "command" || (!preset && kind === "command")) return "Add connector";
  return "Add and sign in";
};

/** The form for one service (or a custom connector when `preset` is null), inside Add connector. Key it by the preset so its fields reset. */
export function ConnectorSetup({ preset, onBack, handlers }: { preset: ConnectorPreset | null; onBack: () => void; handlers: SetupHandlers }) {
  const [values, setValues] = useState<Record<string, string>>({ name: preset?.name ?? "" });
  const [linearMcp, setLinearMcp] = useState(false);
  const [mailbox, setMailbox] = useState<EmailDraft>(EMPTY_EMAIL);
  const [kind, setKind] = useState<"url" | "command">("url");
  const [pairs, setPairs] = useState<Pair[]>([{ key: "", value: "" }]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (key: string) => (value: string) => {
    setError("");
    setValues((current) => ({ ...current, [key]: value }));
  };
  const builtInLinear = preset?.id === "linear" && !linearMcp;
  const builtInEmail = preset?.auth === "email";
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      handlers.onClose();
    } catch (cause) {
      setError(ipcErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (busy) return;
    if (builtInEmail) return run(() => handlers.onEmail(emailInput(mailbox)));
    if (builtInLinear) return run(handlers.onLinear);
    let input: ConnectorInput;
    try {
      const name = (values.name ?? "").trim();
      input = preset
        ? connectorPresetInput(preset, {
            name,
            token: values.token,
            clientId: values.clientId,
            clientSecret: values.clientSecret,
            region: values.region,
            env: values,
          })
        : kind === "command"
          ? { name, command: (values.command ?? "").trim(), args: (values.args ?? "").split("\n").filter((arg) => arg.trim() !== ""), env: headersOf(pairs) }
          : {
              name,
              url: (values.url ?? "").trim(),
              headers: headersOf(pairs),
              ...(values.clientId?.trim() ? { clientId: values.clientId.trim() } : {}),
              ...(values.clientSecret ? { clientSecret: values.clientSecret } : {}),
            };
    } catch (cause) {
      return setError(ipcErrorMessage(cause));
    }
    return run(() => handlers.onAdd(input));
  };
  const shown = linearMcp && preset ? { ...preset, auth: "browser" as const } : preset;
  return (
    <form
      data-connector-setup={preset?.id ?? "custom"}
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <ScrollArea className="min-h-0 flex-1 space-y-4 px-6 pt-5 pb-4">
        <button
          type="button"
          data-connector-back
          disabled={busy}
          className="-ml-2 flex h-7 items-center gap-1 rounded-control px-2 text-12 font-medium text-ink-2 hover:bg-hover disabled:opacity-40"
          onClick={onBack}
        >
          <Icon icon={ArrowLeft01Icon} size={14} />
          All services
        </button>
        <div className="flex items-center gap-3">
          <ConnectorTile size="lg" iconPath={preset?.iconPath} letter={preset?.name} mail={builtInEmail} command={!preset || preset.auth === "command"} />
          <div className="min-w-0">
            <h3 className="text-15 font-semibold text-ink">{builtInEmail ? "Add mailbox" : preset ? preset.name : "Custom connector"}</h3>
            <p className="text-12 text-ink-2">{preset ? preset.description : "Any MCP server, by its https address or the command that starts it."}</p>
          </div>
        </div>
        {builtInEmail && (
          <EmailFields
            draft={mailbox}
            onConfigure={() => {
              requestDraftChat(emailSetupPrompt(mailbox.address));
              handlers.onClose();
            }}
            onChange={(next) => {
              setError("");
              setMailbox(next);
            }}
          />
        )}
        {builtInLinear && (
          <div className="space-y-2">
            <p className="text-13 text-ink-2">
              Linear signs in with Milagre's own Linear app: Chats can start from issues, Worktrees show their issue, Routines follow Linear, and agents get its
              tools.
            </p>
            <button
              type="button"
              data-connector-linear-mcp
              className="text-12 font-medium text-accent-ink hover:underline"
              onClick={() => {
                setLinearMcp(true);
                setValues((current) => ({ ...current, name: "Linear MCP" }));
              }}
            >
              Use Linear's MCP server instead
            </button>
          </div>
        )}
        {!builtInEmail && !builtInLinear && (
          <label className={label}>
            Name
            <input autoFocus aria-label="Name" className={field} value={values.name ?? ""} onChange={(event) => set("name")(event.target.value)} />
            <span className="block font-normal text-ink-3">Name each workspace, like Slack company A. Agents see it with the tools.</span>
          </label>
        )}
        {shown?.regions && (
          <div className={label}>
            Region
            <Segmented
              label="Region"
              dataKey="connector-region"
              value={values.region ?? shown.regions[0]?.label ?? ""}
              options={shown.regions.map((region) => ({ value: region.label, label: region.label }))}
              onChange={set("region")}
            />
          </div>
        )}
        {shown && !builtInEmail && !builtInLinear && <PresetFields preset={shown} values={values} set={set} />}
        {!preset && (
          <CustomFields
            kind={kind}
            onKind={(value) => {
              setKind(value);
              setPairs([{ key: "", value: "" }]);
              setError("");
            }}
            values={values}
            set={set}
            pairs={pairs}
            onPairs={setPairs}
          />
        )}
        {error && (
          <p role="alert" className="text-12 break-words text-red-ink">
            {error}
          </p>
        )}
      </ScrollArea>
      <div className="flex shrink-0 justify-end gap-2 border-t border-line px-6 py-3">
        <button
          type="button"
          className={`${footerButton} border border-line-strong bg-surface font-medium text-ink hover:bg-hover`}
          disabled={busy}
          onClick={handlers.onClose}
        >
          Cancel
        </button>
        <button type="submit" data-connector-submit className={`${footerButton} bg-ink font-semibold text-surface hover:opacity-90`} disabled={busy}>
          {busy ? (builtInEmail ? "Checking…" : "Adding…") : submitLabel(linearMcp && shown ? { ...shown, id: "linear_mcp" } : preset, kind)}
        </button>
      </div>
    </form>
  );
}
