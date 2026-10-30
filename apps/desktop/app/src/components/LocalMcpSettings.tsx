import { Fragment, useState } from "react";
import {
  emptyLocalMcpDraft,
  localMcpClientConfig,
  localMcpClientDetail,
  localMcpConfiguration,
  localMcpDescription,
  localMcpDraftFor,
  localMcpDraftValid,
  localMcpReadOnly,
  setLocalMcpDraftKind,
  toggleLocalMcpDraftProject,
  type LocalMcpClient,
  type LocalMcpDraft,
  type LocalMcpStatus,
} from "@milagre/shared/local-mcp";
import { useLocalMcp } from "@milagre/shared/use-local-mcp";
import type { MilagreBridge } from "../electron";
import { ScrollArea } from "./primitives/ScrollArea";
import { Checkbox } from "./primitives/Checkbox";
import { RadioGroup, RadioGroupItem } from "./primitives/RadioGroup";

const buttonBase =
  "rounded-lg border border-line px-3 py-2 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green disabled:opacity-50 disabled:cursor-default";
const button = `${buttonBase} text-ink hover:bg-hover`;
const input = "mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink focus-visible:outline-2 focus-visible:outline-green";

export function LocalMcpSettings({ bridge }: { bridge: MilagreBridge }) {
  const local = useLocalMcp(bridge.localMcp);
  const [setup, setSetup] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyLocalMcpDraft);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const custom = local.status?.connections.filter((c) => !c.clientId) ?? [];
  const open = (client?: LocalMcpClient) => {
    local.dismiss();
    setCopied(false);
    setCopyError(false);
    setSetup(client?.id ?? "custom");
    setDraft(client?.connection ? localMcpDraftFor(client.connection) : { ...emptyLocalMcpDraft(), label: client?.label ?? "" });
  };
  const submit = async (client?: LocalMcpClient) => {
    const config = { ...localMcpConfiguration(draft), ...(client?.connection?.expiresAt ? { expiresAt: client.connection.expiresAt } : {}) };
    const saved = client ? await local.enableClient(client.id, config) : await local.create(config);
    if (saved) setSetup(null);
  };
  const editor = (client?: LocalMcpClient) =>
    local.status && (
      <form
        data-local-setup
        className="space-y-4 bg-hover px-4 py-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(client);
        }}
      >
        <h3 className="text-[13px] font-medium text-ink">{client ? `Access for ${client.label}` : "Custom connection"}</h3>
        {!client && (
          <label className="block text-[12px] text-ink-2">
            Connection name
            <input
              autoFocus
              aria-label="Connection name"
              className={input}
              value={draft.label}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            />
          </label>
        )}
        <ScopeFields draft={draft} onChange={setDraft} status={local.status} />
        <div className="flex gap-2">
          <button type="submit" className={`${buttonBase} bg-ink text-surface hover:opacity-90`} disabled={local.busy || !localMcpDraftValid(draft)}>
            {local.busy ? "Saving..." : client ? (client.enabled ? "Save access" : `Enable ${client.label}`) : "Create configuration"}
          </button>
          <button type="button" className={button} disabled={local.busy} onClick={() => setSetup(null)}>
            Cancel
          </button>
        </div>
      </form>
    );
  return (
    <section data-local-mcp className="mt-5 space-y-6">
      <p className="max-w-prose text-[13px] leading-relaxed text-ink-2">
        Connect your local tools to Milagre. Choose which Projects or Designs each app can access when you enable it.
      </p>
      {local.error && (
        <p role="alert" className="text-[13px] text-red-ink">
          {local.error}
        </p>
      )}
      {!local.status && !local.error && (
        <p role="status" className="text-[13px] text-ink-2">
          Loading client settings...
        </p>
      )}
      <div className="divide-y divide-line" aria-busy={local.busy}>
        {(local.status?.clients ?? []).map((client) => (
          <Fragment key={client.id}>
            <div data-local-client={client.id} className="flex min-h-14 items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-ink">{client.label}</p>
                {localMcpClientDetail(client) && (
                  <p className={`mt-1 break-words text-[12px] leading-relaxed ${client.problem ? "text-red-ink" : "text-ink-2"}`}>
                    {localMcpClientDetail(client)}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {(client.enabled || client.state === "error") && (
                  <button
                    type="button"
                    className="rounded px-1 py-2 text-[12px] text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-green"
                    disabled={local.busy}
                    onClick={() => open(client)}
                  >
                    Set up
                  </button>
                )}
                <McpCheckbox
                  label={`Enable ${client.label}`}
                  checked={client.enabled}
                  expanded={setup === client.id}
                  disabled={local.busy || client.state === "unavailable"}
                  onClick={() => {
                    if (client.enabled) {
                      setSetup(null);
                      void local.disableClient(client.id);
                    } else if (setup === client.id) setSetup(null);
                    else open(client);
                  }}
                />
              </div>
            </div>
            {setup === client.id && editor(client)}
          </Fragment>
        ))}
      </div>
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-prose text-[12px] leading-relaxed text-ink-2">
          Enabled clients are set up when Milagre starts. Restart a client after enabling it; scope changes apply at once. Access stays on the computer running
          Milagre.
        </p>
        <button
          type="button"
          className="shrink-0 rounded py-1 text-[12px] text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-green"
          disabled={local.busy}
          onClick={() => void local.refresh()}
        >
          Refresh
        </button>
      </div>
      <div className="space-y-3 border-t border-line pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-[13px] font-medium text-ink">Custom MCP</h3>
          <McpCheckbox
            label="Custom MCP"
            checked={customOpen}
            expanded={customOpen}
            controls="custom-mcp-settings"
            disabled={local.busy || !local.status}
            onClick={() => {
              setCustomOpen(!customOpen);
              if (customOpen) {
                if (setup === "custom") setSetup(null);
                local.dismiss();
              } else if (!custom.length) open();
            }}
          />
        </div>
        {customOpen && (
          <div id="custom-mcp-settings" className="space-y-3">
            <p className="text-[12px] leading-relaxed text-ink-2">For another app, create a scoped connection and copy its configuration.</p>
            {setup !== "custom" && !local.credential && (
              <button type="button" className={button} disabled={local.busy || !local.status} onClick={() => open()}>
                Create MCP config
              </button>
            )}
            {setup === "custom" && editor()}
            {local.credential && (
              <div data-local-credential className="space-y-3 py-2">
                <p className="text-[12px] text-ink-2">Copy this configuration now. The credential is available only once.</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={button}
                    onClick={() =>
                      void navigator.clipboard.writeText(localMcpClientConfig(local.credential!)).then(
                        () => {
                          setCopied(true);
                          setCopyError(false);
                        },
                        () => setCopyError(true),
                      )
                    }
                  >
                    {copied ? "Copied" : "Copy MCP config"}
                  </button>
                  <button type="button" className={button} onClick={local.dismiss}>
                    Done
                  </button>
                </div>
                {copyError && (
                  <p role="alert" className="text-[12px] text-red-ink">
                    Could not copy. Try again before closing this configuration.
                  </p>
                )}
              </div>
            )}
            {custom.length > 0 && (
              <details>
                <summary className="cursor-pointer py-2 text-[12px] text-ink-2">Manage custom connections ({custom.length})</summary>
                <ScrollArea chainScroll className="max-h-64 divide-y divide-line">
                  {custom.map((connection) => {
                    const active = !connection.revokedAt && !(connection.expiresAt && Date.parse(connection.expiresAt) <= local.checkedAt);
                    const writable = Object.values(connection.grants).some((scope) => scope.capabilities.some((cap) => cap !== "read"));
                    return (
                      <div key={connection.id} data-local-connection className="space-y-2 py-3">
                        <p className="text-[13px] text-ink">
                          {connection.label}
                          {connection.revokedAt ? " (Revoked)" : !active ? " (Expired)" : ""}
                        </p>
                        <p className="break-words text-[12px] text-ink-2">{localMcpDescription(connection)}</p>
                        {active && (
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              className={button}
                              disabled={local.busy}
                              onClick={() => {
                                setCopied(false);
                                setCopyError(false);
                                void local.rotate(connection.id);
                              }}
                            >
                              Replace credential
                            </button>
                            {writable && (
                              <button
                                type="button"
                                className={button}
                                disabled={local.busy}
                                onClick={() => void local.update(connection.id, localMcpReadOnly(connection))}
                              >
                                Restrict to read
                              </button>
                            )}
                            <button type="button" className={button} disabled={local.busy} onClick={() => void local.revoke(connection.id)}>
                              Revoke
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </ScrollArea>
              </details>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
const scopeKindLabel = (kind: LocalMcpDraft["kind"]) => (kind === "projects" ? "Projects" : kind === "all-projects" ? "All Projects" : "Designs only");
function ScopeFields({ draft, onChange, status }: { draft: LocalMcpDraft; onChange: (draft: LocalMcpDraft) => void; status: LocalMcpStatus }) {
  return (
    <>
      <fieldset className="space-y-2">
        <legend className="text-[12px] text-ink-2">Allow access to</legend>
        <RadioGroup
          aria-label="Allow access to"
          orientation="horizontal"
          value={draft.kind}
          onValueChange={(kind) => onChange(setLocalMcpDraftKind(draft, kind as LocalMcpDraft["kind"]))}
          className="grid-cols-[auto_auto_auto] justify-start gap-4 text-[13px] text-ink"
        >
          {(["projects", "all-projects", "designs"] as const).map((kind) => (
            <label key={kind} className="flex items-center gap-2">
              <RadioGroupItem value={kind} aria-label={scopeKindLabel(kind)} />
              {scopeKindLabel(kind)}
            </label>
          ))}
        </RadioGroup>
      </fieldset>
      {draft.kind === "projects" ? (
        <ScrollArea chainScroll className="max-h-44 space-y-2">
          {!status.projects.length && <p className="text-[12px] text-ink-2">Open a Project in Milagre to grant access to it.</p>}
          {status.projects.map((project) => (
            <label key={project.path} className="flex items-start gap-2 text-[13px] text-ink">
              <Checkbox
                aria-label={project.name}
                className="mt-1"
                checked={draft.projectPaths.includes(project.path)}
                onCheckedChange={() => onChange(toggleLocalMcpDraftProject(draft, project.path))}
              />
              <span className="min-w-0">
                {project.name}
                <span className="block break-all text-[12px] text-ink-2">{project.path}</span>
              </span>
            </label>
          ))}
        </ScrollArea>
      ) : draft.kind === "all-projects" ? (
        <p className="text-[12px] text-ink-2">Includes every Project open in Milagre now and any Project added later.</p>
      ) : (
        <>
          <label className="block text-[12px] text-ink-2">
            Chat reference
            <input
              aria-label="Chat reference"
              className={input}
              placeholder="/path/to/project#123"
              value={draft.chatId}
              onChange={(e) => onChange({ ...draft, chatId: e.target.value })}
            />
          </label>
          <label className="block text-[12px] text-ink-2">
            Design IDs
            <input aria-label="Design IDs" className={input} value={draft.designIds} onChange={(e) => onChange({ ...draft, designIds: e.target.value })} />
          </label>
          <p className="text-[12px] text-ink-2">Use * for all designs in this Chat, or separate IDs with commas. Public sharing is separate.</p>
          {!status.groups.some((g) => g.id === "designs" && g.enabled) && (
            <p className="text-[12px] text-ink-2">Design tools are unavailable while Designs is off.</p>
          )}
        </>
      )}
      <label className="flex items-start gap-2 text-[12px] text-ink">
        <Checkbox
          aria-label={draft.kind === "designs" ? "Allow design edits" : "Allow creating Worktrees and Chats and starting tasks"}
          className="mt-0.5"
          checked={draft.write}
          onCheckedChange={(checked) => onChange({ ...draft, write: checked === true })}
        />
        {draft.kind === "designs" ? "Allow design edits" : "Allow creating Worktrees and Chats and starting tasks"}
      </label>
    </>
  );
}

function McpCheckbox({
  label,
  checked,
  expanded,
  controls,
  disabled,
  onClick,
}: {
  label: string;
  checked: boolean;
  expanded: boolean;
  controls?: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Checkbox
      aria-label={label}
      checked={checked}
      aria-expanded={expanded}
      aria-controls={controls}
      disabled={disabled}
      onCheckedChange={onClick}
      className="size-6"
    />
  );
}
