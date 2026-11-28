const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { z } = require("zod");
const { preparePrivateDirectory, assertPrivate } = require("./private-files.cjs");
const { secretNameProblem } = require("@milagre/shared/secrets");

const SECRET_TTL = 24 * 60 * 60 * 1000;
const REQUEST_TTL = 5 * 60 * 1000;
const PREFIX = "milagre-secret-";
const isSecretRequest = (id) => typeof id === "string" && id.startsWith(PREFIX);

const SAVE_CHOICES = new Set(["project", "all", "none"]);

/**
 * Host-owned secret questions: `request_secret` (a value in a private file, optionally saved as a named secret through
 * `saveAs`) and `approveUse` (Allow or Deny one command's use of secrets marked to ask each time).
 */
function createChatSecrets({ directory, send, active, saveAs = null, onValue = null, now = Date.now }) {
  const pending = new Map();
  const timers = new Map();
  let closed = false;
  preparePrivateDirectory(directory);
  if (process.platform === "darwin") execFile("tmutil", ["addexclusion", directory], () => {});

  function expire(file, at) {
    clearTimeout(timers.get(file));
    const remove = () => {
      try {
        fs.unlinkSync(file);
        timers.delete(file);
      } catch (error) {
        if (error.code === "ENOENT") timers.delete(file);
        else timers.set(file, setTimeout(remove, 60_000));
      }
      timers.get(file)?.unref();
    };
    if (at <= now()) remove();
    else {
      timers.set(file, setTimeout(remove, Math.min(at - now(), SECRET_TTL)));
      timers.get(file).unref();
    }
  }
  // Expiry survives crashes/restarts without storing a second copy or reading any secret.
  for (const name of fs.readdirSync(directory)) {
    const match = /^(\d+)-[a-f0-9-]+\.secret$/.exec(name);
    if (match) expire(path.join(directory, name), Number(match[1]));
  }

  function claim(id) {
    const entry = pending.get(id);
    if (!entry) return null;
    pending.delete(id);
    clearTimeout(entry.timer);
    return entry;
  }

  function finish(entry, id, outcome, result) {
    void send(entry.chatId, { type: "question-resolved", requestId: id, outcome });
    entry.resolve(result);
    return true;
  }

  function settle(id, outcome, result) {
    const entry = claim(id);
    return entry ? finish(entry, id, outcome, result) : false;
  }

  async function request(chatId, { title, description, name }) {
    if (closed || !active(chatId)) throw new Error("A secret can only be requested by a running Chat.");
    if ([...pending.values()].some((entry) => entry.chatId === chatId)) throw new Error("This Chat already has a pending secret request.");
    const problem = name === undefined ? null : secretNameProblem(name);
    if (problem) throw new Error(`name: ${problem}`);
    const offer = name && saveAs ? await saveAs.offer(chatId, name) : null;
    const requestId = PREFIX + randomUUID();
    const expiresAt = now() + REQUEST_TTL;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settle(requestId, "cancelled", "Secret request expired. No secret was saved."), REQUEST_TTL);
      timer.unref();
      pending.set(requestId, { kind: "secret", chatId, resolve, timer, expiresAt, offer });
      Promise.resolve(
        send(chatId, {
          type: "question-request",
          requestId,
          secretRequest: { description, expiresAt, ...(offer ? { saveAs: offer } : {}) },
          questions: [
            {
              id: "secret",
              header: "Secret",
              question: title,
              options: [],
              multiSelect: false,
              allowOther: true,
              secret: true,
            },
          ],
        }),
      ).catch(() => {
        pending.delete(requestId);
        clearTimeout(timer);
        reject(new Error("Could not show the secret request. Try again."));
      });
    });
  }

  function approveUse(chatId, { names, command }) {
    if (closed || !active(chatId)) return Promise.resolve(false);
    const requestId = PREFIX + randomUUID();
    const expiresAt = now() + REQUEST_TTL;
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(requestId, "cancelled", false), REQUEST_TTL);
      timer.unref();
      pending.set(requestId, { kind: "use", chatId, resolve, timer, expiresAt });
      Promise.resolve(
        send(chatId, {
          type: "question-request",
          requestId,
          questions: [
            {
              id: "use",
              header: "Secret",
              question: `Let the agent use ${names.join(", ")} for this command?${command ? ` ${command.slice(0, 200)}` : ""}`,
              options: [
                { label: "Allow", description: "Only this command gets the value." },
                { label: "Deny", description: "The command doesn't run." },
              ],
              multiSelect: false,
              allowOther: false,
              secret: false,
            },
          ],
        }),
      ).catch(() => settle(requestId, "cancelled", false));
    });
  }

  async function answer(chatId, id, answers) {
    const entry = pending.get(id);
    if (!entry || entry.chatId !== chatId || closed) return false;
    if (now() >= entry.expiresAt) {
      settle(id, "cancelled", entry.kind === "use" ? false : "Secret request expired. No secret was saved.");
      return false;
    }
    if (entry.kind === "use") return settle(id, answers === null ? "dismissed" : "answered", answers?.use?.[0] === "Allow");
    if (answers === null) return settle(id, "dismissed", "The user declined. No secret was saved. Continue without it.");
    const save = answers?.save?.[0] ?? "none";
    if (!SAVE_CHOICES.has(save) || (save !== "none" && !entry.offer) || (save === "project" && !entry.offer?.project))
      throw new Error("Choose where to save the secret.");
    if (
      !answers ||
      Object.keys(answers).some((key) => key !== "secret" && key !== "save") ||
      !Array.isArray(answers.secret) ||
      answers.secret.length !== 1 ||
      typeof answers.secret[0] !== "string" ||
      !answers.secret[0].trim() ||
      answers.secret[0].length > 10_000
    )
      throw new Error("Enter a secret of at most 10,000 characters.");
    const value = answers.secret[0];
    claim(id);
    onValue?.(value);
    try {
      if (save === "none") return finish(entry, id, "answered", oneOffFile(value));
      const name = entry.offer.name;
      const failure = await saveAs.save(chatId, { name, value, scope: save, expectVersion: entry.offer.version ?? 0 }).then(
        () => null,
        (error) => error,
      );
      if (failure) return finish(entry, id, "answered", oneOffFile(value, `It couldn't be saved as ${name}: ${failure.message}`));
      return finish(
        entry,
        id,
        "answered",
        JSON.stringify({
          saved: name,
          instructions: `Saved as ${name}; no file was written. Run the command that needs it with \`milagre-secrets run --with ${name} -- <command>\`. Never print it.`,
        }),
      );
    } catch (error) {
      finish(entry, id, "cancelled", `The secret couldn't be stored: ${error.message}`);
      throw error;
    }
  }

  function oneOffFile(value, saved) {
    const expiresAt = now() + SECRET_TTL;
    const file = path.join(directory, `${expiresAt}-${randomUUID()}.secret`);
    let fd;
    try {
      assertPrivate(directory);
      fd = fs.openSync(file, "wx", 0o600);
      // On Windows this verifies the protected directory's inherited ACL before writing.
      assertPrivate(file);
      fs.writeFileSync(fd, value, "utf8");
      fs.fsyncSync(fd);
    } catch {
      if (fd !== undefined) fs.closeSync(fd);
      try {
        fs.unlinkSync(file);
      } catch {}
      throw new Error("Could not save the secret privately. Check this computer's storage and try again.");
    }
    fs.closeSync(fd);
    expire(file, expiresAt);
    return JSON.stringify({
      path: file,
      expiresAt: new Date(expiresAt).toISOString(),
      instructions:
        "Read this file only inside the command that needs the secret. Never print, echo, log, paste into chat, or commit its contents. Do not use a file-reading tool that returns the contents to the model. Delete the file when finished; Milagre removes it after 24 hours while running, or on its next start.",
      ...(saved ? { saved } : {}),
    });
  }

  function cancel(chatId) {
    for (const [id, entry] of pending)
      if (entry.chatId === chatId) settle(id, "cancelled", entry.kind === "use" ? false : "Secret request cancelled. No secret was saved.");
  }

  return {
    answer,
    approveUse,
    cancel,
    definitions: (chatId) => [
      {
        name: "request_secret",
        description:
          "Ask the user for a password, API token or other secret in a masked field on desktop or phone. Waits for Save securely or Decline (up to 5 minutes). The value stays out of chat and model context; returns only a private file path, available for 24 hours. Explain why it is needed and how to obtain it. Never ask the user to paste secrets into ordinary chat or question tools. Pass `name` (an environment variable name such as VERCEL_TOKEN) for a secret later Chats will need too: the user can also save it under that name.",
        input: {
          title: z.string().trim().min(1).max(160),
          description: z.string().trim().min(1).max(2000),
          name: z.string().trim().min(1).max(64).optional(),
        },
        readOnly: false,
        run: (input) => request(chatId, input),
      },
    ],
    close() {
      closed = true;
      for (const entry of pending.values()) cancel(entry.chatId);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

module.exports = { createChatSecrets, isSecretRequest, SECRET_TTL };
