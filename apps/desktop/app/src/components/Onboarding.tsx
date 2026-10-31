import { useCallback, useEffect, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft02Icon,
  ArrowUpRight01Icon,
  Bug01Icon,
  MapsIcon,
  TestTube01Icon,
  ArrowRight02Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Folder01Icon,
  FolderAddIcon,
  FolderGitIcon,
  FolderOpenIcon,
  GitForkIcon,
} from "@hugeicons/core-free-icons";
import { providerName } from "@milagre/shared/providers";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { AccountsSnapshot, AgentCliStatus, AgentFolder, ModelProvider, OpenProject } from "@milagre/shared/model";
import { isWindows, thisComputer } from "../lib/shortcut-hints";
import { ProviderLogo } from "./ProviderLogo";
import { ScrollArea } from "./primitives/ScrollArea";

const PROVIDERS: ModelProvider[] = ["claude", "codex", "antigravity", "kiro"];

const primary =
  "inline-flex h-8 cursor-pointer items-center justify-center gap-2 rounded-lg bg-ink px-3.5 text-[13px] font-semibold text-page transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const secondary =
  "inline-flex h-8 cursor-pointer items-center justify-center rounded-lg border border-line-strong px-3.5 text-[13px] font-medium text-ink transition-colors hover:bg-hover disabled:cursor-default disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const quiet =
  "inline-flex cursor-pointer items-center gap-1.5 rounded-md text-[14px] font-medium text-ink-2 transition-colors hover:text-ink disabled:cursor-default disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** ~/Code/web for /Users/me/Code/web (~\Code\web for C:\Users\me\Code\web), so a path reads the way people say it. */
function homePath(folder: string) {
  return folder.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~").replace(/^[a-z]:\\Users\\[^\\]+(?=\\|$)/i, "~");
}

// Where Start from scratch makes the folder (onboarding-projects.cjs: <home>/Code).
const CODE_FOLDER = isWindows ? "~\\Code" : "~/Code";
const inCode = (name: string) => `${CODE_FOLDER}${isWindows ? "\\" : "/"}${name}`;

/** "today", "yesterday", "3 days ago", "last week", or the date. */
function lastUsedLabel(iso: string, now = new Date()) {
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(new Date(iso).toDateString()).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function Progress({ step }: { step: 1 | 2 }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex gap-1" aria-hidden="true">
        {[1, 2, 3].map((bar) => (
          <span key={bar} className={`h-1 w-7 rounded-full ${bar <= step ? "bg-ink" : "bg-line-strong"}`} />
        ))}
      </div>
      <span className="text-[12px] font-medium text-ink-3">Step {step} of 3</span>
    </div>
  );
}

function Header({ step, title, children }: { step: 1 | 2; title: string; children: ReactNode }) {
  return (
    <header className="grid gap-3">
      <Progress step={step} />
      <h1 id="onboarding-title" className="text-[28px] font-semibold leading-tight text-ink">
        {title}
      </h1>
      <p className="text-[15px] leading-relaxed text-ink-2">{children}</p>
    </header>
  );
}

type AgentRow = {
  provider: ModelProvider;
  state: "checking" | "ready" | "missing" | "outdated" | "signed-out" | "signing-in";
  detail: string;
  accountId?: string;
};

function agentRows(status: AgentCliStatus | null, accounts: AccountsSnapshot | null): AgentRow[] {
  return PROVIDERS.map((provider) => {
    const cli = status?.[provider];
    const group = accounts?.providers.find((item) => item.provider === provider);
    const account = group?.accounts.find((item) => item.id === group.selectedId) ?? group?.accounts[0];
    if (!cli) return { provider, state: "checking", detail: `Checking ${thisComputer}…` };
    if (cli.state === "missing" || cli.state === "broken")
      return { provider, state: "missing", detail: cli.state === "broken" ? "Installed, but it doesn't start" : `Not found on ${thisComputer}` };
    if (cli.state === "outdated") return { provider, state: "outdated", detail: "Installed · needs an update" };
    if (account?.state === "signing-in") return { provider, state: "signing-in", detail: "Finish signing in in your browser", accountId: account.id };
    // An account that couldn't be checked, or whose sign-in failed, is no sign-in: its message says why.
    if (cli.state === "logged-out" || account?.state === "signed-out" || account?.state === "error")
      return {
        provider,
        state: "signed-out",
        detail: account?.state === "error" && account.message ? account.message : "Installed · not signed in",
        accountId: account?.id,
      };
    return { provider, state: "ready", detail: account?.plan ? `Signed in · ${account.plan} plan` : "Signed in", accountId: account?.id };
  });
}

/** Step 1: the agents on this Mac, each ready, waiting for a sign-in, or not installed (design onboarding-agent). */
function AgentStep({ onNext }: { onNext: () => void }) {
  const [status, setStatus] = useState<AgentCliStatus | null>(null);
  const [accounts, setAccounts] = useState<AccountsSnapshot | null>(null);
  const [working, setWorking] = useState<ModelProvider | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const [nextStatus, nextAccounts] = await Promise.all([window.milagre.getCliStatus().catch(() => null), window.milagre.listAccounts().catch(() => null)]);
    if (nextStatus) setStatus(nextStatus);
    if (nextAccounts) setAccounts(nextAccounts);
  }, []);
  useEffect(() => {
    void load();
    return window.milagre.onAccountsChanged?.(() => void load());
  }, [load]);
  const rows = agentRows(status, accounts);
  const signingIn = rows.some((row) => row.state === "signing-in");
  useEffect(() => {
    if (!signingIn) return;
    const timer = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(timer);
  }, [load, signingIn]);
  const act = async (row: AgentRow) => {
    setWorking(row.provider);
    setError("");
    try {
      if (row.state === "missing" || row.state === "outdated") {
        const result = await window.milagre.updateCli(row.provider);
        if (!result.ok) setError(`${providerName(row.provider)} could not be installed: ${result.error ?? "try again."}`);
      } else if (row.accountId) {
        setAccounts(await window.milagre.accountAction(row.state === "signing-in" ? "cancel" : "login", row.provider, row.accountId));
      }
    } catch (reason) {
      setError(ipcErrorMessage(reason));
    } finally {
      setWorking(null);
      void load();
    }
  };
  const ready = rows.find((row) => row.state === "ready");
  return (
    <>
      <Header step={1} title="Choose your agent">
        Milagre runs the coding agents you already use, with their own sign-in. We checked {thisComputer} for them.
      </Header>
      <ul data-onboarding-agents className="overflow-hidden rounded-xl border border-line bg-surface">
        {rows.map((row) => {
          const muted = row.state === "missing";
          const installing = working === row.provider && (row.state === "missing" || row.state === "outdated");
          return (
            <li
              key={row.provider}
              data-agent={row.provider}
              data-state={row.state}
              className="flex items-center gap-3.5 border-line px-4 py-4 not-last:border-b"
            >
              <span className={`flex size-9 shrink-0 items-center justify-center rounded-[9px] border border-line bg-inset ${muted ? "opacity-50" : ""}`}>
                <ProviderLogo provider={row.provider} size={20} />
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-[15px] font-semibold ${muted ? "text-ink-2" : "text-ink"}`}>{providerName(row.provider)}</span>
                <span role="status" title={row.detail} className={`block truncate text-[13px] ${muted ? "text-ink-3" : "text-ink-2"}`}>
                  {installing ? (row.state === "outdated" ? "Updating…" : "Installing… this can take a minute") : row.detail}
                </span>
              </span>
              {row.state === "ready" && (
                <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                  <HugeiconsIcon icon={CheckmarkCircle02Icon} size={16} strokeWidth={1.8} color="currentColor" />
                  Ready
                </span>
              )}
              {(row.state === "missing" || row.state === "outdated" || row.state === "signed-out" || row.state === "signing-in") && (
                <button
                  type="button"
                  className={`${secondary} min-w-[84px]`}
                  disabled={working !== null || (row.state !== "missing" && row.state !== "outdated" && !row.accountId)}
                  onClick={() => void act(row)}
                >
                  {row.state === "missing"
                    ? installing
                      ? "Installing…"
                      : "Install"
                    : row.state === "outdated"
                      ? installing
                        ? "Updating…"
                        : "Update"
                      : row.state === "signing-in"
                        ? "Cancel"
                        : "Sign in"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="-mt-3 text-[13px] text-red-ink">
          {error}
        </p>
      )}
      <p className="text-[13px] text-ink-3">Add more accounts or pick an agent per Project later in Settings › Accounts.</p>
      <footer className="flex items-center justify-between">
        <button type="button" className={quiet} onClick={onNext}>
          Set up later
        </button>
        <button type="button" className={`${primary} h-10 px-4 text-[14px]`} onClick={onNext}>
          {ready ? `Continue with ${providerName(ready.provider)}` : "Continue"}
          <HugeiconsIcon icon={ArrowRight02Icon} size={16} strokeWidth={2} color="currentColor" />
        </button>
      </footer>
    </>
  );
}

type Form = { kind: "clone" | "create"; value: string } | null;

/** Step 2: open, clone or start a Project, or pick a folder an agent worked in (designs onboarding-project and onboarding-git). */
function ProjectStep({ onBack, onOpened, onSkip }: { onBack: () => void; onOpened: (project: OpenProject) => void; onSkip: () => void }) {
  const [folders, setFolders] = useState<AgentFolder[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    window.milagre
      .listAgentFolders()
      .then((found) => live && setFolders(found))
      .catch(() => live && setFolders([]));
    return () => {
      live = false;
    };
  }, []);
  const run = async (open: () => Promise<OpenProject | null>) => {
    setBusy(true);
    setError("");
    try {
      const opened = await open();
      if (opened) onOpened(opened);
    } catch (reason) {
      setError(ipcErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    if (!form?.value.trim()) return;
    void run(() => (form.kind === "clone" ? window.milagre.cloneProject(form.value) : window.milagre.createProject(form.value)));
  };
  const sources = [...new Set((folders ?? []).map((folder) => providerName(folder.provider)))];
  const tiles = [
    {
      id: "open",
      icon: FolderOpenIcon,
      title: "Open folder",
      detail: `Pick one on ${thisComputer}`,
      onClick: () => void run(() => window.milagre.openProject()),
    },
    { id: "clone", icon: GitForkIcon, title: "Clone a repository", detail: "Paste a GitHub URL", onClick: () => setForm({ kind: "clone", value: "" }) },
    {
      id: "create",
      icon: FolderAddIcon,
      title: "Start from scratch",
      detail: `New folder in ${CODE_FOLDER}`,
      onClick: () => setForm({ kind: "create", value: "" }),
    },
  ];
  return (
    <>
      <Header step={2} title="Open a project">
        Any folder works. Folders with Git give each Chat its own Worktree.
      </Header>
      <div className="grid grid-cols-3 gap-3">
        {tiles.map((tile) => (
          <button
            key={tile.id}
            type="button"
            data-onboarding-tile={tile.id}
            disabled={busy}
            onClick={tile.onClick}
            className={`flex h-[108px] cursor-pointer flex-col items-start rounded-xl border bg-surface p-4 text-left transition-colors hover:border-line-strong hover:bg-hover disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${form?.kind === tile.id ? "border-line-strong bg-hover" : "border-line"}`}
          >
            <HugeiconsIcon icon={tile.icon} size={20} strokeWidth={1.7} color="currentColor" className="text-ink" />
            <span className="mt-auto text-[14px] font-semibold text-ink">{tile.title}</span>
            <span className="mt-1 text-[12px] text-ink-2">{tile.detail}</span>
          </button>
        ))}
      </div>
      {form && (
        <form
          data-onboarding-form={form.kind}
          className="-mt-2 flex items-center gap-2 rounded-xl border border-line bg-surface p-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            autoFocus
            aria-label={form.kind === "clone" ? "Repository address" : "Project name"}
            placeholder={form.kind === "clone" ? "https://github.com/owner/repository" : "my-project"}
            value={form.value}
            disabled={busy}
            onChange={(event) => setForm({ ...form, value: event.target.value })}
            onKeyDown={(event) => event.key === "Escape" && setForm(null)}
            className="h-8 min-w-0 flex-1 rounded-lg bg-inset px-3 text-[13px] text-ink outline-none placeholder:text-ink-3 focus-visible:ring-1 focus-visible:ring-line-strong"
          />
          {form.kind === "create" && form.value.trim() && <span className="shrink-0 text-[12px] text-ink-3">{inCode(form.value.trim())}</span>}
          <button type="submit" className={primary} disabled={busy || !form.value.trim()}>
            {busy ? (form.kind === "clone" ? "Cloning…" : "Creating…") : form.kind === "clone" ? "Clone" : "Create"}
          </button>
          <button
            type="button"
            aria-label="Close"
            className="flex size-8 cursor-pointer items-center justify-center rounded-lg text-ink-2 hover:bg-hover"
            onClick={() => setForm(null)}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2} color="currentColor" />
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="-mt-2 text-[13px] text-red-ink">
          {error}
        </p>
      )}
      {(folders === null || folders.length > 0) && (
        <section className="grid min-w-0 grid-cols-1 gap-2.5" aria-labelledby="onboarding-recent">
          <div className="flex items-center justify-between">
            <h2 id="onboarding-recent" className="text-[13px] font-semibold text-ink-2">
              Where your agents worked recently
            </h2>
            {sources.length > 0 && <span className="text-[12px] text-ink-3">From {sources.join(" and ")} history</span>}
          </div>
          <ul data-onboarding-folders className="grid min-w-0 grid-cols-1 gap-0.5 rounded-xl border border-line bg-surface p-1">
            {folders === null &&
              [0, 1, 2].map((index) => (
                <li key={index} className="flex h-14 items-center gap-3 px-2.5">
                  <span className="size-8 rounded-lg bg-inset" />
                  <span className="h-3 w-40 rounded bg-inset" />
                </li>
              ))}
            {folders?.map((folder) => {
              const open = expanded === folder.path;
              return (
                <li key={folder.path} data-folder={folder.name} className={`rounded-lg ${open ? "bg-hover" : ""}`}>
                  <button
                    type="button"
                    disabled={busy}
                    aria-expanded={folder.git ? undefined : open}
                    onClick={() => (folder.git ? void run(() => window.milagre.openProjectAt(folder.path)) : setExpanded(open ? null : folder.path))}
                    className="group flex h-14 w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 text-left transition-colors hover:bg-hover disabled:cursor-default focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-inset text-ink-2">
                      <HugeiconsIcon icon={folder.git ? FolderGitIcon : Folder01Icon} size={16} strokeWidth={1.7} color="currentColor" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium text-ink">{folder.name}</span>
                      <span className="block truncate font-mono text-[12px] text-ink-3 group-hover:text-ink-2">{homePath(folder.path)}</span>
                    </span>
                    {!folder.git && (
                      <span className="shrink-0 rounded-md border border-line bg-inset px-2 py-0.5 text-[11px] font-medium text-ink-2">No Git</span>
                    )}
                    <span className="shrink-0 text-[12px] text-ink-3">
                      {providerName(folder.provider)} · {lastUsedLabel(folder.lastUsed)}
                    </span>
                    {folder.git ? (
                      <span className="hidden h-7 shrink-0 items-center rounded-md bg-ink px-3 text-[12px] font-semibold text-page group-hover:flex group-focus-visible:flex">
                        Open
                      </span>
                    ) : (
                      open && <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2} color="currentColor" className="shrink-0 text-ink-2" />
                    )}
                  </button>
                  {open && (
                    <div data-no-git className="grid gap-3 pr-2.5 pb-2.5 pl-[54px]">
                      <p className="text-[13px] leading-normal text-ink-2">
                        {folder.name} has no Git, so Chats work right in this folder instead of their own Worktree. Add Git later to run Chats side by side and
                        undo their changes.
                      </p>
                      <div className="flex gap-2.5">
                        <button type="button" className={primary} disabled={busy} onClick={() => void run(() => window.milagre.openProjectAt(folder.path))}>
                          Open folder
                        </button>
                        <button type="button" className={secondary} disabled={busy} onClick={() => void run(() => window.milagre.setUpGit(folder.path))}>
                          Set up Git first
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <footer className="flex items-center justify-between">
        <button type="button" className={quiet} onClick={onBack} disabled={busy}>
          <HugeiconsIcon icon={ArrowLeft02Icon} size={16} strokeWidth={2} color="currentColor" />
          Back
        </button>
        <button type="button" data-onboarding-skip className={quiet} onClick={onSkip} disabled={busy}>
          Skip, start a Chat without a project
          <HugeiconsIcon icon={ArrowRight02Icon} size={16} strokeWidth={2} color="currentColor" />
        </button>
      </footer>
    </>
  );
}

/**
 * First launch with no Project to open (designs in the Onboarding · Desktop group): the agent, then a Project. The
 * third step is the app itself, whose first Chat offers starter tasks (see FirstChatStarters).
 */
export function Onboarding({ onOpened, onSkip, splash }: { onOpened: (project: OpenProject) => void; onSkip: () => void; splash?: ReactNode }) {
  const [step, setStep] = useState<1 | 2>(1);
  return (
    <main data-onboarding data-step={step} aria-labelledby="onboarding-title" className="flex h-screen flex-col text-ink">
      <ScrollArea className="flex min-h-0 flex-1 justify-center px-8 py-14">
        <div className={`my-auto grid w-full min-w-0 grid-cols-1 gap-7 ${step === 1 ? "max-w-[520px]" : "max-w-[600px]"}`}>
          {step === 1 ? <AgentStep onNext={() => setStep(2)} /> : <ProjectStep onBack={() => setStep(1)} onOpened={onOpened} onSkip={onSkip} />}
        </div>
      </ScrollArea>
      {splash}
    </main>
  );
}

export type Starter = { id: string; label: string; prompt: string; onPick: () => void };

/** The first Chat's starter tasks for a Project named `name` (design onboarding-first-chat). */
export function firstChatStarters(name: string): Omit<Starter, "onPick">[] {
  return [
    {
      id: "explain",
      label: `Explain how ${name} is put together`,
      prompt: `Explain how ${name} is put together: its main parts, how they connect, and where to start reading.`,
    },
    { id: "bug", label: "Find a bug and fix it", prompt: "Look through this project for a real bug, explain it, and fix it." },
    { id: "tests", label: "Add tests for the most recent change", prompt: "Find the most recent change in this project and add tests that cover it." },
  ];
}

const STARTER_ICONS = { explain: MapsIcon, bug: Bug01Icon, tests: TestTube01Icon } as const;

export function FirstChatStarters({ starters }: { starters: Starter[] }) {
  return (
    <ul data-first-chat-starters className="mb-3 grid gap-2 px-1" style={{ animation: "fade-up 400ms cubic-bezier(0.23,1,0.32,1) both" }}>
      {starters.map((starter) => (
        <li key={starter.id}>
          <button
            type="button"
            onClick={starter.onPick}
            className="group flex h-12 w-full cursor-pointer items-center gap-3 rounded-[10px] border border-line bg-surface px-3.5 text-left text-[14px] text-ink transition-colors hover:border-line-strong hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <HugeiconsIcon
              icon={STARTER_ICONS[starter.id as keyof typeof STARTER_ICONS] ?? MapsIcon}
              size={16}
              strokeWidth={1.7}
              color="currentColor"
              className="text-ink-2"
            />
            <span className="min-w-0 flex-1 truncate">{starter.label}</span>
            <HugeiconsIcon
              icon={ArrowUpRight01Icon}
              size={16}
              strokeWidth={1.7}
              color="currentColor"
              className="text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            />
          </button>
        </li>
      ))}
    </ul>
  );
}
