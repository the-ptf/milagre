import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ModelProvider, ProjectAccountScope, ProjectAccountsSnapshot } from "@milagre/shared/model";
import { accountType, providerName } from "@milagre/shared/providers";
import { HugeiconsIcon } from "@hugeicons/react";
import { BubbleChatIcon, Briefcase01Icon, UserIcon, UserMultipleIcon } from "@hugeicons/core-free-icons";
import { CHATS_ACCOUNT_DETAIL } from "@milagre/shared/chats-home";
import { ipcErrorMessage } from "@milagre/shared/result";
import { Select, type SelectOption } from "./primitives/Select";
import { ProjectAvatarStack } from "./ProjectAvatarStack";
import { ProviderLogo } from "./ProviderLogo";
import { bridgeForKey } from "../lib/computer-bridge";

/** The Chats home's mark, as the sidebar's Chats group shows it: it has no repository picture of its own. */
function ChatsHomeMark() {
  return (
    <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-[6px] bg-ink text-surface">
      <HugeiconsIcon icon={BubbleChatIcon} size={14} />
    </span>
  );
}

function AccountIcon({ plan }: { plan?: string }) {
  const type = accountType(plan);
  return type ? (
    <span role="img" aria-label={`${type} account`} title={`${type} account`} className="flex shrink-0 text-ink-3">
      <HugeiconsIcon icon={type === "Business" ? Briefcase01Icon : type === "Team" ? UserMultipleIcon : UserIcon} size={15} />
    </span>
  ) : null;
}

const statusLabel = (state: string) =>
  state === "signing-in" ? "Signing in" : state === "error" ? "Account error" : state === "unknown" ? "Not checked" : "Not signed in";

type ProviderAccounts = ProjectAccountsSnapshot["providers"][number];

/** The choices for one provider in a Project or Link: the computer default, then each saved account. Settings and the usage card share them. */
export function projectAccountOptions(group: ProviderAccounts): SelectOption<string>[] {
  const effective = group.accounts.find((account) => account.id === group.effectiveId);
  const missing = group.accountId !== null && (!effective || effective.missing === true);
  const defaultAccount = group.accounts.find((account) => account.id === group.defaultId);
  return [
    {
      value: "",
      label: "Use computer default",
      description: defaultAccount?.email || defaultAccount?.label || "No computer default",
      icon: <AccountIcon plan={defaultAccount?.plan} />,
      display: (
        <>
          <span className="truncate">{defaultAccount?.email || defaultAccount?.label || "Use computer default"}</span>
          <span className="shrink-0 rounded-md bg-hover px-1.5 py-0.5 text-[10.5px] font-medium text-ink-3">Default</span>
        </>
      ),
    },
    ...(missing && !effective ? [{ value: group.accountId!, label: "Unavailable account", disabled: true }] : []),
    ...group.accounts.map((account) => ({
      value: account.id,
      label: account.missing ? "Unavailable account" : account.email || account.label,
      description: account.missing ? "Removed account" : account.state === "ready" ? undefined : statusLabel(account.state),
      disabled: account.missing || account.state !== "ready",
      icon: <AccountIcon plan={account.plan} />,
    })),
  ];
}

// Loads one Project's or Link's accounts and keeps them current while sign-ins finish.
export function useProjectAccounts(scope: string) {
  const [snapshot, setSnapshot] = useState<ProjectAccountsSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const load = useCallback(
    async (refresh = false) => {
      if (!scope) return;
      const version = ++generation.current;
      try {
        const next = await bridgeForKey(scope).getProjectAccounts(scope, refresh);
        if (version === generation.current && currentScope.current === scope) {
          setSnapshot(next);
          setError("");
        }
      } catch (reason) {
        if (version === generation.current && currentScope.current === scope) setError(ipcErrorMessage(reason));
      }
    },
    [scope],
  );
  useEffect(() => {
    setSnapshot(null);
    setError("");
    setBusy(false);
    void load();
    const off = bridgeForKey(scope).onAccountsChanged?.(() => void load());
    return () => {
      generation.current++;
      off?.();
    };
  }, [load, scope]);
  const shown = snapshot?.scopeKey === scope ? snapshot : null;
  const signingIn = !!shown?.providers.some((group) => group.accounts.some((account) => account.state === "signing-in"));
  useEffect(() => {
    if (!signingIn) return;
    const timer = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(timer);
  }, [load, signingIn]);
  const act = async (action: () => Promise<unknown>) => {
    const selectedScope = scope;
    setBusy(true);
    setError("");
    try {
      await action();
      if (currentScope.current === selectedScope) await load();
    } catch (reason) {
      if (currentScope.current === selectedScope) setError(ipcErrorMessage(reason));
    } finally {
      if (currentScope.current === selectedScope) setBusy(false);
    }
  };
  return { shown, error, busy, signingIn, load, act };
}

/* One row per provider. The trigger shows the account the next turn uses;
 * a second line appears only when that account needs attention. */
function ProjectAccountRows({ scope, empty }: { scope: string; empty?: string }) {
  const { shown, error, busy, signingIn, load, act } = useProjectAccounts(scope);
  if (error)
    return (
      <p role="alert" className="px-4 py-3 text-[13px] text-red-ink">
        {error}{" "}
        <button className="underline" onClick={() => void load(true)}>
          Retry
        </button>
      </p>
    );
  if (!shown)
    return (
      <p role="status" className="px-4 py-3 text-[13px] text-ink-3">
        {scope ? "Checking accounts..." : empty}
      </p>
    );
  return shown.providers.map((group) => {
    const effective = group.accounts.find((account) => account.id === group.effectiveId);
    const missing = group.accountId !== null && (!effective || effective.missing === true);
    const needsSignIn = !!effective && !missing && effective.state !== "ready";
    const name = providerName(group.provider);
    return (
      <div key={group.provider} className="grid gap-1.5 px-4 py-3">
        <div className="flex min-h-8 items-center justify-between gap-4">
          <h3 className="flex items-center gap-2.5 text-[13.5px] font-medium text-ink">
            <ProviderLogo provider={group.provider} size={18} />
            {name}
          </h3>
          <Select
            label={`${name} account`}
            value={group.accountId ?? ""}
            width={340}
            disabled={busy}
            onChange={(id) => void act(() => bridgeForKey(scope).assignProjectAccount(scope, group.provider as ModelProvider, id || null))}
            options={projectAccountOptions(group)}
          />
        </div>
        {(missing || needsSignIn) && (
          <div className="flex items-center justify-between gap-3 pl-7">
            <p className="text-[12px] text-red-ink">
              {missing
                ? "The assigned account is unavailable. Choose another saved account."
                : `${effective!.email || effective!.label} · ${statusLabel(effective!.state)}`}
            </p>
            {needsSignIn && effective!.id !== "default" && (
              <button
                className="shrink-0 text-[12px] font-medium text-ink underline underline-offset-2 disabled:opacity-40"
                disabled={busy || signingIn}
                onClick={() => void act(() => window.milagre.accountAction("login", group.provider, effective!.id))}
              >
                Re-authenticate
              </button>
            )}
          </div>
        )}
        {effective?.message && !missing && (
          <p role="status" className="pl-7 text-[12px] text-ink-3">
            {effective.message}
          </p>
        )}
      </div>
    );
  });
}

function Footnote({ onManageAccounts }: { onManageAccounts: () => void }) {
  return (
    <p className="mt-2 px-1 text-[12px] leading-5 text-ink-3">
      Running replies keep their original account. The next turn uses the one chosen here.{" "}
      <button className="font-medium text-ink-2 underline underline-offset-2 hover:text-ink" onClick={onManageAccounts}>
        Manage saved accounts
      </button>
    </p>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-line overflow-hidden rounded-[12px] bg-surface shadow-card">{children}</div>;
}

export function ProjectAccountsSettings({ projectPath, onManageAccounts }: { projectPath?: string; onManageAccounts: () => void }) {
  const [scopeReload, setScopeReload] = useState(0);
  const [scopesLoaded, setScopesLoaded] = useState(false);
  const [scopes, setScopes] = useState<ProjectAccountScope[]>([]);
  const [scope, setScope] = useState(projectPath ?? "");
  const [scopeError, setScopeError] = useState("");
  useEffect(() => {
    let live = true;
    setScopesLoaded(false);
    const loadScopes = async () => {
      try {
        const available = await window.milagre.listAccountScopes();
        if (!live) return;
        setScopes(available);
        setScopesLoaded(true);
        setScopeError("");
        setScope(available.some((item) => item.key === projectPath) ? projectPath! : (available[0]?.key ?? ""));
      } catch (reason) {
        if (live) setScopeError(ipcErrorMessage(reason));
      }
    };
    void loadScopes();
    return () => {
      live = false;
    };
  }, [projectPath, scopeReload]);
  const selected = scopes.find((item) => item.key === scope);
  return (
    <div data-project-accounts-settings className="mt-3">
      <p className="text-[13px] leading-5 text-ink-3">Choose which saved accounts a Project or Link uses on this computer.</p>
      <section className="mt-6">
        <Card>
          <div className="flex min-h-14 items-center justify-between gap-4 px-4 py-3">
            <div className="grid min-w-0 gap-0.5">
              <span className="text-[13.5px] font-medium text-ink">Project or Link</span>
              {selected?.kind === "link" && <span className="text-[12px] text-ink-3">This Link's accounts are independent of its member Projects.</span>}
              {selected?.chatsHome && <span className="text-[12px] text-ink-3">{CHATS_ACCOUNT_DETAIL}.</span>}
            </div>
            <Select
              label="Project or Link"
              value={scope}
              width={300}
              disabled={!scopes.length}
              onChange={setScope}
              options={[...scopes]
                .sort((a, b) => Number(a.kind === "link") - Number(b.kind === "link"))
                .map((item) => ({
                  value: item.key,
                  label: item.name,
                  group: item.kind === "link" ? "Links" : "Projects",
                  icon: item.chatsHome ? <ChatsHomeMark /> : <ProjectAvatarStack projects={item.projects} />,
                }))}
            />
          </div>
          {scopeError ? (
            <p role="alert" className="px-4 py-3 text-[13px] text-red-ink">
              {scopeError}{" "}
              <button className="underline" onClick={() => setScopeReload((value) => value + 1)}>
                Retry
              </button>
            </p>
          ) : !scopesLoaded ? (
            <p role="status" className="px-4 py-3 text-[13px] text-ink-3">
              Checking accounts...
            </p>
          ) : (
            <ProjectAccountRows key={scope} scope={scope} empty="Open a Project to choose its accounts." />
          )}
        </Card>
        <Footnote onManageAccounts={onManageAccounts} />
      </section>
    </div>
  );
}

// The same choice inside a Project's own settings, fixed to that Project.
export function ProjectAccountsGroup({ projectPath, onManageAccounts }: { projectPath: string; onManageAccounts: () => void }) {
  return (
    <section className="mt-6" data-project-accounts-group>
      <h2 className="mb-2 px-1 text-[12px] font-medium text-ink-3">Accounts</h2>
      <Card>
        <ProjectAccountRows key={projectPath} scope={projectPath} />
      </Card>
      <Footnote onManageAccounts={onManageAccounts} />
    </section>
  );
}
