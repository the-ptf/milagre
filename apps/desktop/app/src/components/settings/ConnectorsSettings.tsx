import { useState, type ReactNode } from "react";
import { ArrowRight01Icon, Key01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import {
  CONNECTORS_HINT,
  CONNECTORS_TITLE,
  connectorPreset,
  connectorReach,
  connectorSubtitle,
  connectorMovedNote,
  searchConnectorPresets,
  type ConnectorSummary,
} from "@milagre/shared/connectors";
import { Button } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { Icon } from "../primitives/Icon";
import { InlineError } from "../primitives/InlineError";
import { SectionLabel } from "../primitives/SectionLabel";
import { thisComputer } from "../../lib/shortcut-hints";
import { McpSettings } from "../McpSettings";
import { LocalMcpSettings } from "../LocalMcpSettings";
import { Segmented } from "../primitives/Segmented";
import { addedPresets, connectorIcon, isBuiltIn } from "./connector-look";
import { ConnectorDrawer, ConnectorStatus } from "./ConnectorDrawer";
import { ConnectorSheet } from "./ConnectorSheet";
import { ConnectorEditSheet } from "./ConnectorEditSheet";
import { ConnectorTile } from "./ConnectorTile";
import { useConnectors, type ConnectorsState } from "./useConnectors";
import type { MilagreBridge } from "../../electron";

const card = "divide-y divide-line overflow-hidden rounded-card border border-line bg-surface";

function ConnectorRow({
  connector,
  accounts,
  open,
  onOpen,
  remote,
}: {
  connector: ConnectorSummary;
  accounts: ConnectorsState["accounts"];
  open: boolean;
  onOpen: () => void;
  remote?: string;
}) {
  return (
    <div data-connector-row={connector.id} data-state={connector.state} data-open={open}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={onOpen}
        className="flex min-h-15 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-hover active:bg-hover-2"
      >
        <ConnectorTile
          iconPath={connectorIcon(connector)}
          letter={connector.name}
          command={connector.kind === "command"}
          mail={connector.kind === "email"}
          warn={connector.state === "needs-sign-in"}
        />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-13 font-semibold text-ink">{connector.name}</span>
            {isBuiltIn(connector) && <span className="shrink-0 rounded-chip bg-field px-1.5 text-10 leading-4.5 font-semibold text-ink-2">Built in</span>}
          </span>
          <span className="truncate text-12 text-ink-3">{connectorSubtitle(connector)}</span>
        </span>
        <span className="hidden w-32 shrink-0 text-right text-12 text-ink-3 min-[880px]:block">{connectorReach(connector, accounts)}</span>
        <span className="flex w-36 shrink-0 justify-end">
          <ConnectorStatus connector={connector} remote={remote} />
        </span>
        <Icon icon={ArrowRight01Icon} size={16} className="shrink-0 text-ink-4" />
      </button>
    </div>
  );
}

/** One line over the list for the first connector that needs you, with a way to open it. */
function NeedsYouBanner({ connectors, onOpen }: { connectors: ConnectorSummary[]; onOpen: (id: string) => void }) {
  const first = connectors.find((connector) => connector.state === "needs-sign-in" || connector.state === "needs-app");
  if (!first) return null;
  const others = connectors.filter((connector) => connector.state === "needs-sign-in" || connector.state === "needs-app").length - 1;
  return (
    <div data-connectors-needs-you className="flex items-center gap-3 rounded-card bg-orange-tint py-2.5 pr-3 pl-4">
      <Icon icon={Key01Icon} size={16} className="shrink-0 text-orange-ink" />
      <p className="min-w-0 flex-1 text-13 text-orange-ink">
        {first.name} needs you to {first.state === "needs-app" ? "add its app" : "sign in"}
        {others > 0 ? `, and ${others} more` : ""}.
      </p>
      <Button size={28} variant="secondary" onClick={() => onOpen(first.id)}>
        Review
      </Button>
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
  const [adding, setAdding] = useState<"any" | "email" | null>(null);
  const [editing, setEditing] = useState<ConnectorSummary | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const opened = state.connectors?.find((connector) => connector.id === open) ?? null;
  return (
    <div data-connectors-page>
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-22 font-semibold tracking-[-0.02em] text-ink">{title}</h1>
        <Button data-connector-add onClick={() => setAdding("any")}>
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
        {state.connectors && <NeedsYouBanner connectors={state.connectors} onOpen={setOpen} />}
        {state.connectors?.length ? (
          <section className="space-y-2">
            <SectionLabel className="px-1">Connected · {state.connectors.length}</SectionLabel>
            <div className={card}>
              {state.connectors.map((connector) => (
                <ConnectorRow
                  key={connector.id}
                  connector={connector}
                  accounts={state.accounts}
                  open={open === connector.id}
                  onOpen={() => setOpen(connector.id)}
                />
              ))}
            </div>
          </section>
        ) : (
          state.connectors && (
            <EmptyState title="No connectors yet" className="px-6 py-6">
              Give agents your email, Slack, Linear, Notion or any MCP server. You sign in once and every Chat can use it.
            </EmptyState>
          )
        )}
        <button
          type="button"
          data-connector-browse
          onClick={() => setAdding("any")}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-card border border-dashed border-line-strong text-13 font-medium text-ink-2 transition-colors hover:bg-hover"
        >
          <Icon icon={PlusSignIcon} size={14} />
          Browse {searchConnectorPresets("").length} services
        </button>
        <MoveSection state={state} />
      </div>
      {adding && (
        <ConnectorSheet
          onAdd={state.add}
          onLinear={state.connectLinear}
          onEmail={state.connectEmail}
          email={adding === "email"}
          added={addedPresets(state.connectors)}
          onClose={() => setAdding(null)}
        />
      )}
      {opened && (
        <ConnectorDrawer
          connector={opened}
          state={state}
          onEdit={() => setEditing(opened)}
          onAddMailbox={() => setAdding("email")}
          onClose={() => setOpen(null)}
        />
      )}
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
  const opened = state.connectors?.find((connector) => connector.id === open) ?? null;
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
              accounts={state.accounts}
              remote={name}
              open={open === connector.id}
              onOpen={() => setOpen(connector.id)}
            />
          ))}
        </div>
      ) : (
        state.connectors && <p className="px-1 text-12 text-ink-3">No connectors on {name} yet.</p>
      )}
      {opened && <ConnectorDrawer connector={opened} state={state} remote={name} onEdit={() => {}} onClose={() => setOpen(null)} />}
    </div>
  );
}
