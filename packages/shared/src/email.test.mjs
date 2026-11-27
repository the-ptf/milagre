import assert from "node:assert/strict";
import test from "node:test";
import { appPasswordLink, emailSetupPrompt, guessImapHost } from "./email.mjs";

test("known providers get their IMAP server and app password page; others get imap.<domain>", () => {
  assert.equal(guessImapHost("Me@GMail.com"), "imap.gmail.com");
  assert.equal(guessImapHost("me@icloud.com"), "imap.mail.me.com");
  assert.equal(guessImapHost("me@acme.dev"), "imap.acme.dev");
  assert.equal(guessImapHost("not an address"), "");
  assert.deepEqual(appPasswordLink("me@gmail.com"), { name: "Google", url: "https://myaccount.google.com/apppasswords" });
  assert.equal(appPasswordLink("me@acme.dev"), null);
});

test("the setup prompt keeps the password out of the transcript and names the tools", () => {
  const prompt = emailSetupPrompt("me@gmail.com");
  assert.match(prompt, /^Connect me@gmail\.com to Milagre's Email connector/);
  assert.match(prompt, /https:\/\/myaccount\.google\.com\/apppasswords/);
  assert.match(prompt, /never type my account password/);
  assert.match(prompt, /milagre request_secret/);
  assert.match(prompt, /milagre email_connect with the address, the file request_secret returned and host imap\.gmail\.com/);
  assert.match(emailSetupPrompt(""), /^Connect my email[^\n]*\n\n1\. Ask me which address to connect\./);
});
