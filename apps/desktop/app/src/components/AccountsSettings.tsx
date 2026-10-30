import { useCallback, useEffect, useState } from "react";
import type { AccountsSnapshot, CliStatus, ModelProvider } from "@milagre/shared/model";
import type { CliProgress } from "../electron";
import { accountType, providerName } from "@milagre/shared/providers";
import { ProviderLogo } from "./ProviderLogo";
import { Briefcase01Icon, UserIcon, UserMultipleIcon, CheckmarkCircle02Icon, CircleIcon, Delete02Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { Button } from "./primitives/Button";
import { FIELD, FIELD_LABEL } from "./primitives/Field";
import { Icon } from "./primitives/Icon";
import { InlineError } from "./primitives/InlineError";
import { ProgressBar } from "./primitives/ProgressBar";
import Tooltip from "./primitives/Tooltip";

const MB = 1024 * 1024;

/** The Antigravity install row in its account group: Milagre downloads it itself, so Settings is where it is installed and updated. */
function AntigravityRow({ onInstalled }: { onInstalled: () => void }) {
  const [status, setStatus] = useState<CliStatus | null>(null);
  const [progress, setProgress] = useState<CliProgress | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const refresh = useCallback(() => {
    window.milagre
      .getCliStatus()
      .then((all) => setStatus(all.antigravity ?? null))
      .catch(() => setStatus(null));
  }, []);
  useEffect(() => {
    refresh();
    return window.milagre.onCliProgress?.((next) => {
      if (next.provider === "antigravity") setProgress(next);
    });
  }, [refresh]);
  const install = async () => {
    setWorking(true);
    setError("");
    setProgress(null);
    try {
      const result = await window.milagre.updateCli("antigravity");
      if (!result.ok) setError(result.error ?? "Antigravity could not be installed. Try again.");
      else onInstalled();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Antigravity could not be installed. Try again.");
    } finally {
      setWorking(false);
      setProgress(null);
      refresh();
    }
  };
  const missing = status?.state === "missing" || status?.state === "broken";
  const outdated = status?.state === "outdated";
  const label = working ? "Installing…" : status?.state === "broken" ? "Reinstall" : outdated ? "Update" : "Install";
  const detail = !working
    ? missing
      ? "Not installed. Milagre downloads Antigravity for you."
      : outdated
        ? "A newer Antigravity is available."
        : status
          ? "Installed."
          : "Checking…"
    : progress?.phase === "download"
      ? `Downloading ${Math.round(progress.received / MB)} of ${Math.max(1, Math.round(progress.total / MB))} MB`
      : progress?.phase === "extract"
        ? "Unpacking…"
        : progress?.phase === "validate"
          ? "Checking…"
          : "Starting…";
  const percent = progress?.phase === "download" && progress.total ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : null;
  return (
    <div data-antigravity-row className="mx-3 mt-3 grid gap-2 rounded-control border border-line p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 space-y-1">
          <span className="block text-13 font-medium">Antigravity</span>
          <span role="status" className="block text-12 text-ink-3">
            {detail}
          </span>
        </span>
        {(missing || outdated || working) && (
          <Button variant="secondary" size={28} disabled={working} onClick={() => void install()}>
            {label}
          </Button>
        )}
      </div>
      {working && (
        // Before the size is known it shows a sliver, so it reads as started.
        <ProgressBar label="Antigravity download" value={(percent ?? 5) / 100} />
      )}
      <InlineError size={12}>{error}</InlineError>
    </div>
  );
}

export function AccountsSettings() {
  const [snapshot, setSnapshot] = useState<AccountsSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<ModelProvider | null>(null);
  const [label, setLabel] = useState("");
  const load = useCallback(async (refresh = false) => {
    try {
      setSnapshot(await window.milagre.listAccounts(refresh));
      setError("");
    } catch {
      setError("Could not load accounts. Check the computer connection, then refresh.");
    }
  }, []);
  useEffect(() => {
    void load();
    return window.milagre.onAccountsChanged?.(() => void load());
  }, [load]);
  const signingIn = snapshot?.providers.some((p) => p.accounts.some((a) => a.state === "signing-in"));
  useEffect(() => {
    if (!signingIn) return;
    const timer = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(timer);
  }, [load, signingIn]);
  const act = async (action: "add" | "select" | "login" | "cancel" | "remove", provider: ModelProvider, value: string) => {
    setBusy(true);
    setError("");
    try {
      setSnapshot(await window.milagre.accountAction(action, provider, value));
      if (action === "add") {
        setAdding(null);
        setLabel("");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update this account. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-6 grid gap-5" data-accounts-settings>
      <div className="flex items-start justify-between gap-6">
        <p className="max-w-[430px] text-13 leading-5 text-ink-3">
          Choose the computer default for each provider. Projects and Links can choose a different account in Project Accounts.
        </p>
        <Button
          variant="secondary"
          size={28}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void load(true).finally(() => setBusy(false));
          }}
        >
          Refresh
        </Button>
      </div>
      <InlineError>{error}</InlineError>
      {!snapshot && !error && (
        <p role="status" className="text-13 text-ink-3">
          Checking accounts…
        </p>
      )}
      {snapshot?.providers.map((group) => (
        <section key={group.provider} className={`overflow-hidden rounded-card bg-surface shadow-card ${group.installed === false ? "pb-3" : ""}`}>
          <div className="flex items-center justify-between border-b border-line px-4 py-4">
            <h2 className="flex items-center gap-2 text-15 font-semibold">
              <ProviderLogo provider={group.provider} size={20} />
              {providerName(group.provider)}
            </h2>
            {group.installed !== false && (
              <Button
                variant="secondary"
                size={28}
                disabled={busy || signingIn}
                onClick={() => {
                  setAdding(group.provider);
                  setLabel("");
                }}
              >
                Add account
              </Button>
            )}
          </div>
          {group.provider === "antigravity" && <AntigravityRow onInstalled={() => void load(true)} />}
          {group.installed !== false && (
            <div className="grid gap-2 p-3" role="group" aria-label={`${providerName(group.provider)} accounts`}>
              {group.accounts.map((account) => {
                const selected = group.selectedId === account.id;
                const type = accountType(account.plan);
                const typeIcon = type === "Business" ? Briefcase01Icon : type === "Team" ? UserMultipleIcon : UserIcon;
                return (
                  <div
                    key={account.id}
                    className={`flex items-center gap-2 rounded-control border pr-3 transition-colors duration-fast hover:bg-hover ${selected ? "border-line-strong" : "border-line"}`}
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={account.email || account.label}
                      disabled={busy || account.state !== "ready"}
                      onClick={() => {
                        if (!selected) void act("select", group.provider, account.id);
                      }}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-control px-3 py-3 text-left disabled:cursor-default"
                    >
                      <Icon icon={selected ? CheckmarkCircle02Icon : CircleIcon} size={18} className={`shrink-0 ${selected ? "text-ink" : "text-ink-3"}`} />
                      <span className="min-w-0 space-y-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-13 font-medium">{account.email || account.label}</span>
                          {type && (
                            <Tooltip label={`${type} account`} className="shrink-0">
                              <span role="img" aria-label={`${type} account`} className="flex text-ink-3">
                                <Icon icon={typeIcon} size={14} />
                              </span>
                            </Tooltip>
                          )}
                          {selected && <span className="shrink-0 text-11 text-ink-2">Default</span>}
                        </span>
                        <span className="block text-12 text-ink-3">
                          {[
                            account.email && account.label !== account.email ? account.label : null,
                            account.state === "signed-out" ? "Not signed in" : account.state === "unknown" ? "Not checked" : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                        {account.message && (
                          <span role={account.state === "error" ? "alert" : "status"} className="block max-w-[390px] text-12 leading-5 text-ink-3">
                            {account.message}
                          </span>
                        )}
                      </span>
                    </button>
                    {(account.id !== "default" || group.provider === "antigravity") && (
                      <div className="flex shrink-0 gap-2">
                        {account.state === "signing-in" ? (
                          <Button variant="secondary" size={28} disabled={busy} onClick={() => void act("cancel", group.provider, account.id)}>
                            Cancel
                          </Button>
                        ) : (
                          <Tooltip label="Sign in again in this computer's browser" align="end">
                            <Button variant="ghost" size={28} disabled={busy || signingIn} onClick={() => void act("login", group.provider, account.id)}>
                              <Icon icon={RefreshIcon} size={14} />
                              Re-authenticate
                            </Button>
                          </Tooltip>
                        )}
                        {account.id !== "default" && (
                          <Tooltip
                            label="Remove from Milagre. The local profile remains. Removing the active account selects the connected CLI account."
                            align="end"
                            wrap
                          >
                            <Button variant="danger-ghost" size={28} disabled={busy} onClick={() => void act("remove", group.provider, account.id)}>
                              <Icon icon={Delete02Icon} size={14} />
                              Remove
                            </Button>
                          </Tooltip>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {group.installed !== false && adding === group.provider && (
            <form
              className="grid gap-3 border-t border-line px-4 py-4"
              onSubmit={(event) => {
                event.preventDefault();
                void act("add", group.provider, label);
              }}
            >
              <label className={`grid gap-1 ${FIELD_LABEL}`}>
                Account name
                <input
                  autoFocus
                  required
                  maxLength={80}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="Personal or work"
                  className={FIELD}
                />
              </label>
              <p className="text-12 text-ink-3">Sign-in opens in your computer's browser. Choose the account you want to add.</p>
              <div className="flex gap-2">
                <Button type="submit" size={28} disabled={busy || !label.trim()}>
                  Continue to sign in
                </Button>
                <Button variant="secondary" size={28} disabled={busy} onClick={() => setAdding(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </section>
      ))}
      <p className="text-12 leading-5 text-ink-3">
        Add and sign in on this computer. Paired phones can switch accounts. Remove keeps the local profile; removing the active account selects the connected
        CLI account.
      </p>
    </div>
  );
}
