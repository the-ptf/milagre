import { useCallback, useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import {
  groupMcpRows,
  mcpSourceRank,
  type McpAccount,
  type McpAccountCheck,
  type McpChip,
  type McpRow,
  type McpServerDefinition,
  type McpTarget,
} from "@milagre/shared/mcp";
import { providerName } from "@milagre/shared/providers";
import type { MilagreBridge } from "../electron";
import { McpOtherHeader, McpOutsideRow, McpServerRow, McpSignInRow } from "./McpServerRow";
import { McpServerSheet } from "./McpServerSheet";

const keyOf = (account: Pick<McpAccount, "provider" | "accountId">) => `${account.provider}:${account.accountId}`;
const card = "divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface";
const heading = "px-1 text-[12px] font-medium text-ink-2";
type Entry = { account: McpAccount; check: McpAccountCheck | null };
type Sheet = { initial?: McpServerDefinition; target?: McpTarget; previous?: { name: string; target: McpTarget } };
// Where an editable row lives: Everywhere if any chip says so, else the first user-scope provider.
const targetOf = (row: McpRow): McpTarget =>
  row.everywhere ? "everywhere" : ((row.chips.find((chip) => chip.scope === "user")?.provider as McpTarget | undefined) ?? "everywhere");
// Where each outside group is changed, shown at the right of its heading.
const whereOf = (source: string) => (source === "Project" ? ".mcp.json" : source.startsWith("Plugin") ? "Claude Code plugin" : null);

/** Settings › MCP for one computer: this one by default, or a paired Mac's bridge on its computer page (`remote`). */
export function McpSettings({ bridge = window.milagre, remote = false, title }: { bridge?: MilagreBridge; remote?: boolean; title?: string }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [otherOpen, setOtherOpen] = useState(false);
  const [signingIn, setSigningIn] = useState<Set<string>>(new Set());
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const run = useRef(0);

  const checkOne = useCallback(
    async (account: McpAccount, id: number) => {
      const check = await bridge.mcp
        .check(account.provider, account.accountId)
        .catch((cause): McpAccountCheck => ({ ...account, problem: cause instanceof Error ? cause.message : String(cause), servers: [] }));
      if (id !== run.current) return;
      setEntries((current) => current?.map((entry) => (keyOf(entry.account) === keyOf(account) ? { ...entry, check } : entry)) ?? null);
    },
    [bridge],
  );
  const refresh = useCallback(async (): Promise<McpAccount[]> => {
    const id = ++run.current;
    setError("");
    let accounts: McpAccount[];
    try {
      accounts = await bridge.mcp.accounts();
    } catch (cause) {
      if (id === run.current) setError(cause instanceof Error ? cause.message : "Could not reach the computer. Check the connection, then refresh.");
      return [];
    }
    if (id !== run.current) return accounts;
    setEntries(accounts.map((account) => ({ account, check: null })));
    // Every account at once; each fills in as it answers, so one slow account never holds the others.
    await Promise.all(accounts.map((account) => checkOne(account, id)));
    if (id === run.current) {
      const at = Date.now();
      setCheckedAt(at);
      setNow(at);
    }
    return accounts;
  }, [bridge, checkOne]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(
    () =>
      bridge.mcp.onChanged?.((event) => {
        if (event.signIn) {
          // One account finished; the row stays "signing in" while the next account's tab is open.
          if (event.last || event.signIn !== "done") setSigningIn((current) => new Set([...current].filter((name) => name !== event.name)));
          if (event.signIn === "failed" && event.error) setError(event.error);
          const account = entries?.find((entry) => keyOf(entry.account) === `${event.provider}:${event.accountId}`)?.account;
          if (account) void checkOne(account, run.current);
          return;
        }
        void refresh();
      }),
    [bridge, checkOne, entries, refresh],
  );
  // "Checked 12 s ago" keeps counting while the page is open.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const checks = (entries ?? []).flatMap((entry) => (entry.check ? [entry.check] : []));
  const { attention, user, other } = groupMcpRows(checks);
  const problems = checks.filter((check) => check.problem);
  const checking = entries === null || entries.some((entry) => !entry.check);
  const ownAttention = attention.filter((row) => row.editable);
  const outsideAttention = attention.filter((row) => !row.editable);
  // Outside rows that need sign-in list first in their own group, so nothing hides behind the expander's count.
  const outside = [...new Set([...outsideAttention.map((row) => row.source ?? "Built in"), ...other.map((group) => group.source)])]
    .sort((a, b) => mcpSourceRank(a) - mcpSourceRank(b) || a.localeCompare(b))
    .map((source) => ({
      source,
      attention: outsideAttention.filter((row) => (row.source ?? "Built in") === source),
      rows: other.find((group) => group.source === source)?.rows ?? [],
    }));
  const outsideCount = outside.reduce((sum, group) => sum + group.attention.length + group.rows.length, 0);

  const signIn = (row: Pick<McpRow, "name" | "chips">) => {
    setSigningIn((current) => new Set(current).add(row.name));
    const targets = row.chips.filter((chip) => chip.state === "needs-sign-in").map(({ provider, accountId }) => ({ provider, accountId }));
    void bridge.mcp.signIn(row.name, targets).catch((cause) => {
      setSigningIn((current) => new Set([...current].filter((name) => name !== row.name)));
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };
  const cancelSignIn = (row: McpRow) => void bridge.mcp.cancelSignIn(row.name);
  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  const onSwitch = (row: McpRow) => (chip: McpChip, on: boolean) =>
    void bridge.mcp.toggle(chip.provider, chip.accountId, row.name, on).then(refresh).catch(fail);
  const edit = async (row: McpRow) => {
    const target = targetOf(row);
    const initial = await bridge.mcp.definition(row.name, target).catch((cause: unknown) => (fail(cause), null));
    if (initial) setSheet({ initial, target, previous: { name: row.name, target } });
  };
  const removeRow = (row: McpRow) => void bridge.mcp.remove(row.name, targetOf(row)).then(refresh).catch(fail);
  const save = async (def: McpServerDefinition, target: McpTarget) => {
    await (def.type === "stdio" || !remote ? bridge.mcp.save : bridge.mcp.saveUrl)(def, target, sheet?.previous);
    const accounts = await refresh();
    if (def.type === "stdio" || remote) return;
    // "Add and sign in": the accounts that now say the new server needs a sign-in get one.
    const reports = await Promise.all(accounts.map((account) => bridge.mcp.check(account.provider, account.accountId).catch(() => null)));
    const chips = reports.flatMap((check): McpChip[] =>
      check && !check.problem
        ? check.servers
            .filter((server) => server.name === def.name && server.state === "needs-sign-in")
            .map((server) => ({
              provider: check.provider,
              accountId: check.accountId,
              label: check.label,
              scope: server.scope,
              state: server.state,
              tools: 0,
              error: null,
            }))
        : [],
    );
    if (chips.length) signIn({ name: def.name, chips });
  };
  const seconds = checkedAt ? Math.max(1, Math.round((now - checkedAt) / 1000)) : null;
  const iconButton =
    "flex size-[34px] items-center justify-center rounded-lg border border-line-strong bg-surface text-ink-2 transition-colors hover:bg-hover disabled:opacity-40";

  const actions = (
    <div className="flex shrink-0 gap-2">
      <button type="button" aria-label="Refresh" className={iconButton} disabled={checking} onClick={() => void refresh()}>
        <HugeiconsIcon icon={RefreshIcon} size={15} strokeWidth={1.75} color="currentColor" />
      </button>
      <button
        type="button"
        data-mcp-add
        className="inline-flex h-[34px] items-center gap-1.5 rounded-lg bg-ink px-3.5 text-[13px] font-medium text-surface transition-opacity hover:opacity-90"
        onClick={() => setSheet({})}
      >
        <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={2} color="currentColor" />
        Add server
      </button>
    </div>
  );
  const intro = (
    <p className="text-[13px] text-ink-2">
      Tool servers your Chats load, for every account on {remote ? "that" : "this"} Mac.{checking ? " Checking…" : seconds ? ` Checked ${seconds} s ago.` : ""}
    </p>
  );

  return (
    <div data-mcp-page className={title ? "" : "mt-6"}>
      {title ? (
        <>
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-ink">{title}</h1>
            {actions}
          </div>
          <div className="mt-5">{intro}</div>
        </>
      ) : (
        <div className="flex items-center justify-between gap-4">
          {intro}
          {actions}
        </div>
      )}
      <div className="mt-6 space-y-6">
        {error && (
          <p role="alert" className="text-[13px] text-red">
            {error}
          </p>
        )}
        {problems.length > 0 && (
          <div className="space-y-1">
            {problems.map((check) => (
              <p key={keyOf(check)} data-mcp-problem={keyOf(check)} className="text-[12px] text-ink-3">
                {providerName(check.provider)} · {check.label}: {check.problem}
              </p>
            ))}
          </div>
        )}
        {ownAttention.length > 0 && (
          <section className="space-y-2">
            <h2 className={heading}>Needs sign-in · {ownAttention.length}</h2>
            <div className={card}>
              {ownAttention.map((row) => (
                <McpSignInRow
                  key={row.name}
                  row={row}
                  remote={remote}
                  signingIn={signingIn.has(row.name)}
                  onSignIn={() => signIn(row)}
                  onCancel={() => cancelSignIn(row)}
                />
              ))}
            </div>
          </section>
        )}
        {user.length > 0 && (
          <section className="space-y-2">
            <h2 className={heading}>Your servers · {user.length}</h2>
            <div className={card}>
              {user.map((row) => (
                <McpServerRow
                  key={row.name}
                  row={row}
                  open={open === row.name}
                  onToggleOpen={() => setOpen(open === row.name ? null : row.name)}
                  onSwitch={onSwitch(row)}
                  onEdit={remote && row.transport === "command" ? undefined : () => void edit(row)}
                  onRemove={() => removeRow(row)}
                />
              ))}
            </div>
          </section>
        )}
        {outsideCount > 0 && (
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <McpOtherHeader open={otherOpen} count={outsideCount} attention={outsideAttention.length} onToggle={() => setOtherOpen(!otherOpen)} />
            {otherOpen && (
              <div className="space-y-3 px-4 pt-3 pb-4">
                <p className="text-[12px] text-ink-2">Set up outside Milagre. Turn them on or off here; change them where they live.</p>
                {outside.map((group) => (
                  <div key={group.source} className="space-y-1.5">
                    <div className="flex items-baseline justify-between gap-3 px-0.5">
                      <h3 className="text-[12px] font-medium text-ink-2">{group.source}</h3>
                      {group.source === "claude.ai connectors" ? (
                        <a
                          href="https://claude.ai/settings/connectors"
                          target="_blank"
                          rel="noreferrer"
                          className="text-[12px] font-medium text-ink hover:underline"
                        >
                          Manage on claude.ai
                        </a>
                      ) : (
                        whereOf(group.source) && <span className="text-[12px] text-ink-3">{whereOf(group.source)}</span>
                      )}
                    </div>
                    <div className={card}>
                      {group.attention.map((row) => (
                        <McpSignInRow
                          key={row.name}
                          compact
                          row={row}
                          remote={remote}
                          signingIn={signingIn.has(row.name)}
                          onSignIn={() => signIn(row)}
                          onCancel={() => cancelSignIn(row)}
                        />
                      ))}
                      {group.rows.map((row) => (
                        <McpOutsideRow
                          key={row.name}
                          row={row}
                          open={open === row.name}
                          onToggleOpen={() => setOpen(open === row.name ? null : row.name)}
                          onSwitch={onSwitch(row)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {entries && !checking && !attention.length && !user.length && !other.length && !problems.length && (
          <p className="text-[13px] text-ink-3">No MCP servers yet. Add one with Add server.</p>
        )}
      </div>
      {sheet && <McpServerSheet initial={sheet.initial} initialTarget={sheet.target} remote={remote} onSave={save} onClose={() => setSheet(null)} />}
    </div>
  );
}
