import type { ConnectorSummary } from "@milagre/shared/connectors";
import { Button } from "../primitives/Button";
import { SectionLabel } from "../primitives/SectionLabel";
import type { ConnectorsState } from "./useConnectors";

/** The Email connector's mailboxes, the IMAP server each reads, and a way to add or forget one. */
export function EmailMailboxes({
  connector,
  state,
  remote,
  onAdd,
}: {
  connector: ConnectorSummary;
  state: ConnectorsState;
  remote?: string;
  onAdd?: () => void;
}) {
  return (
    <div data-email-mailboxes className="pb-1">
      <SectionLabel as="h3" className="pb-1">
        Mailboxes
      </SectionLabel>
      {(connector.mailboxes ?? []).map((mailbox) => (
        <div key={mailbox.address} data-email-mailbox={mailbox.address} className="flex min-h-10 items-center gap-3">
          <span className="grid min-w-0 flex-1">
            <span className="truncate text-13 text-ink">{mailbox.address}</span>
            <span className="truncate text-12 text-ink-3">
              {mailbox.host}:{mailbox.port}
            </span>
          </span>
          <Button variant="danger-ghost" data-email-forget={mailbox.address} onClick={() => state.disconnectEmail(mailbox.address)}>
            Forget
          </Button>
        </div>
      ))}
      {remote ? (
        <p className="py-2 text-12 text-ink-3">Add mailboxes on {remote}.</p>
      ) : (
        onAdd && (
          <Button variant="secondary" data-email-add className="mt-1" onClick={onAdd}>
            Add mailbox
          </Button>
        )
      )}
    </div>
  );
}
