const { createEmailStore, isAddress } = require("./store.cjs");
const { guessImapHost } = require("@milagre/shared/email");
const { createImapReader, EmailError } = require("./imap.cjs");

const publicMailbox = ({ address, host, port, username, connectedAt }) => ({ address, host, port, username, connectedAt });

/** Milagre's own mailboxes: address, IMAP server and app password, kept on this computer and read only by the `email_recent` tool. */
function createEmail({ dataDir, reader = createImapReader(), now = Date.now, changed = () => {} }) {
  const store = createEmailStore({ dataDir });
  return {
    mailboxes: () => store.list().map(publicMailbox),
    /** The saved mailbox with its password, for the reader. */
    secret: (address) => store.get(address),
    reader,
    async connect(input) {
      const address = String(input?.address ?? "")
        .trim()
        .toLowerCase();
      if (!isAddress(address)) throw new EmailError("Enter a mail address, like you@example.com.", "invalid");
      const password = String(input?.password ?? "").replace(/\s+/g, "");
      const existing = store.get(address);
      if (!password && !existing) throw new EmailError("Enter an app password for this mailbox.", "invalid");
      const host = String(input?.host ?? "").trim() || existing?.host || guessImapHost(address);
      const port = input?.port === undefined || input?.port === null || input?.port === "" ? (existing?.port ?? 993) : Number(input.port);
      if (!/^[a-z0-9.-]+$/i.test(host)) throw new EmailError("Enter the IMAP server's host name, like imap.example.com.", "invalid");
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new EmailError("Enter an IMAP port between 1 and 65535, usually 993.", "invalid");
      const mailbox = {
        address,
        host: host.toLowerCase(),
        port,
        username: String(input?.username ?? "").trim() || existing?.username || address,
        password: password || existing.password,
        connectedAt: existing?.connectedAt ?? now(),
      };
      await reader.verify(mailbox);
      store.save(mailbox);
      changed();
      return publicMailbox(mailbox);
    },
    disconnect(address) {
      if (address === undefined) for (const mailbox of store.list()) store.remove(mailbox.address);
      else store.remove(String(address).toLowerCase());
      changed();
    },
  };
}

module.exports = { createEmail, EmailError };
