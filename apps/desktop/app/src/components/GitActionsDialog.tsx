import { gitMessage } from "@milagre/shared/git-codes";
import { ipcErrorMessage } from "@milagre/shared/result";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, ArrowRight01Icon, Cancel01Icon, GitBranchIcon, LinkSquare02Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { ModelProvider } from "../model";
import { formatLineCount } from "../lib/chat-list";
import {
  dialogMode,
  gitRunNote,
  hookFailureMessage,
  prTargetLine,
  type DialogButton,
  type GitChanges,
  type GitChatContext,
  type GitRunResult,
  type GitStep,
} from "../lib/git-dialog";
import { ScrollArea } from "./primitives/ScrollArea";
import { useBridge } from "../lib/computer-bridge";

type IconData = ComponentProps<typeof HugeiconsIcon>["icon"];

function Icon({ icon, size = 14 }: { icon: IconData; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" />;
}

const GENERATION_FAILED = "Couldn't write a message. Type one to continue.";
const FOCUSABLE = 'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

type Fields = { commitMessage: string; prTitle: string; prBody: string };
type StepState = { step: GitStep; status: "running" | "done" | "failed"; detail?: string };
type Failure = { message: string; output?: string; hint?: string; hook?: boolean };

function Spinner({ size = 12 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2"
      style={{ width: size, height: size, animation: "spin 0.9s linear infinite" }}
    />
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="grid gap-1.5">
      <h3 className="text-[12px] font-medium text-ink-2">{label}</h3>
      {children}
    </section>
  );
}

const FIELD =
  "w-full rounded-control border border-line bg-field px-2.5 py-2 text-[13px] leading-5 text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-line-strong";

/** A text field that stays editable while its text is generated; the spinner sits inside it. Read-only while steps run. */
function GeneratedField({
  label,
  value,
  onChange,
  generating,
  readOnly,
  multiline,
  rows = 3,
  placeholder,
  mono,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  generating: boolean;
  readOnly: boolean;
  multiline?: boolean;
  rows?: number;
  placeholder: string;
  mono?: boolean;
}) {
  const spinner = generating && !value;
  const props = {
    value,
    readOnly,
    "aria-label": label,
    "aria-busy": spinner,
    placeholder: spinner ? "" : placeholder,
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    spellCheck: true,
  };
  return (
    <div className="relative">
      {multiline ? (
        <textarea {...props} rows={rows} className={`${FIELD} resize-y ${mono ? "font-mono text-[12.5px]" : ""}`} />
      ) : (
        <input {...props} className={FIELD} />
      )}
      {spinner && (
        <span className="pointer-events-none absolute left-2.5 top-2 flex h-5 items-center gap-1.5 text-[12px] text-ink-3">
          <Spinner />
          Writing…
        </span>
      )}
    </div>
  );
}

const STEP_COPY: Record<GitStep, { running: string; failed: string }> = {
  commit: { running: "Committing…", failed: "Commit failed" },
  push: { running: "Pushing…", failed: "Push failed" },
  pr: { running: "Opening PR…", failed: "Couldn't open the PR" },
};

function StepLine({ state, result }: { state: StepState; result: GitRunResult }) {
  const text = state.status === "running" ? STEP_COPY[state.step].running : state.status === "failed" ? STEP_COPY[state.step].failed : (state.detail ?? "");
  return (
    <li className="flex min-h-6 items-center gap-2 text-[13px]" data-step={state.step} data-status={state.status}>
      <span
        className={`flex size-4 shrink-0 items-center justify-center ${state.status === "failed" ? "text-red" : state.status === "done" ? "text-green" : "text-ink-3"}`}
      >
        {state.status === "running" ? <Spinner /> : <Icon icon={state.status === "done" ? Tick02Icon : Alert02Icon} size={14} />}
      </span>
      <span className={state.status === "running" ? "text-ink-2" : "text-ink"}>{text}</span>
      {state.step === "pr" && state.status === "done" && result.pr && (
        <a
          href={result.pr.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-w-0 items-center gap-1 truncate text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink"
        >
          <span className="truncate">{result.pr.url.replace(/^https?:\/\//, "")}</span>
          <Icon icon={LinkSquare02Icon} size={12} />
        </a>
      )}
    </li>
  );
}

function FileList({ changes }: { changes: Extract<GitChanges, { isRepo: true }> }) {
  if (!changes.files.length) {
    return (
      <p className="rounded-control border border-line bg-inset px-3 py-2 text-[12.5px] text-ink-2">
        No uncommitted changes.{changes.unpushed > 0 ? ` ${changes.unpushed} ${changes.unpushed === 1 ? "commit" : "commits"} to push.` : ""}
      </p>
    );
  }
  const added = changes.files.reduce((sum, file) => sum + file.added, 0);
  const removed = changes.files.reduce((sum, file) => sum + file.removed, 0);
  return (
    <div className="overflow-hidden rounded-control border border-line bg-inset">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-[12px] text-ink-2">
        <span>
          {changes.files.length} {changes.files.length === 1 ? "file" : "files"} changed
        </span>
        <span className="tabular-nums">
          <span className="text-diff-add">+{formatLineCount(added)}</span> <span className="text-diff-remove">−{formatLineCount(removed)}</span>
        </span>
      </div>
      <ScrollArea as="ul" chainScroll className="max-h-36 py-1">
        {changes.files.map((file) => (
          <li key={file.path} className="flex items-center gap-2 px-3 py-0.5 text-[12px]" title={file.path}>
            <span
              className={`w-3 shrink-0 font-mono font-semibold ${file.status === "added" ? "text-diff-add" : file.status === "deleted" ? "text-diff-remove" : "text-orange"}`}
            >
              {file.status === "added" ? "A" : file.status === "deleted" ? "D" : "M"}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-ink">{file.path}</span>
            {file.secret && (
              <span
                data-secret
                className="flex shrink-0 items-center gap-1 text-[11.5px] text-orange"
                title="This looks like a secret. Milagre won't commit it."
              >
                <Icon icon={Alert02Icon} size={12} />
                Secret?
              </span>
            )}
            <span className="shrink-0 tabular-nums text-ink-3">
              {file.added > 0 && <span className="text-diff-add">+{formatLineCount(file.added)}</span>}
              {file.added > 0 && file.removed > 0 && " "}
              {file.removed > 0 && <span className="text-diff-remove">−{formatLineCount(file.removed)}</span>}
            </span>
          </li>
        ))}
      </ScrollArea>
    </div>
  );
}

const BUTTON_PRIMARY =
  "inline-flex h-8 items-center gap-1.5 rounded-control bg-ink px-3 text-[12.5px] font-medium text-surface transition-opacity hover:opacity-85 disabled:cursor-default disabled:opacity-40";
const BUTTON_SECONDARY =
  "inline-flex h-8 items-center gap-1.5 rounded-control border border-line bg-surface px-3 text-[12.5px] font-medium text-ink-2 transition-colors hover:border-line-strong hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-40";

/**
 * "Commit and open PR": commits the chat's folder, pushes its branch and opens a PR, with a generated,
 * editable commit message and PR text. Milagre runs git and gh itself; the agent isn't asked.
 */
export function GitActionsDialog({
  projectName,
  cwd,
  base,
  provider,
  chat,
  turnRunning,
  onClose,
  onSendToAgent,
  onRan,
}: {
  /** The chat's folder: its worktree, or the project's checkout. */
  projectName?: string;
  cwd: string;
  /** The ref the worktree started from; the repo's default branch when absent. */
  base?: string;
  provider?: ModelProvider;
  chat: GitChatContext;
  /** The chat's agent is mid-turn: committing waits for it. */
  turnRunning: boolean;
  onClose: () => void;
  /** Sends a message to the chat: a new turn, or a steer when a turn is running. */
  onSendToAgent: (text: string) => void;
  /** Steps ran: the note to save in the chat. */
  onRan: (note: string) => void;
}) {
  const bridge = useBridge();
  const panelRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const started = useRef(false);
  const edited = useRef<Record<keyof Fields, boolean>>({ commitMessage: false, prTitle: false, prBody: false });
  const [changes, setChanges] = useState<GitChanges | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [fields, setFields] = useState<Fields>({ commitMessage: "", prTitle: "", prBody: "" });
  // The values a run uses are read here at click time, not from a render's closure.
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const [generating, setGenerating] = useState(false);
  /** Which fields came back without text: the note shows under them. */
  const [generationFailed, setGenerationFailed] = useState<{ commit: boolean; pr: boolean }>({ commit: false, pr: false });
  const [steps, setSteps] = useState<StepState[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [result, setResult] = useState<GitRunResult>({});
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [finished, setFinished] = useState(false);

  const repo = changes?.isRepo ? changes : null;
  const modeFor = (next: Extract<GitChanges, { isRepo: true }>, agentRunning: boolean) =>
    dialogMode({
      hasChanges: next.hasChanges,
      unpushed: next.unpushed,
      prOpen: Boolean(next.pr),
      onBase: next.onBase,
      hasOrigin: next.hasOrigin,
      ghReady: next.ghReady,
      ahead: next.ahead,
      base: next.base,
      ghMessage: next.ghMessage,
      detached: !next.branch,
      commitBlocked: next.commitBlocked,
      turnRunning: agentRunning,
    });
  const mode = repo ? modeFor(repo, turnRunning) : null;

  // A failure shows below the form, so bring it into view.
  const failureRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (failure) failureRef.current?.scrollIntoView({ block: "nearest" });
  }, [failure]);

  // Only the dialog takes input while it's open: the app behind it is inert.
  useEffect(() => {
    const root = document.getElementById("root");
    root?.setAttribute("inert", "");
    return () => root?.removeAttribute("inert");
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await bridge.git.changes({ cwd, base });
      if (mounted.current) setChanges(next);
      return next;
    } catch (error) {
      if (mounted.current) setReadError(ipcErrorMessage(error));
      return null;
    }
  }, [cwd, base, bridge.git]);

  // Read the folder, then write the text. The ref keeps StrictMode's second mount from asking twice.
  useEffect(() => {
    mounted.current = true;
    if (!started.current) {
      started.current = true;
      void (async () => {
        const next = await load();
        if (!next?.isRepo) return;
        // A running turn doesn't change which sections show, only which buttons work.
        const initial = modeFor(next, false);
        // Mid-merge (or rebase…) nothing can be committed yet, and the diff holds conflict markers.
        if (next.commitBlocked || (!initial.showCommit && !initial.showPrFields)) return;
        setGenerating(true);
        const text = await bridge.git.generate({ cwd, base, provider, chat }).catch(() => ({ ok: false as const, message: GENERATION_FAILED }));
        if (!mounted.current) return;
        setGenerating(false);
        if (!text.ok) {
          setGenerationFailed({ commit: true, pr: true });
          return;
        }
        // Text the user typed while it was being written stays.
        setFields((current) => ({
          commitMessage: edited.current.commitMessage ? current.commitMessage : text.commitMessage,
          prTitle: edited.current.prTitle ? current.prTitle : text.prTitle,
          prBody: edited.current.prBody ? current.prBody : text.prBody,
        }));
        // A subject that kept repeating an earlier commit comes back empty.
        setGenerationFailed({ commit: !text.commitMessage, pr: !text.prTitle });
      })();
    }
    return () => {
      mounted.current = false;
    };
  }, []);

  // Focus moves into the dialog, and back to where it was when the dialog closes.
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const setField = (key: keyof Fields) => (value: string) => {
    edited.current[key] = true;
    setFields((current) => ({ ...current, [key]: value }));
  };

  const close = () => {
    if (!running) onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // Escape closes the dialog wherever focus is (a finished step's button may have taken it away), and is
  // consumed here so it doesn't also stop the chat's turn. Tab from outside comes back in.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === "Tab" && !panelRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        panelRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  async function run(stepsToRun: GitStep[]) {
    // A second click before React re-renders mustn't start a second run.
    if (!repo || runningRef.current) return;
    runningRef.current = true;
    const { commitMessage, prTitle, prBody } = fieldsRef.current;
    setRunning(true);
    setFailure(null);
    setSteps([]);
    const outcome: GitRunResult = {};
    let failed = false;
    const update = (step: GitStep, status: StepState["status"], detail?: string) =>
      setSteps((current) => [...current.filter((item) => item.step !== step), { step, status, detail }]);
    for (const step of stepsToRun) {
      update(step, "running");
      try {
        if (step === "commit") {
          const committed = await bridge.git.commit({ cwd, message: commitMessage });
          if (!committed.ok) {
            failed = true;
            // Only a hook's complaint is something the agent can fix; a signing key isn't.
            setFailure(
              committed.kind === "hook"
                ? { message: committed.code ? gitMessage(committed.code) : committed.message, output: committed.output, hook: true }
                : { message: committed.code ? gitMessage(committed.code) : committed.message, output: committed.output },
            );
          } else {
            outcome.shortSha = committed.shortSha;
            update(step, "done", `Committed ${committed.shortSha}`);
          }
        } else if (step === "push") {
          const pushed = await bridge.git.push({ cwd });
          if (!pushed.ok) {
            failed = true;
            setFailure({ message: pushed.code ? gitMessage(pushed.code) : pushed.message, hint: pushed.hint });
          } else {
            outcome.pushedBranch = pushed.branch;
            update(step, "done", `Pushed to ${pushed.remote}/${pushed.branch}`);
          }
        } else {
          const opened = await bridge.git.openPr({ cwd, base, title: prTitle, body: prBody });
          if (!opened.ok) {
            failed = true;
            setFailure({ message: opened.code ? gitMessage(opened.code) : opened.message });
          } else {
            outcome.pr = { url: opened.url, number: opened.number, created: true };
            update(step, "done", opened.number ? `Opened PR #${opened.number}` : "Opened the PR");
          }
        }
      } catch (error) {
        failed = true;
        setFailure({ message: ipcErrorMessage(error) });
      }
      if (failed) {
        update(step, "failed");
        break;
      }
    }
    // A push to a branch with an open PR updates it.
    if (repo.pr && outcome.pushedBranch && !outcome.pr) outcome.pr = { url: repo.pr.url, number: repo.pr.number, created: false };
    setResult(outcome);
    const note = gitRunNote(outcome);
    if (note) onRan(note);
    // The folder has moved on (after a failure a commit may be in), so the list and the buttons follow it.
    if (!failed) setFinished(true);
    await load();
    runningRef.current = false;
    setRunning(false);
    // The button that ran the steps may be gone; keep focus in the dialog.
    window.requestAnimationFrame(() => {
      if (!panelRef.current?.contains(document.activeElement)) panelRef.current?.focus();
    });
  }

  // Tab and Shift+Tab stay inside the dialog.
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((element) => element.offsetParent !== null);
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || active === panelRef.current)) {
      event.preventDefault();
      first.focus();
    }
  }

  const primary = mode?.primary ?? null;
  const secondary = mode?.secondary ?? null;
  // A button needs the fields its steps use; generation may still be filling them.
  const missingField = (button: DialogButton | null) =>
    !button
      ? null
      : button.steps.includes("commit") && !fields.commitMessage.trim()
        ? "Write a commit message."
        : button.steps.includes("pr") && !fields.prTitle.trim()
          ? "Add a PR title."
          : null;
  const disabled = (button: DialogButton | null) => running || !button || Boolean(button.disabledReason) || Boolean(missingField(button));
  // The reason beside the buttons: git's or the agent's state first, then a missing field.
  const footerReason = primary?.disabledReason ?? secondary?.disabledReason ?? (generating ? null : missingField(primary));
  const showForm = !finished;
  const prTarget = repo ? prTargetLine(repo.remotes, repo.prRepo) : null;

  return createPortal(
    <div
      data-git-dialog-overlay
      className="fixed inset-0 z-[80] flex items-center justify-center bg-[oklch(0.2_0.01_260/0.32)] p-4 [-webkit-app-region:no-drag]"
      style={{ animation: "fade-in 140ms ease-out both" }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-dialog-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        data-git-dialog
        className="flex max-h-[min(88vh,760px)] w-[560px] max-w-full flex-col overflow-hidden rounded-[14px] bg-surface text-ink shadow-overlay outline-none"
        style={{ animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        <header className="flex items-center gap-3 px-4 pb-2 pt-3.5">
          <h2 id="git-dialog-title" className="min-w-0 flex-1 text-[15px] font-semibold">
            Commit and open PR
          </h2>
          {projectName && <p className="mt-1 text-[12px] text-ink-2">{projectName}</p>}
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            disabled={running}
            className="flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
          >
            <Icon icon={Cancel01Icon} size={16} />
          </button>
        </header>

        <ScrollArea className="grid flex-1 gap-4 px-4 pb-4 pt-1">
          {!changes && !readError && (
            <p className="flex items-center gap-2 py-6 text-[13px] text-ink-3">
              <Spinner /> Reading changes…
            </p>
          )}
          {readError && (
            <p role="alert" className="text-[13px] text-red">
              {readError}
            </p>
          )}
          {changes && !changes.isRepo && <p className="py-2 text-[13px] text-ink-2">{changes.message ?? "This chat's folder isn't a git repository."}</p>}

          {repo && mode && (
            <>
              <Section label="Changes">
                <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-2">
                  <span className="text-ink-3">
                    <Icon icon={GitBranchIcon} size={14} />
                  </span>
                  <span className="truncate font-medium text-ink">{repo.branch ?? "Detached HEAD"}</span>
                  <span className="text-ink-3">
                    <Icon icon={ArrowRight01Icon} size={12} />
                  </span>
                  <span className="truncate">{repo.base}</span>
                </div>
                <FileList changes={repo} />
              </Section>

              {showForm && mode.showCommit && (
                <Section label="Commit message">
                  <GeneratedField
                    label="Commit message"
                    value={fields.commitMessage}
                    onChange={setField("commitMessage")}
                    generating={generating}
                    readOnly={running}
                    multiline
                    rows={3}
                    placeholder="Describe the change"
                  />
                  {generationFailed.commit && !fields.commitMessage && <p className="text-[12px] text-ink-3">{GENERATION_FAILED}</p>}
                </Section>
              )}

              {showForm && (mode.prOpen || mode.showPrFields || mode.prBlocked) && (
                <Section label="Pull request">
                  {mode.prOpen && repo.pr ? (
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-control border border-line bg-inset px-3 py-2 text-[12.5px] text-ink-2">
                      <span>PR #{repo.pr.number} is open. Pushing updates it.</span>
                      <a
                        href={repo.pr.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink"
                      >
                        Open PR #{repo.pr.number}
                        <Icon icon={LinkSquare02Icon} size={12} />
                      </a>
                    </p>
                  ) : mode.showPrFields ? (
                    <div className="grid gap-2">
                      <GeneratedField
                        label="PR title"
                        value={fields.prTitle}
                        onChange={setField("prTitle")}
                        generating={generating}
                        readOnly={running}
                        placeholder="Title"
                      />
                      <GeneratedField
                        label="PR description"
                        value={fields.prBody}
                        onChange={setField("prBody")}
                        generating={generating}
                        readOnly={running}
                        multiline
                        rows={5}
                        placeholder="What changed and why"
                      />
                      {generationFailed.pr && !fields.prTitle && !(mode.showCommit && generationFailed.commit) && (
                        <p className="text-[12px] text-ink-3">{GENERATION_FAILED}</p>
                      )}
                      {prTarget && (
                        <p data-pr-target className="text-[12px] text-ink-2">
                          {prTarget}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="rounded-control border border-line bg-inset px-3 py-2 text-[12.5px] text-ink-2">{mode.prBlocked}</p>
                  )}
                </Section>
              )}

              {steps.length > 0 && (
                <Section label={finished ? "Result" : "Progress"}>
                  <ol className="grid gap-0.5" aria-live="polite">
                    {steps.map((state) => (
                      <StepLine key={state.step} state={state} result={result} />
                    ))}
                    {result.pr && !result.pr.created && (
                      <StepLine
                        state={{ step: "pr", status: "done", detail: result.pr.number ? `Updated PR #${result.pr.number}` : "Updated the PR" }}
                        result={result}
                      />
                    )}
                  </ol>
                </Section>
              )}

              {failure && (
                <div ref={failureRef} role="alert" data-git-failure className="grid gap-2 rounded-control border border-red/25 bg-red-tint px-3 py-2.5">
                  {/* Git's and gh's own output keeps its lines; a one-line reason reads as text. */}
                  {failure.output || failure.message.includes("\n") ? (
                    <>
                      {failure.output && <p className="text-[12.5px] font-medium text-ink">{failure.message}</p>}
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-chip bg-surface px-2.5 py-2 font-mono text-[11.5px] leading-5 text-ink-2">
                        {failure.output ?? failure.message}
                      </pre>
                    </>
                  ) : (
                    <p className="whitespace-pre-wrap break-words text-[12.5px] text-ink">{failure.message}</p>
                  )}
                  {failure.hint && <p className="text-[12.5px] text-ink">{failure.hint}</p>}
                  {failure.hook && (
                    <div>
                      <button
                        type="button"
                        className={BUTTON_SECONDARY}
                        onClick={() => {
                          onSendToAgent(hookFailureMessage(failure.output ?? failure.message));
                          onClose();
                        }}
                      >
                        Send to agent
                      </button>
                    </div>
                  )}
                </div>
              )}

              {!finished && mode.idle && !failure && <p className="text-[12.5px] text-ink-3">{mode.idle}</p>}
            </>
          )}
        </ScrollArea>

        <footer className="flex items-center gap-2 border-t border-line bg-inset px-4 py-3">
          <p data-footer-reason className="min-w-0 flex-1 text-[12px] text-ink-3">
            {!finished && !running ? footerReason : null}
          </p>
          {finished || !primary ? (
            <button type="button" className={BUTTON_PRIMARY} onClick={onClose} disabled={running}>
              {finished ? "Done" : "Close"}
            </button>
          ) : (
            <>
              {secondary && (
                <button type="button" className={BUTTON_SECONDARY} disabled={disabled(secondary)} onClick={() => void run(secondary.steps)}>
                  {secondary.label}
                </button>
              )}
              <button type="button" className={BUTTON_PRIMARY} disabled={disabled(primary)} onClick={() => void run(primary.steps)}>
                {running && <Spinner />}
                {primary.label}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
