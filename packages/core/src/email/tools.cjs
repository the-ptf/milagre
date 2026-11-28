const fs = require("node:fs");
const path = require("node:path");
const { z } = require("zod");
const { neutralizeTags } = require("@milagre/shared/untrusted-text");
const { UNTRUSTED_NOTE } = require("@milagre/shared/routine-prompt");

const MINUTE_MS = 60_000;
const MAX_WITHIN_MINUTES = 24 * 60;
const MAX_WAIT_SECONDS = 120;
const POLL_MS = 10_000;
const MAX_BODY = 4_000;
const MAX_OUTPUT = 40_000;

const clip = (text, length) => (text.length > length ? `${text.slice(0, length)}\n… truncated` : text);
const tidy = (text) =>
  text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
const cleanLabel = (text) =>
  String(text)
    .replace(/[<>"\n]/g, "")
    .slice(0, 200);
const ago = (date, now) => {
  const minutes = Math.max(0, Math.round((now - date.getTime()) / MINUTE_MS));
  return minutes < 1 ? "just now" : minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
};

function formatMessage(message, mailbox, now) {
  const facts = [
    `From: ${message.from || "unknown"}`,
    message.to && `To: ${message.to}`,
    `Received ${message.date.toISOString().replace(/\.\d+Z$/, "Z")} (${ago(message.date, now)})`,
    `Mailbox: ${mailbox}${message.folder === "Inbox" ? "" : ` (${message.folder})`}`,
  ].filter(Boolean);
  const body = neutralizeTags(clip(tidy(message.text), MAX_BODY)) || "(no text)";
  return `## ${neutralizeTags(message.subject || "(no subject)")}\n${neutralizeTags(facts.join("\n"))}\n\n<untrusted-data source="email from ${cleanLabel(message.from)}">\n${body}\n</untrusted-data>`;
}

/** `email_recent` over the mailboxes a Chat may read. `mailboxes()` lists the allowed addresses. */
function createEmailTools({ email, mailboxes, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  function chosen(name) {
    const allowed = mailboxes();
    if (!allowed.length) throw new Error("No mailbox is connected for this account. Connect one in Milagre's Settings › Connectors › Email.");
    if (name === undefined || name === "") return allowed;
    const address = String(name).trim().toLowerCase();
    if (!allowed.includes(address)) throw new Error(`${address} isn't a connected mailbox this Chat may read. Connected: ${allowed.join(", ")}.`);
    return [address];
  }

  async function search(addresses, filters) {
    const found = [];
    const failed = [];
    let tried = 0;
    for (const address of addresses) {
      const mailbox = email.secret(address);
      if (!mailbox) continue;
      tried += 1;
      try {
        const messages = await email.reader.recent(mailbox, filters);
        found.push(...messages.map((message) => ({ message, address })));
      } catch (error) {
        failed.push({ address, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    if (tried && failed.length === tried) throw new Error(failed.map(({ address, reason }) => `${address}: ${reason}`).join("\n"));
    return { found: found.sort((a, b) => b.message.date - a.message.date).slice(0, filters.limit), failed };
  }

  async function recent({ from, subject, withinMinutes = 10, waitSeconds = 0, limit = 3, mailbox } = {}) {
    const addresses = chosen(mailbox);
    const minutes = Math.min(Math.max(Number(withinMinutes) || 10, 1), MAX_WITHIN_MINUTES);
    const wait = Math.min(Math.max(Number(waitSeconds) || 0, 0), MAX_WAIT_SECONDS);
    const filters = {
      from: from?.trim() || undefined,
      subject: subject?.trim() || undefined,
      limit: Math.min(Math.max(Math.trunc(Number(limit) || 3), 1), 10),
    };
    const deadline = now() + wait * 1000;
    let found = [];
    let failed = [];
    for (;;) {
      ({ found, failed } = await search(addresses, { ...filters, since: new Date(now() - minutes * MINUTE_MS) }));
      if (found.length || now() >= deadline) break;
      await sleep(Math.min(POLL_MS, deadline - now()));
    }
    const unread = failed.length
      ? `\n\nCould not read ${failed.map(({ address, reason }) => `${address} (${neutralizeTags(clip(reason, 200))})`).join(", ")}.`
      : "";
    if (!found.length) {
      const what = [filters.from && `from ${filters.from}`, filters.subject && `with "${filters.subject}" in the subject`].filter(Boolean).join(" ");
      return `No messages${what ? ` ${what}` : ""} in the last ${minutes} minutes in ${addresses.join(", ")}${wait ? ` after waiting ${wait} seconds` : ""}.${unread}`;
    }
    const at = now();
    return clip(`${UNTRUSTED_NOTE}\n\n${found.map(({ message, address }) => formatMessage(message, address, at)).join("\n\n")}`, MAX_OUTPUT) + unread;
  }

  return { recent };
}

function emailToolDefinitions(tools) {
  return [
    {
      name: "email_recent",
      description:
        "Read the newest messages in the user's mailbox through Milagre's own Email connector, such as a sign-in code or link a service just sent: use it instead of asking the user for the code. Read-only: messages stay unread. Searches the inbox and junk folder, newest first. Filter by sender and subject so older messages don't match; set waitSeconds to wait for a message that hasn't arrived yet.",
      input: {
        from: z.string().optional().describe("Part of the sender's address or name, such as noreply@github.com or github."),
        subject: z.string().optional().describe("Part of the subject, such as code or verify."),
        withinMinutes: z.number().int().min(1).max(MAX_WITHIN_MINUTES).optional().describe("How far back to look, in minutes (default 10, at most 1440)."),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_SECONDS)
          .optional()
          .describe("Wait up to this many seconds for a matching message to arrive (default 0, at most 120)."),
        limit: z.number().int().min(1).max(10).optional().describe("How many messages to return (default 3)."),
        mailbox: z.string().optional().describe("A connected mailbox's address; by default, every mailbox this Chat may read."),
      },
      readOnly: true,
      run: (input) => tools.recent(input),
    },
  ];
}

const SECRET_FILE = /^\d+-[a-f0-9-]+\.secret$/;

/** The app password from a request_secret file. Only files request_secret wrote count, so no other file can be sent to a mail server. */
function readSecretFile(file, secretsDir) {
  let real;
  let dir;
  try {
    real = fs.realpathSync(String(file));
    dir = fs.realpathSync(secretsDir);
  } catch {
    throw new Error("That secret file is gone. Ask for the app password again with request_secret.");
  }
  if (path.dirname(real) !== dir || !SECRET_FILE.test(path.basename(real))) throw new Error("passwordFile must be the file milagre request_secret returned.");
  return { password: fs.readFileSync(real, "utf8").trim(), file: real };
}

/** `email_connect`: saves a mailbox for the Email connector, reading its app password from a request_secret file so it never enters the transcript. */
function emailConnectDefinition({ email, secretsDir }) {
  return {
    name: "email_connect",
    description:
      "Connect a mailbox to Milagre's Email connector so email_recent can read its sign-in codes. Get the app password with milagre request_secret and pass the file it returns; never put a password in a tool call or reply. Milagre signs in once to check it before saving.",
    input: {
      address: z.string().describe("The mail address, like you@gmail.com."),
      passwordFile: z.string().describe("The file milagre request_secret returned with the app password."),
      host: z.string().optional().describe("The IMAP server; by default the provider's, like imap.gmail.com."),
      port: z.number().int().min(1).max(65535).optional().describe("The IMAP port (default 993)."),
    },
    readOnly: false,
    run: async ({ address, passwordFile, host, port }) => {
      const secret = readSecretFile(passwordFile, secretsDir);
      const saved = await email.connect({ address, password: secret.password, host, port });
      fs.rmSync(secret.file, { force: true });
      return `Connected ${saved.address} (${saved.host}:${saved.port}) and deleted the secret file. Agents can read its recent messages with email_recent once their next session starts.`;
    },
  };
}

module.exports = { createEmailTools, emailToolDefinitions, emailConnectDefinition };
