const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { z } = require("zod");
const { preparePrivateDirectory, assertPrivate } = require("./private-files.cjs");

const SECRET_TTL = 24 * 60 * 60 * 1000;
const REQUEST_TTL = 5 * 60 * 1000;
const PREFIX = "milagre-secret-";
const isSecretRequest = (id) => typeof id === "string" && id.startsWith(PREFIX);

// Values never enter Chat state, provider answers, tool arguments or log messages. Only the
// resulting path leaves this module. File permissions protect against other OS users, not
// other processes running as this user (including agents with unrestricted filesystem access).
function createChatSecrets({ directory, send, active, now = Date.now }) {
  const pending = new Map();
  const timers = new Map();
  let closed = false;
  preparePrivateDirectory(directory);

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

  function settle(id, outcome, result) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    void send(entry.chatId, {
      type: "question-resolved",
      requestId: id,
      outcome,
    });
    entry.resolve(result);
    return true;
  }

  function request(chatId, { title, description }) {
    if (closed || !active(chatId)) throw new Error("A secret can only be requested by a running Chat.");
    if ([...pending.values()].some((entry) => entry.chatId === chatId)) throw new Error("This Chat already has a pending secret request.");
    const requestId = PREFIX + randomUUID();
    const expiresAt = now() + REQUEST_TTL;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settle(requestId, "cancelled", "Secret request expired. No secret was saved."), REQUEST_TTL);
      timer.unref();
      pending.set(requestId, { chatId, resolve, timer, expiresAt });
      Promise.resolve(
        send(chatId, {
          type: "question-request",
          requestId,
          secretRequest: { description, expiresAt },
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

  function answer(chatId, id, answers) {
    const entry = pending.get(id);
    if (!entry || entry.chatId !== chatId || closed) return false;
    // Timers can be delayed while the computer sleeps. Check the deadline again before writing.
    if (now() >= entry.expiresAt) {
      settle(id, "cancelled", "Secret request expired. No secret was saved.");
      return false;
    }
    if (answers === null) return settle(id, "dismissed", "The user declined. No secret was saved. Continue without it.");
    if (
      !answers ||
      Object.keys(answers).length !== 1 ||
      !Array.isArray(answers.secret) ||
      answers.secret.length !== 1 ||
      typeof answers.secret[0] !== "string" ||
      !answers.secret[0].trim() ||
      answers.secret[0].length > 10_000
    )
      throw new Error("Enter a secret of at most 10,000 characters.");
    const expiresAt = now() + SECRET_TTL;
    const file = path.join(directory, `${expiresAt}-${randomUUID()}.secret`);
    let fd;
    try {
      assertPrivate(directory);
      fd = fs.openSync(file, "wx", 0o600);
      // On Windows this verifies the protected directory's inherited ACL before writing.
      assertPrivate(file);
      fs.writeFileSync(fd, answers.secret[0], "utf8");
      fs.fsyncSync(fd);
    } catch {
      if (fd !== undefined) fs.closeSync(fd);
      try {
        fs.unlinkSync(file);
      } catch {
        /* Nothing was published. */
      }
      throw new Error("Could not save the secret privately. Check this computer's storage and try again.");
    }
    fs.closeSync(fd);
    expire(file, expiresAt);
    return settle(
      id,
      "answered",
      JSON.stringify({
        path: file,
        expiresAt: new Date(expiresAt).toISOString(),
        instructions:
          "Read this file only inside the command that needs the secret. Never print, echo, log, paste into chat, or commit its contents. Do not use a file-reading tool that returns the contents to the model. Delete the file when finished; Milagre removes it after 24 hours while running, or on its next start.",
      }),
    );
  }

  function cancel(chatId) {
    for (const [id, entry] of pending) if (entry.chatId === chatId) settle(id, "cancelled", "Secret request cancelled. No secret was saved.");
  }

  return {
    answer,
    cancel,
    definitions: (chatId) => [
      {
        name: "request_secret",
        description:
          "Ask the user for a password, API token or other secret in a masked field on desktop or phone. Waits for Save securely or Decline (up to 5 minutes). The value stays out of chat and model context; returns only a private file path, available for 24 hours. Explain why it is needed and how to obtain it. Never ask the user to paste secrets into ordinary chat or question tools.",
        input: {
          title: z.string().trim().min(1).max(160),
          description: z.string().trim().min(1).max(2000),
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
