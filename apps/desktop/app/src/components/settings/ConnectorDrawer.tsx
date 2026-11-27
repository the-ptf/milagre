import { useEffect, useRef, useState } from "react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import {
  connectorAccessGroups,
  connectorAccessKey,
  connectorAccountName,
  connectorAllows,
  connectorStateLine,
  connectorSubtitle,
  type ConnectorSummary,
} from "@milagre/shared/connectors";
import type { McpAccount } from "@milagre/shared/mcp";
import { Button } from "../primitives/Button";
import { SettingCheckbox } from "../primitives/Checkbox";
import { Icon } from "../primitives/Icon";
import { ScrollArea } from "../primitives/ScrollArea";
import { SectionLabel } from "../primitives/SectionLabel";
import { connectorIcon, isBuiltIn, toolPrefix } from "./connector-look";
import { ConnectorTile } from "./ConnectorTile";
import { EmailMailboxes } from "./EmailMailboxes";
import { LinearSettings } from "./LinearSettings";
import type { ConnectorsState } from "./useConnectors";

/** The connector's state as a dot and words: tools when connected, orange when it needs you, red when it failed. */
export function ConnectorStatus({ connector, remote }: { connector: ConnectorSummary; remote?: string }) {
  const needsYou = connector.state === "needs-sign-in" || connector.state === "needs-app";
  const tone = needsYou ? "text-orange-ink" : connector.state === "failed" ? "text-red-ink" : "text-ink-3";
  const dot = needsYou ? "bg-orange" : connector.state === "failed" ? "bg-red" : connector.state === "connected" ? "bg-green" : "bg-ink-4";
  const words =
    needsYou && remote
      ? `${connector.state === "needs-app" ? "Add its app" : "Sign in"} on ${remote}`
      : connector.state === "failed"
        ? "Failed"
        : connectorStateLine(connector);
  return (
    <span className={`flex min-w-0 items-center gap-1.5 text-12 ${tone}`}>
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="truncate">{words}</span>
    </span>
  );
}

function Access({ connector, accounts, state }: { connector: ConnectorSummary; accounts: McpAccount[]; state: ConnectorsState }) {
  if (!accounts.length) return <p className="text-12 text-ink-3">No provider accounts yet. Every account you add gets this connector.</p>;
  const groups = connectorAccessGroups(connector);
  return groups.map((group) => (
    <div key={group.id ?? connector.id} className="rounded-card border border-line px-3 py-1">
      {groups.length > 1 && <p className="pt-1.5 pb-0.5 text-12 font-medium text-ink-2">{group.name}</p>}
      {accounts.map((account) => {
        const key = connectorAccessKey(account.provider, account.accountId);
        const label = connectorAccountName(account);
        return (
          <div key={key} className="flex min-h-9 items-center gap-3">
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

/** What the connector needs from you right now: sign in, add its app or retry, as a tinted note with its action. */
function NeedsYou({ connector, state, remote, onEdit }: { connector: ConnectorSummary; state: ConnectorsState; remote?: string; onEdit: () => void }) {
  const signingIn = state.signingIn === connector.id;
  if (connector.state === "failed")
    return (
      <div className="flex items-center gap-3 rounded-card bg-red-tint px-3.5 py-3">
        <p className="min-w-0 flex-1 text-13 break-words text-red-ink">{connectorStateLine(connector)}</p>
        <Button size={28} variant="secondary" data-connector-retry={connector.id} onClick={() => state.check(connector.id)}>
          Retry
        </Button>
      </div>
    );
  if (connector.state !== "needs-sign-in" && connector.state !== "needs-app") return null;
  const text =
    connector.state === "needs-app"
      ? `${connector.name} needs an app of its own before Milagre can sign in.`
      : `Milagre isn't signed in to ${connector.name}. Agents can't use it until you sign in${remote ? ` on ${remote}` : ""}.`;
  return (
    <div className="flex items-center gap-3 rounded-card bg-orange-tint px-3.5 py-3">
      <p className="min-w-0 flex-1 text-13 text-orange-ink">{signingIn ? "Finish signing in in your browser, then come back." : text}</p>
      {!remote &&
        (signingIn ? (
          <Button size={28} variant="secondary" data-connector-cancel={connector.id} onClick={state.cancelSignIn}>
            Cancel
          </Button>
        ) : connector.state === "needs-app" ? (
          <Button size={28} data-connector-add-app={connector.id} onClick={onEdit}>
            Add app
          </Button>
        ) : (
          connector.kind !== "command" && (
            <Button size={28} data-connector-sign-in={connector.id} disabled={state.signingIn !== null} onClick={() => void state.signIn(connector.id)}>
              Sign in
            </Button>
          )
        ))}
    </div>
  );
}

function Footer({ connector, state, remote, onEdit }: { connector: ConnectorSummary; state: ConnectorsState; remote?: string; onEdit: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const signsIn = connector.kind === "url" && connector.state !== "needs-sign-in" && connector.state !== "needs-app";
  const removeLabel = connector.kind === "email" ? "Forget all mailboxes" : connector.kind === "linear" ? null : "Remove";
  if (confirming)
    return (
      <div data-connector-remove-question className="flex items-center gap-2 border-t border-line px-5 py-3">
        <span className="min-w-0 flex-1 text-12 text-ink">Remove {connector.name}? Chats lose its tools and Milagre signs out of it.</span>
        <Button size={28} variant="secondary" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button size={28} variant="danger" data-connector-remove-confirm onClick={() => state.remove(connector.id)}>
          Remove
        </Button>
      </div>
    );
  return (
    <div className="flex items-center gap-2 border-t border-line px-5 py-3">
      {!isBuiltIn(connector) && !remote && (
        <Button size={28} variant="secondary" data-connector-edit={connector.id} onClick={onEdit}>
          Edit
        </Button>
      )}
      {signsIn && !remote && (
        <Button
          size={28}
          variant="secondary"
          data-connector-sign-in-again={connector.id}
          disabled={state.signingIn !== null}
          onClick={() => void state.signIn(connector.id)}
        >
          Sign in again
        </Button>
      )}
      <span className="flex-1" />
      {signsIn && (
        <Button size={28} variant="quiet" data-connector-sign-out={connector.id} onClick={() => state.signOut(connector.id)}>
          Sign out
        </Button>
      )}
      {removeLabel && (
        <Button size={28} variant="danger-ghost" data-connector-remove={connector.id} onClick={() => setConfirming(true)}>
          {removeLabel}
        </Button>
      )}
    </div>
  );
}

/** One connector in a side drawer over Settings: what it needs, its built-in settings, which accounts may use it, and edit or remove. */
export function ConnectorDrawer({
  connector,
  state,
  remote,
  onEdit,
  onAddMailbox,
  onClose,
}: {
  connector: ConnectorSummary;
  state: ConnectorsState;
  /** Another computer's name: its connectors are routed and removed from here, but edited and signed in to there. */
  remote?: string;
  onEdit: () => void;
  onAddMailbox?: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={connector.name}
      data-connector-drawer={connector.id}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => event.target === dialog.current && onClose()}
      className="m-0 mt-3 mr-3 ml-auto h-[calc(100dvh-24px)] max-h-none w-[440px] max-w-[calc(100vw-24px)] overflow-hidden rounded-window bg-surface p-0 text-ink shadow-overlay backdrop:bg-black/10"
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <ConnectorTile
            size="lg"
            iconPath={connectorIcon(connector)}
            letter={connector.name}
            command={connector.kind === "command"}
            mail={connector.kind === "email"}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-15 font-semibold text-ink">{connector.name}</h2>
              {isBuiltIn(connector) && <span className="shrink-0 rounded-chip bg-field px-1.5 text-10 leading-4.5 font-semibold text-ink-2">Built in</span>}
            </div>
            <ConnectorStatus connector={connector} remote={remote} />
          </div>
          <button
            type="button"
            aria-label="Close"
            className="flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-hover"
            onClick={onClose}
          >
            <Icon icon={Cancel01Icon} size={16} />
          </button>
        </div>
        <ScrollArea className="min-h-0 flex-1 space-y-5 px-5 py-5">
          <NeedsYou connector={connector} state={state} remote={remote} onEdit={onEdit} />
          {connector.kind === "email" && <EmailMailboxes connector={connector} state={state} remote={remote} onAdd={onAddMailbox} />}
          {connector.kind === "linear" &&
            (remote ? (
              <p className="text-12 text-ink-3">Linear's settings are on {remote}.</p>
            ) : (
              <div className="-mx-5 border-y border-line">
                <LinearSettings />
              </div>
            ))}
          <section className="space-y-2">
            <SectionLabel as="h3">Agents that can use it</SectionLabel>
            <Access connector={connector} accounts={state.accounts} state={state} />
            <p className="text-12 text-ink-3">New accounts get it too. A Chat picks up changes when its next session starts.</p>
          </section>
          <section className="space-y-1">
            <SectionLabel as="h3">For agents</SectionLabel>
            <p className="text-13 text-ink-2">
              {connector.state === "connected" ? `${connector.tools ?? 0} tools, named ` : "Its tools will be named "}
              <code className="rounded-inline bg-field px-1 font-mono text-12">{toolPrefix(connector)}…</code>
              {connector.kind !== "email" && connector.kind !== "linear" && <span className="text-ink-3"> · {connectorSubtitle(connector)}</span>}
            </p>
          </section>
        </ScrollArea>
        <Footer connector={connector} state={state} remote={remote} onEdit={onEdit} />
      </div>
    </dialog>
  );
}
