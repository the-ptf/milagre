import { useState } from "react";
import { EMAIL_APP_PASSWORD_HINT, EMAIL_CONFIGURE_HINT, EMAIL_CONFIGURE_LABEL, appPasswordLink, guessImapHost } from "@milagre/shared/email";
import type { EmailConnectInput } from "@milagre/shared/connectors";
import { Button } from "../primitives/Button";
import { Secret, field, label } from "./ConnectorFields";

export type EmailDraft = { address: string; password: string; host: string; port: string };
export const EMPTY_EMAIL: EmailDraft = { address: "", password: "", host: "", port: "" };

/** What `email:connect` gets: blank host and port fall back to the provider's IMAP server on the host. */
export function emailInput(draft: EmailDraft): EmailConnectInput {
  const port = draft.port.trim();
  if (port && !/^\d+$/.test(port)) throw new Error("Enter the IMAP port as a number, usually 993.");
  return {
    address: draft.address.trim(),
    password: draft.password,
    ...(draft.host.trim() ? { host: draft.host.trim() } : {}),
    ...(port ? { port: Number(port) } : {}),
  };
}

/** A mailbox's address, app password and, behind Server, its IMAP host and port; or an agent that sets it up. */
export function EmailFields({ draft, onChange, onConfigure }: { draft: EmailDraft; onChange: (draft: EmailDraft) => void; onConfigure: () => void }) {
  const [server, setServer] = useState(false);
  const set = (key: keyof EmailDraft) => (value: string) => onChange({ ...draft, [key]: value });
  const link = appPasswordLink(draft.address);
  const guess = guessImapHost(draft.address);
  return (
    <div data-email-fields className="space-y-4">
      <label className={label}>
        Address
        <input
          autoFocus
          type="email"
          aria-label="Address"
          autoComplete="off"
          spellCheck={false}
          placeholder="you@example.com"
          className={field}
          value={draft.address}
          onChange={(event) => set("address")(event.target.value)}
        />
      </label>
      <div data-email-configure className="flex items-center gap-3 rounded-card border border-line px-4 py-3">
        <p className="min-w-0 flex-1 text-12 text-ink-2">{EMAIL_CONFIGURE_HINT}</p>
        <Button variant="secondary" data-email-configure-start onClick={onConfigure}>
          {EMAIL_CONFIGURE_LABEL}
        </Button>
      </div>
      <Secret name="App password" value={draft.password} onChange={set("password")} />
      <p className="text-12 text-ink-3">
        {EMAIL_APP_PASSWORD_HINT}{" "}
        {link && (
          <a href={link.url} target="_blank" rel="noreferrer" data-email-app-password className="text-ink underline">
            Create an app password at {link.name}
          </a>
        )}
      </p>
      {server ? (
        <div className="grid grid-cols-[1fr_96px] gap-3">
          <label className={label}>
            IMAP server
            <input
              aria-label="IMAP server"
              autoComplete="off"
              spellCheck={false}
              placeholder={guess || "imap.example.com"}
              className={field}
              value={draft.host}
              onChange={(event) => set("host")(event.target.value)}
            />
          </label>
          <label className={label}>
            Port
            <input
              aria-label="Port"
              inputMode="numeric"
              autoComplete="off"
              placeholder="993"
              className={field}
              value={draft.port}
              onChange={(event) => set("port")(event.target.value)}
            />
          </label>
        </div>
      ) : (
        <button type="button" data-email-server className="text-12 font-medium text-ink-2 hover:underline" onClick={() => setServer(true)}>
          {guess ? `Server: ${guess}, port 993. Change` : "Choose the IMAP server"}
        </button>
      )}
    </div>
  );
}
