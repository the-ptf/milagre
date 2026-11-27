const PROVIDERS = [
  { pattern: /^(gmail|googlemail)\.com$/, host: "imap.gmail.com", name: "Google", appPasswordUrl: "https://myaccount.google.com/apppasswords" },
  { pattern: /^(icloud|me|mac)\.com$/, host: "imap.mail.me.com", name: "Apple", appPasswordUrl: "https://support.apple.com/en-us/102654" },
  { pattern: /^(fastmail\.(com|fm)|messagingengine\.com)$/, host: "imap.fastmail.com", name: "Fastmail" },
  {
    pattern: /^(yahoo\.[a-z.]+|ymail\.com)$/,
    host: "imap.mail.yahoo.com",
    name: "Yahoo",
    appPasswordUrl: "https://login.yahoo.com/myaccount/security/app-password",
  },
  { pattern: /^aol\.com$/, host: "imap.aol.com", name: "AOL" },
  { pattern: /^zoho(mail)?\.(com|eu)$/, host: "imap.zoho.com", name: "Zoho" },
];

export const EMAIL_CONNECTOR_ID = "email";
export const EMAIL_DESCRIPTION = "Lets agents read sign-in codes and links from your inbox. Read-only, recent messages only.";
export const EMAIL_APP_PASSWORD_HINT =
  "Use an app password, not your account password. Milagre signs in over IMAP, reads only recent messages when an agent asks, and never marks them read.";

const domainOf = (address) =>
  String(address ?? "")
    .split("@")
    .pop()
    .trim()
    .toLowerCase();

/** The IMAP server a mail address most likely uses: a known provider's, else `imap.<domain>`. Empty without a domain. */
export function guessImapHost(address) {
  const domain = String(address ?? "").includes("@") ? domainOf(address) : "";
  if (!domain) return "";
  return PROVIDERS.find((provider) => provider.pattern.test(domain))?.host ?? `imap.${domain}`;
}

/** Where the address's provider makes app passwords, when Milagre knows it. */
export function appPasswordLink(address) {
  const domain = domainOf(address);
  const provider = PROVIDERS.find((item) => item.pattern.test(domain));
  return provider?.appPasswordUrl ? { name: provider.name, url: provider.appPasswordUrl } : null;
}

export const EMAIL_CONFIGURE_LABEL = "Configure for me";
export const EMAIL_CONFIGURE_HINT =
  "An agent opens your provider's app password page, makes one for Milagre and connects the mailbox. You sign in and paste the password.";

/** The first message of the Chat that Configure for me starts: an agent makes an app password and connects the mailbox with email_connect. */
export function emailSetupPrompt(address) {
  const known = String(address ?? "").trim();
  const link = known ? appPasswordLink(known) : null;
  const host = known.includes("@") ? guessImapHost(known) : "";
  return [
    `Connect ${known || "my email"} to Milagre's Email connector, so agents can read sign-in codes from it.`,
    "",
    known ? "" : "1. Ask me which address to connect.",
    `${known ? "1" : "2"}. Open ${link ? `${link.name}'s app password page (${link.url})` : "my mail provider's app password page"} in the browser I'm signed in to: use the milagre desktop tools (computer use) when you have them, otherwise the Browser panel. If it asks me to sign in, stop and let me do it; never type my account password. If app passwords need 2-Step Verification first, tell me and help me turn it on.`,
    `${known ? "2" : "3"}. Create an app password named Milagre. Don't repeat it in your replies.`,
    `${known ? "3" : "4"}. Ask me for it with milagre request_secret ("Paste the app password ${link ? link.name : "your provider"} just showed").`,
    `${known ? "4" : "5"}. Call milagre email_connect with the address, the file request_secret returned${host ? ` and host ${host}` : " and the provider's IMAP server"}. If it fails, read the error and fix the server or password.`,
    `${known ? "5" : "6"}. Tell me when it's connected.`,
  ]
    .filter((line, index) => line || index === 1)
    .join("\n");
}
