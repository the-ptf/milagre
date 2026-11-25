import { useState, type ReactNode } from "react";
import { Alert02Icon, ArrowDown01Icon, ArrowUp01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import {
  CONNECTORS_HINT,
  CONNECTORS_TITLE,
  CONNECTOR_SIGNING_IN,
  connectorAccessGroups,
  connectorAccessKey,
  connectorAccountName,
  connectorAllows,
  connectorPreset,
  connectorReach,
  connectorStateLine,
  connectorSubtitle,
  connectorMovedNote,
  CONNECTOR_PRESETS,
  type ConnectorSummary,
} from "@milagre/shared/connectors";
import type { McpAccount } from "@milagre/shared/mcp";
import { Button } from "../primitives/Button";
import { SettingCheckbox } from "../primitives/Checkbox";
import { EmptyState } from "../primitives/EmptyState";
import { Icon } from "../primitives/Icon";
import { InlineError } from "../primitives/InlineError";
import { SectionLabel } from "../primitives/SectionLabel";
import { thisComputer } from "../../lib/shortcut-hints";
import { McpSettings } from "../McpSettings";
import { LocalMcpSettings } from "../LocalMcpSettings";
import { Segmented } from "../primitives/Segmented";
import { ConnectorSheet } from "./ConnectorSheet";
import { ConnectorEditSheet } from "./ConnectorEditSheet";
import { ConnectorTile } from "./ConnectorTile";
import { LinearSettings } from "./LinearSettings";
import { useConnectors, type ConnectorsState } from "./useConnectors";
import type { MilagreBridge } from "../../electron";

const card = "divide-y divide-line overflow-hidden rounded-card border border-line bg-surface";
const LINEAR_ICON = CONNECTOR_PRESETS.find((preset) => preset.id === "linear")?.iconPath;
const iconOf = (connector: ConnectorSummary) => (connector.kind === "linear" ? LINEAR_ICON : connectorPreset(connector)?.iconPath);
const toolPrefix = (connector: ConnectorSummary) => (connector.kind === "linear" ? "linear_" : `${connector.id}__`);

function RowAction({ connector, state, onEdit, remote }: { connector: ConnectorSummary; state: ConnectorsState; onEdit: () => void; remote?: string }) {
  if (remote && (connector.state === "needs-sign-in" || connector.state === "needs-app"))
    return <span className="shrink-0 text-12 text-ink-3">On {remote}</span>;
  if (state.signingIn === connector.id)
    return (
      <Button variant="secondary" data-connector-cancel={connector.id} onClick={state.cancelSignIn}>
        Cancel
      </Button>
    );
  if (connector.state === "needs-sign-in" && connector.kind !== "command")
    return (
      <Button data-connector-sign-in={connector.id} disabled={state.signingIn !== null} onClick={() => void state.signIn(connector.id)}>
        Sign in
      </Button>
    );
  if (connector.state === "needs-app")
    return (
      <Button data-connector-add-app={connector.id} onClick={onEdit}>
        Add app
      </Button>
    );
  if (connector.state === "failed")
    return (
      <Button variant="secondary" data-connector-retry={connector.id} onClick={() => state.check(connector.id)}>
        Retry
      </Button>
    );
  return null;
}

function Access({ connector, accounts, state }: { connector: ConnectorSummary; accounts: McpAccount[]; state: ConnectorsState }) {
  if (!accounts.length) return <p className="py-2 text-12 text-ink-3">No provider accounts yet. Every account you add gets this connector.</p>;
  return connectorAccessGroups(connector).map((group) => (
    <div key={group.id ?? connector.id} className="pb-1">
      <SectionLabel as="h3" className="pb-1">
        {group.id ? `${group.name} · Available to` : "Available to"}
      </SectionLabel>
      {accounts.map((account) => {
        const key = connectorAccessKey(account.provider, account.accountId);
        const label = connectorAccountName(account);
        return (
          <div key={key} className="flex min-h-10 items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-13 text-ink">{label}</span>
            <span data-connector-access={[connector.id, group.id, key].filter(Boolean).join(":")} className="flex">
              <SettingCheckbox
                label={`${group.name} for ${label}`}
                checked={connectorAllows(group, account.provider, account.accountId)}
                onChange={(on) => state.setAccess(connector.id, account.provider, account.accountId, on, group.id)}
              />
            </span>
          </div>
        );
      })}
    </div>
  ));
}

function ConnectorRow({
  connector,
  state,
  open,
  onToggle,
  onEdit,
  remote,
}: {
  connector: ConnectorSummary;
  state: ConnectorsState;
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  /** Another computer's name: its connectors are routed and removed from here, but added, edited and signed in to there. */
  remote?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const failed = connector.state === "failed";
  const signingIn = state.signingIn === connector.id;
  const subtitle = signingIn ? CONNECTOR_SIGNING_IN : failed ? connectorStateLine(connector) : connectorSubtitle(connector);
  const signsIn = connector.kind === "url" && connector.state !== "needs-sign-in" && connector.state !== "needs-app";
  const summary =
    connector.state === "connected"
      ? `${connectorStateLine(connector)} · ${connectorReach(connector, state.accounts)}`
      : connectorReach(connector, state.accounts);
  return (
    <div data-connector-row={connector.id} data-state={connector.state} data-open={open}>
      <div className="flex min-h-15 items-center gap-3 px-4 py-3">
        <button type="button" aria-expanded={open} onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <ConnectorTile iconPath={iconOf(connector)} command={connector.kind === "command"} warn={connector.state === "needs-sign-in"} />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="truncate text-13 font-semibold text-ink">{connector.name}</span>
            <span className={`truncate text-12 ${failed ? "text-red-ink" : "text-ink-3"}`}>{subtitle}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-12 text-ink-3">
            {failed && <Icon icon={Alert02Icon} size={14} className="text-red-ink" />}
            {summary}
          </span>
          <Icon icon={open ? ArrowUp01Icon : ArrowDown01Icon} size={16} className="shrink-0 text-ink-3" />
        </button>
        <RowAction connector={connector} state={state} onEdit={onEdit} remote={remote} />
      </div>
      {open && (
        <div className="px-4 pt-1 pb-3">
          <Access connector={connector} accounts={state.accounts} state={state} />
          {connector.kind === "linear" &&
            (remote ? (
              <p className="py-2 text-12 text-ink-3">Linear's settings are on {remote}.</p>
            ) : (
              <div className="-mx-4 mt-2 border-t border-line">
                <LinearSettings />
              </div>
            ))}
          {confirming ? (
            <div data-connector-remove-question className="mt-1 flex min-h-11 items-center gap-2">
              <span className="min-w-0 flex-1 text-12 text-ink">Remove {connector.name}? Chats lose its tools and Milagre signs out of it.</span>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button variant="danger" data-connector-remove-confirm onClick={() => state.remove(connector.id)}>
                Remove
              </Button>
            </div>
          ) : (
            <div className="mt-1 flex min-h-11 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-12 text-ink-3">
                Tools read <code className="font-mono">{toolPrefix(connector)}…</code> for agents
              </span>
              {signsIn && !remote && (
                <Button
                  variant="secondary"
                  data-connector-sign-in-again={connector.id}
                  disabled={state.signingIn !== null}
                  onClick={() => void state.signIn(connector.id)}
                >
                  Sign in again
                </Button>
              )}
              {signsIn && (
                <Button variant="secondary" data-connector-sign-out={connector.id} onClick={() => state.signOut(connector.id)}>
                  Sign out
                </Button>
              )}
              {connector.kind !== "linear" && !remote && (
                <Button variant="secondary" data-connector-edit={connector.id} onClick={onEdit}>
                  Edit
                </Button>
              )}
              {connector.kind !== "linear" && (
                <Button variant="danger-ghost" data-connector-remove={connector.id} onClick={() => setConfirming(true)}>
                  Remove
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MoveSection({ state }: { state: ConnectorsState }) {
  if (!state.movable.length) return null;
  return (
    <section className="space-y-2">
      <SectionLabel className="px-1">Move to Connectors · {state.movable.length}</SectionLabel>
      <div className={card}>
        {state.movable.map((server) => (
          <div key={server.name} data-connector-movable={server.name} className="flex min-h-15 items-center gap-3 px-4 py-3">
            <ConnectorTile iconPath={connectorPreset(server)?.iconPath} command={!server.url} />
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="truncate text-13 font-semibold text-ink">{server.name}</span>
              <span className="truncate text-12 text-ink-3">Everywhere server. Move it to sign in once instead of once per account.</span>
            </span>
            <Button variant="secondary" data-connector-move={server.name} onClick={() => state.move(server.name)}>
              Move
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

function ConnectorsList({ title, tabs }: { title: string; tabs: ReactNode }) {
  const state = useConnectors();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ConnectorSummary | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div data-connectors-page>
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-22 font-semibold tracking-[-0.02em] text-ink">{title}</h1>
        <Button data-connector-add onClick={() => setAdding(true)}>
          <Icon icon={PlusSignIcon} size={14} />
          Add connector
        </Button>
      </div>
      {tabs}
      <p className="mt-5 text-13 text-ink-2">
        {CONNECTORS_HINT} Sign-ins stay on {thisComputer}.
      </p>
      <div className="mt-6 space-y-6">
        <InlineError>{state.error}</InlineError>
        {state.moved.length > 0 && (
          <div data-connectors-moved className="flex items-start gap-3 rounded-card border border-line bg-surface px-4 py-3">
            <p className="min-w-0 flex-1 text-13 text-ink-2">{connectorMovedNote(state.moved)}</p>
            <Button variant="secondary" onClick={state.dismissMoved}>
              Got it
            </Button>
          </div>
        )}
        {state.connectors?.length ? (
          <div className={card}>
            {state.connectors.map((connector) => (
              <ConnectorRow
                key={connector.id}
                connector={connector}
                state={state}
                open={open === connector.id}
                onToggle={() => setOpen(open === connector.id ? null : connector.id)}
                onEdit={() => setEditing(connector)}
              />
            ))}
          </div>
        ) : (
          state.connectors && (
            <EmptyState title="No connectors yet" className="px-6 py-6">
              Add Slack, Linear, Notion or any MCP server with an address. You sign in once and every Chat can use it.
            </EmptyState>
          )
        )}
        <MoveSection state={state} />
      </div>
      {adding && <ConnectorSheet onAdd={state.add} onLinear={state.connectLinear} onClose={() => setAdding(false)} />}
      {editing && (
        <ConnectorEditSheet connector={editing} onSave={(patch, signIn) => state.update(editing.id, patch, signIn)} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

/** Settings › Connectors: the computer's Connectors, and a switch to the MCP servers each account loads plus Milagre's own MCP. */
export function ConnectorsSettings({ title = CONNECTORS_TITLE }: { title?: string }) {
  const [view, setView] = useState<"connectors" | "mcp">("connectors");
  const tabs = (
    <Segmented
      label="Show"
      className="mt-4 w-fit"
      dataKey="connectors-view"
      value={view}
      options={[
        { value: "connectors", label: "Connectors" },
        { value: "mcp", label: "MCP servers" },
      ]}
      onChange={setView}
    />
  );
  if (view === "connectors") return <ConnectorsList title={title} tabs={tabs} />;
  return (
    <>
      <h1 className="text-22 font-semibold tracking-[-0.02em] text-ink">{title}</h1>
      {tabs}
      <McpSettings />
      <h2 className="mt-8 px-1 text-12 font-medium text-ink-3">Milagre MCP</h2>
      <LocalMcpSettings bridge={window.milagre} />
    </>
  );
}

/** Another paired computer's Connectors, on its Settings page: route and remove them here; add, edit and sign in on that computer. */
export function RemoteConnectors({ bridge, name }: { bridge: MilagreBridge; name: string }) {
  const state = useConnectors(bridge);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div data-remote-connectors className="space-y-2">
      <p className="px-1 text-12 text-ink-3">
        Choose which of {name}'s accounts use each one. Add connectors and sign in on {name}.
      </p>
      {state.error && !state.connectors ? <p className="px-1 text-12 text-ink-3">Update Milagre on {name} to see its connectors here.</p> : null}
      {state.connectors ? <InlineError>{state.error}</InlineError> : null}
      {state.connectors?.length ? (
        <div className={card}>
          {state.connectors.map((connector) => (
            <ConnectorRow
              key={connector.id}
              connector={connector}
              state={state}
              remote={name}
              open={open === connector.id}
              onToggle={() => setOpen(open === connector.id ? null : connector.id)}
              onEdit={() => {}}
            />
          ))}
        </div>
      ) : (
        state.connectors && <p className="px-1 text-12 text-ink-3">No connectors on {name} yet.</p>
      )}
    </div>
  );
}
