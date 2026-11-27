const DAY_MS = 24 * 60 * 60 * 1000;
const SCAN_LIMIT = 50;

class EmailError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function explain(error, mailbox) {
  if (error instanceof EmailError) return error;
  if (error?.authenticationFailed)
    return new EmailError(
      `${mailbox.host} refused the sign-in for ${mailbox.address}. Use an app password: Gmail, iCloud and Yahoo don't accept the account password over IMAP.`,
      "auth",
    );
  const reason = error?.responseText || error?.message || String(error);
  return new EmailError(`Couldn't read ${mailbox.address} at ${mailbox.host}:${mailbox.port}: ${reason}`, "unreachable");
}

const addressLine = (list) =>
  (list ?? [])
    .map((item) => (item.name ? `${item.name} <${item.address ?? ""}>` : (item.address ?? "")))
    .filter(Boolean)
    .join(", ");

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

/** Port 993 is TLS from the start. Any other port must upgrade with STARTTLS, except on this computer (Proton Mail Bridge), where its self-signed certificate is accepted. */
function transport({ host, port }) {
  if (port === 993) return { secure: true };
  if (LOOPBACK.has(host)) return { secure: false, tls: { rejectUnauthorized: false } };
  return { secure: false, doSTARTTLS: true };
}

/** Reads a mailbox over IMAP, read-only: folders open with EXAMINE and bodies are fetched with BODY.PEEK, so nothing is marked read. */
function createImapReader({ ImapFlow, simpleParser, timeoutMs = 20_000 } = {}) {
  const Client = () => ImapFlow ?? require("imapflow").ImapFlow;
  const parse = (source) => (simpleParser ?? require("mailparser").simpleParser)(source, { skipImageLinks: true });
  async function session(mailbox, run) {
    const client = new (Client())({
      host: mailbox.host,
      port: mailbox.port,
      ...transport(mailbox),
      auth: { user: mailbox.username, pass: mailbox.password },
      logger: false,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs * 3,
    });
    client.on("error", () => {});
    try {
      await client.connect();
      return await run(client);
    } catch (error) {
      throw explain(error, mailbox);
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  async function folders(client) {
    const list = await client.list().catch(() => []);
    const junk = list.find((entry) => entry.specialUse === "\\Junk");
    return [{ path: "INBOX", label: "Inbox" }, ...(junk ? [{ path: junk.path, label: "Junk" }] : [])];
  }

  async function scan(client, folder, { since, from, subject }) {
    await client.mailboxOpen(folder.path, { readOnly: true });
    const query = { since: new Date(since.getTime() - DAY_MS), ...(from ? { from } : {}), ...(subject ? { subject } : {}) };
    const uids = (await client.search(query, { uid: true })) || [];
    if (!uids.length) return [];
    const range = uids.slice(-SCAN_LIMIT).join(",");
    const found = await client.fetchAll(range, { uid: true, envelope: true, internalDate: true }, { uid: true });
    return found
      .filter((item) => item.internalDate && new Date(item.internalDate) >= since)
      .map((item) => ({ uid: item.uid, folder, date: new Date(item.internalDate) }));
  }

  return {
    /** Signs in and out once, to check the address, server and app password before they're saved. */
    verify: (mailbox) => session(mailbox, async () => true),
    /** Messages received since `since`, newest first, at most `limit`, optionally from a sender and with a subject (IMAP substring matches). */
    recent(mailbox, { since, from, subject, limit }) {
      return session(mailbox, async (client) => {
        const hits = [];
        for (const folder of await folders(client)) hits.push(...(await scan(client, folder, { since, from, subject })));
        hits.sort((a, b) => b.date - a.date);
        const messages = [];
        let open = null;
        for (const hit of hits.slice(0, limit)) {
          if (open !== hit.folder.path) {
            await client.mailboxOpen(hit.folder.path, { readOnly: true });
            open = hit.folder.path;
          }
          const fetched = await client.fetchOne(String(hit.uid), { uid: true, source: true }, { uid: true });
          if (!fetched?.source) continue;
          const parsed = await parse(fetched.source);
          messages.push({
            folder: hit.folder.label,
            date: hit.date,
            from: addressLine(parsed.from?.value),
            to: addressLine(parsed.to?.value),
            subject: parsed.subject ?? "",
            text: String(parsed.text ?? "").trim(),
          });
        }
        return messages;
      });
    },
  };
}

module.exports = { createImapReader, EmailError, transport };
