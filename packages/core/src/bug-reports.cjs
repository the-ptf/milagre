// Reporting a Milagre bug from a Chat (issue #938). The agent calls report_milagre_bug with what Milagre did; the host
// adds what it knows itself (version, OS, provider and model, the host log), replaces everything that identifies the
// user's work (bug-report-redact.cjs), and shows the user the exact text. Nothing is posted until they approve it, and
// text they edit is checked again first. It is filed under their own GitHub account: with gh when it is signed in,
// otherwise as a prefilled new-issue page they submit themselves.
const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { z } = require("zod");
const { MILAGRE_REPO, BUG_REPORT_FEATURES, placeholderCount } = require("@milagre/shared/bug-report");
const { redactFields, isClean } = require("./bug-report-redact.cjs");
const { kindOf, lanes } = require("./process-lanes.cjs");

const PREFIX = "milagre-bug-report-";
const isBugReportRequest = (id) => typeof id === "string" && id.startsWith(PREFIX);
const REQUEST_TTL = 15 * 60 * 1000;
const TITLE_LIMIT = 160;
const BODY_LIMIT = 30_000;
const LOG_LINES = 25;
const LOG_LINE_LIMIT = 300;
const LOG_BYTES = 64 * 1024;
// GitHub's new-issue page takes the report in its address; past about 8 KB it fails to open.
const URL_LIMIT = 7500;
const GH_TIMEOUT = 60_000;
// Host log lines that say nothing about a bug: start-up handshakes and Node's hints about its own warnings.
const LOG_NOISE = [/^\{"status":"ready"/, /^\(Use `.* --trace-(?:warnings|deprecation) \.\.\.`/, /CLAUDE_SDK_CAN_USE_TOOL_SHADOWED/, /^\s*$/];

const fence = (text) => String(text).replaceAll("```", "'''");

/**
 * The host log's last lines worth reading, oldest first: noise dropped, repeats folded into one line with a count. The
 * log has no timestamps or Chat ids, so these are the host's latest lines, whichever Chat wrote them.
 * @param {string} file
 */
async function readHostLog(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, LOG_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (size > length) lines.shift();
    return foldLog(lines);
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** @param {string[]} lines */
function foldLog(lines) {
  const counts = new Map();
  for (const raw of lines) {
    const line = raw.trimEnd().slice(0, LOG_LINE_LIMIT);
    if (LOG_NOISE.some((pattern) => pattern.test(line))) continue;
    // The latest repeat decides where a line sits.
    const count = (counts.get(line) ?? 0) + 1;
    counts.delete(line);
    counts.set(line, count);
  }
  return [...counts].slice(-LOG_LINES).map(([line, count]) => (count > 1 ? `${line} (×${count})` : line));
}

function prefilledUrl(repo, title, body) {
  const at = (text) => `https://github.com/${repo}/issues/new?${new URLSearchParams({ title, body: text })}`;
  let url = at(body);
  if (url.length <= URL_LIMIT) return url;
  // The host log goes first, then the end of the text.
  const withoutLog = body.replace(/\n*<details>[\s\S]*?<\/details>\n*/, "\n\n");
  url = at(withoutLog);
  for (let keep = withoutLog.length; url.length > URL_LIMIT && keep > 200; keep = Math.floor(keep * 0.8))
    url = at(`${withoutLog.slice(0, keep)}\n\n(Shortened to fit GitHub's new-issue link.)`);
  return url;
}

function runProgram(command, args, { input, timeout = GH_TIMEOUT, env = process.env, execFile = childProcess.execFile } = {}) {
  const start = () =>
    new Promise((resolve) => {
      let child;
      try {
        child = execFile(
          command,
          args,
          { env: { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" }, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => resolve({ ok: !error, missing: error?.code === "ENOENT", stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
        );
      } catch (error) {
        resolve({ ok: false, missing: error.code === "ENOENT", stdout: "", stderr: error.message });
        return;
      }
      child.stdin?.on("error", () => {});
      child.stdin?.end(input ?? "");
    });
  const kind = kindOf(command);
  return kind ? lanes.run(kind, start) : start();
}

/**
 * Files the approved report under the user's GitHub account: with gh, or, when gh is missing, signed out or fails, as
 * the prefilled new-issue page the user submits.
 * @returns {Promise<{ posted: true; url: string } | { posted: false; openUrl: string; reason: string }>}
 */
async function postWithGh({ repo, title, body }, { run = runProgram, gh = "gh" } = {}) {
  const fallback = (reason) => ({ posted: false, openUrl: prefilledUrl(repo, title, body), reason });
  const status = await run(gh, ["auth", "status", "--hostname", "github.com"], { timeout: 15_000 });
  if (status.missing) return fallback("The GitHub CLI (gh) isn't installed on this computer.");
  if (!status.ok) return fallback("The GitHub CLI (gh) isn't signed in to github.com on this computer.");
  const created = await run(gh, ["issue", "create", "--repo", repo, "--title", title, "--body-file", "-"], { input: body });
  const url = created.stdout.match(/https:\/\/github\.com\/\S+\/issues\/\d+/)?.[0];
  if (created.ok && url) return { posted: true, url };
  return fallback(`gh couldn't create the issue${created.stderr.trim() ? `: ${created.stderr.trim().split("\n").at(-1).slice(0, 200)}` : "."}`);
}

/**
 * The Git name and email a folder commits as (its own config, else the user's), for the redactor. The read surface
 * refuses `git config`, so it goes through the write one, reading only.
 */
async function gitIdentity(folder, { git = require("./git/client.cjs").createGit() } = {}) {
  const read = async (key) => {
    const result = await git.write.run(folder, ["config", "--get", key]).catch(() => null);
    return result?.ok ? result.stdout.trim() || undefined : undefined;
  };
  const [name, email] = await Promise.all([read("user.name"), read("user.email")]);
  return { name, email };
}

/** "macOS 27.0 (arm64)": the OS line of a report. */
async function osDescription({ platform = process.platform, arch = process.arch, release = require("node:os").release(), run = runProgram } = {}) {
  if (platform === "darwin") {
    const product = await run("sw_vers", ["-productVersion"], { timeout: 3000 });
    return `macOS ${product.ok && product.stdout.trim() ? product.stdout.trim() : `(Darwin ${release})`} (${arch})`;
  }
  return `${platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform} ${release} (${arch})`;
}

/**
 * What the host knows is the user's, as `{ kind, value }` for the redactor: every Project this computer knows with its
 * folder, name and Git origin's owner and repository; the Chat's Project's Worktrees, branches and Chat titles; this
 * computer's and paired computers' names; the home folder, user name, Git identity and signed-in account emails.
 * @param {{
 *   projects?: { path?: string; name?: string; origin?: string | null }[];
 *   state?: { worktrees?: Record<string, any>; sessions?: Record<string, any> } | null;
 *   computers?: (string | undefined)[];
 *   hostname?: string;
 *   home?: string;
 *   username?: string;
 *   gitName?: string;
 *   gitEmail?: string;
 *   emails?: (string | undefined)[];
 * }} input
 */
function knownValues({ projects = [], state, computers = [], hostname, home, username, gitName, gitEmail, emails = [] }) {
  const values = [];
  const add = (kind, value) => {
    if (typeof value === "string" && value.trim()) values.push({ kind, value: value.trim() });
  };
  const base = (folder) => (typeof folder === "string" ? folder.split(/[/\\]/).findLast(Boolean) : undefined);
  for (const project of projects) {
    add("project", project.path);
    add("project", project.name);
    add("project", base(project.path));
    const [, ...owners] = String(project.origin ?? "").split("/");
    const repo = owners.pop();
    for (const owner of owners) add("org", owner);
    add("repo", repo);
  }
  for (const worktree of Object.values(state?.worktrees ?? {})) {
    add("worktree", worktree.path);
    add("worktree", base(worktree.path));
    add("branch", worktree.name);
    add("branch", worktree.generatedBranch);
    add("branch", worktree.branchSuffix);
  }
  for (const session of Object.values(state?.sessions ?? {})) {
    add("chat", session.title);
    add("chat", session.generatedTitle);
    add("worktree", session.formerWorktree?.path);
    add("branch", session.formerWorktree?.branch);
    // A Link Chat's Worktrees in each of its Projects, and the folder that holds them.
    add("worktree", session.workspacePath);
    for (const member of Array.isArray(session.worktrees) ? session.worktrees : []) {
      add("worktree", member?.worktreePath);
      add("project", member?.projectPath);
      add("project", base(member?.projectPath));
      add("branch", member?.branch);
    }
  }
  for (const name of computers) add("computer", name);
  add("host", hostname);
  add("host", hostname?.replace(/\.local$/i, ""));
  add("home", home);
  add("person", username);
  add("person", gitName);
  for (const part of String(gitName ?? "").split(/\s+/)) add("person", part);
  add("email", gitEmail);
  for (const email of emails) add("email", email);
  return values;
}

const INPUT = {
  title: z.string().trim().min(1).max(120).describe("A plain, specific title about what Milagre did wrong."),
  feature: z.enum(Object.keys(BUG_REPORT_FEATURES)).describe("The part of Milagre the bug is in."),
  what_happened: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("What Milagre did, in Milagre's terms (a Chat, a Delegation, a Worktree, a card). Never the user's code, files, repository or task."),
  expected: z.string().trim().max(1000).optional().describe("What Milagre should have done."),
  steps: z.array(z.string().trim().min(1).max(300)).max(10).optional().describe("Steps to reproduce, in Milagre's terms."),
  error_text: z.string().trim().max(2000).optional().describe("The exact error text Milagre showed, if any."),
};

/** The report as the user will see it, before redaction: one field per part, so each is redacted on its own. */
function reportFields(input, facts, log) {
  const environment = [
    `- Milagre: ${facts.version || "unknown"}`,
    `- OS: ${facts.os || "unknown"}`,
    facts.provider ? `- Agent: ${[facts.provider, facts.model, facts.effort && `effort ${facts.effort}`].filter(Boolean).join(" · ")}` : null,
    facts.permissionMode ? `- Permission mode: ${facts.permissionMode}` : null,
    facts.babysit ? `- Babysit level: ${facts.babysit}` : null,
    `- Feature: ${BUG_REPORT_FEATURES[input.feature] ?? BUG_REPORT_FEATURES.other}`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    title: input.title,
    happened: input.what_happened,
    expected: input.expected ?? "",
    steps: (input.steps ?? []).map((step, index) => `${index + 1}. ${step}`).join("\n"),
    error: fence(input.error_text ?? ""),
    environment,
    log: fence(log.join("\n")),
  };
}

function assemble(fields) {
  const parts = [fields.happened];
  if (fields.expected) parts.push(`### Expected\n\n${fields.expected}`);
  if (fields.steps) parts.push(`### Steps to reproduce\n\n${fields.steps}`);
  if (fields.error) parts.push(`### Error\n\n\`\`\`text\n${fields.error}\n\`\`\``);
  parts.push(`### Environment\n\n${fields.environment}`);
  if (fields.log) parts.push(`<details>\n<summary>Host log, last lines (redacted)</summary>\n\n\`\`\`text\n${fields.log}\n\`\`\`\n\n</details>`);
  parts.push("---\n\nFiled from a Milagre Chat. Milagre replaced the reporter's private details with placeholders before posting.");
  return parts.join("\n\n");
}

/**
 * Redacts until nothing more is replaced: a report is posted only when checking it again changes nothing, so the text
 * the user approves is the text that goes out.
 */
function settled(title, body, known, names) {
  for (let pass = 0; pass < 3 && !(isClean(title, known) && isClean(body, known)); pass++) {
    const result = redactFields({ title, body }, known, { keepCode: ["title", "body"], seed: names });
    ({ title, body } = result.fields);
    names = result.names;
  }
  return isClean(title, known) && isClean(body, known) ? { title, body, names } : null;
}

/**
 * @param {{
 *   send: (chatId: string, event: object) => unknown;
 *   active: (chatId: string) => boolean;
 *   facts: (chatId: string) => Promise<{ version?: string; os?: string; provider?: string; model?: string; effort?: string; permissionMode?: string; babysit?: string }>;
 *   known: (chatId: string) => Promise<{ kind: string; value: string }[]>;
 *   readLog?: () => Promise<string[]>;
 *   post?: (report: { repo: string; title: string; body: string }) => Promise<{ posted: true; url: string } | { posted: false; openUrl: string; reason: string }>;
 *   repo?: string;
 *   now?: () => number;
 * }} options
 */
function createBugReports({ send, active, facts, known, readLog = async () => [], post = postWithGh, repo = MILAGRE_REPO, now = Date.now }) {
  /** @type {Map<string, { chatId: string; resolve: (result: string) => void; timer: NodeJS.Timeout; expiresAt: number; known: { kind: string; value: string }[] }>} */
  const pending = new Map();
  // A reservation belongs to this invocation, not merely to an active Chat. A stop followed by a new turn
  // invalidates the old collection even when that Chat is active again before its facts arrive.
  const preparing = new Map();
  let closed = false;

  function show(requestId, chatId, { title, body, expiresAt, recheck = false }) {
    return send(chatId, {
      type: "question-request",
      requestId,
      bugReport: { repo, title, body, expiresAt, redactions: placeholderCount(`${title}\n${body}`), ...(recheck ? { recheck: true } : {}) },
      questions: [{ id: "report", header: "Bug report", question: "Report a Milagre bug", options: [], multiSelect: false, allowOther: true }],
    });
  }

  function settle(id, outcome, result) {
    const entry = pending.get(id);
    if (!entry) return null;
    pending.delete(id);
    clearTimeout(entry.timer);
    void send(entry.chatId, { type: "question-resolved", requestId: id, outcome });
    if (result !== undefined) entry.resolve(result);
    return entry;
  }

  async function request(chatId, input) {
    if (closed || !active(chatId)) throw new Error("A bug report can only be started by a running Chat.");
    if (preparing.has(chatId) || [...pending.values()].some((entry) => entry.chatId === chatId))
      throw new Error("This Chat already has a bug report waiting for the user.");
    return new Promise((resolve, reject) => {
      const reservation = { resolve };
      preparing.set(chatId, reservation);
      const collect = async () => {
        const [about, values, log] = await Promise.all([facts(chatId), known(chatId), readLog().catch(() => [])]);
        if (preparing.get(chatId) !== reservation) return;
        if (closed || !active(chatId)) {
          cancel(chatId);
          return;
        }
        const { fields, names } = redactFields(reportFields(input, about, log), values, { keepCode: ["error", "environment", "log"] });
        const report = settled(fields.title, assemble(fields), values, names);
        if (!report) throw new Error("Milagre couldn't make this report safe to share. Describe the bug in plainer words and try again.");
        const requestId = PREFIX + randomUUID();
        const expiresAt = now() + REQUEST_TTL;
        const timer = setTimeout(() => settle(requestId, "cancelled", "The bug report expired before the user approved it. Nothing was posted."), REQUEST_TTL);
        timer.unref?.();
        preparing.delete(chatId);
        const entry = { chatId, resolve, timer, expiresAt, known: values, names: report.names, shown: { title: report.title, body: report.body } };
        pending.set(requestId, entry);
        try {
          await show(requestId, chatId, { title: report.title, body: report.body, expiresAt });
        } catch {
          if (pending.get(requestId) !== entry) return;
          pending.delete(requestId);
          clearTimeout(timer);
          reject(new Error("Could not show the bug report. Try again."));
        }
      };
      void collect().catch((error) => {
        if (preparing.get(chatId) !== reservation) return;
        preparing.delete(chatId);
        reject(error);
      });
    });
  }

  /**
   * The user's answer: null cancels; `{ title: [..], body: [..] }` is the text they approved, edited or not. Text that
   * needs more replaced comes back to them as a new request instead of going out.
   */
  function answer(chatId, id, answers) {
    const entry = pending.get(id);
    if (!entry || entry.chatId !== chatId || closed) return false;
    if (!active(chatId)) {
      cancel(chatId);
      return false;
    }
    if (now() >= entry.expiresAt) {
      settle(id, "cancelled", "The bug report expired before the user approved it. Nothing was posted.");
      return false;
    }
    if (answers === null) {
      settle(id, "dismissed", "The user cancelled the bug report. Nothing was posted; don't file it any other way.");
      return true;
    }
    const title = answers?.title?.[0];
    const body = answers?.body?.[0];
    if (typeof title !== "string" || !title.trim() || title.length > TITLE_LIMIT || typeof body !== "string" || !body.trim() || body.length > BODY_LIMIT)
      throw new Error(`Give the report a title (up to ${TITLE_LIMIT} characters) and a description (up to ${BODY_LIMIT.toLocaleString("en-US")}).`);
    const clean = isClean(title, entry.known) && isClean(body, entry.known);
    if (!clean) {
      const checked = settled(title.trim(), body, entry.known, entry.names);
      if (!checked) throw new Error("Milagre couldn't make the edited report safe to share. Remove the private details and try again.");
      // The same wait continues under a new request, so the card that was answered closes and the new one shows.
      const next = PREFIX + randomUUID();
      settle(id, "answered");
      const timer = setTimeout(
        () => settle(next, "cancelled", "The bug report expired before the user approved it. Nothing was posted."),
        entry.expiresAt - now(),
      );
      timer.unref?.();
      pending.set(next, { ...entry, timer, names: checked.names });
      void show(next, chatId, { title: checked.title, body: checked.body, expiresAt: entry.expiresAt, recheck: true });
      return true;
    }
    settle(id, "answered");
    // The agent hears the user changed it, so it doesn't take the differences for a mistake.
    const edited = title.trim() !== entry.shown.title || body !== entry.shown.body;
    const note = edited ? " The user edited the report before approving it; that text is what went out, so don't point out the differences." : "";
    void post({ repo, title: title.trim(), body }).then(
      (result) =>
        entry.resolve(
          JSON.stringify(
            result.posted
              ? {
                  posted: true,
                  url: result.url,
                  ...(edited ? { editedByUser: true } : {}),
                  instructions: `Give the user the issue link. If they have screenshots, they can add them on GitHub after checking them for private details.${note}`,
                }
              : {
                  posted: false,
                  reason: result.reason,
                  openUrl: result.openUrl,
                  ...(edited ? { editedByUser: true } : {}),
                  instructions: `Nothing was posted yet. Say why in one line, then give openUrl as a short Markdown link such as [Open the report on GitHub](openUrl), never the raw address: it opens GitHub's new-issue page with the approved report filled in, to submit under their own account. Don't post it any other way.${note}`,
                },
          ),
        ),
      (error) => entry.resolve(`The report was approved but couldn't be posted: ${error.message}`),
    );
    return true;
  }

  function cancel(chatId) {
    const reservation = preparing.get(chatId);
    if (reservation) {
      preparing.delete(chatId);
      reservation.resolve("The bug report was cancelled. Nothing was posted.");
    }
    for (const [id, entry] of pending) if (entry.chatId === chatId) settle(id, "cancelled", "The bug report was cancelled. Nothing was posted.");
  }

  return {
    answer,
    cancel,
    definitions: (chatId) => [
      {
        name: "report_milagre_bug",
        description:
          "Report a bug in Milagre itself (not in the user's project) to Milagre's public GitHub tracker, when the user asks. Describe only what Milagre did, in Milagre's terms: never the user's code, diffs, files, repository, organisation, branches, people or what they are building. Milagre adds its version, OS, provider, model and recent host log lines, replaces anything that identifies the user's work with placeholders, and shows the user the exact text to edit and approve. Waits for them (up to 15 minutes). Returns the new issue's link, or a prefilled GitHub link for the user to submit when gh can't post, or that they cancelled. Never file a Milagre bug with gh or the GitHub API directly.",
        input: INPUT,
        readOnly: false,
        run: (input) => request(chatId, input),
      },
    ],
    close() {
      closed = true;
      for (const chatId of preparing.keys()) cancel(chatId);
      for (const entry of pending.values()) cancel(entry.chatId);
    },
  };
}

module.exports = { createBugReports, isBugReportRequest, postWithGh, prefilledUrl, readHostLog, foldLog, knownValues, osDescription, gitIdentity, REQUEST_TTL };
