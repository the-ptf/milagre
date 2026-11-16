import { useCallback, useEffect, useRef, useState } from "react";
import { PlusSignIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import {
  groupMcpRows,
  mcpEditTarget,
  mcpRemoveTargets,
  mcpSourceRank,
  mcpTargetPlaces,
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
import { Button, IconButton, buttonClass } from "./primitives/Button";
import { EmptyState } from "./primitives/EmptyState";
import { Icon } from "./primitives/Icon";
import { InlineError } from "./primitives/InlineError";
import { SectionLabel } from "./primitives/SectionLabel";
import { SpinnerRing } from "./primitives/SpinnerRing";
import { thisComputer } from "../lib/shortcut-hints";

const keyOf = (account: Pick<McpAccount, "provider" | "accountId">) => `${account.provider}:${account.accountId}`;
const card = "divide-y divide-line overflow-hidden rounded-card border border-line bg-surface";
type Entry = { account: McpAccount; check: McpAccountCheck | null; checking: boolean };
type Sheet = { initial?: McpServerDefinition; target?: McpTarget; previous?: { name: string; target: McpTarget } };
const whereOf = (source: string) => (source === "Project" ? ".mcp.json" : source.startsWith("Plugin") ? "Claude Code plugin" : null);

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
  const entriesRef = useRef<Entry[] | null>(null);
  const pendingSignIn = useRef<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const checkOne = useCallback(
    async (account: McpAccount, id: number): Promise<McpAccountCheck | null> => {
      const check = await bridge.mcp
        .check(account.provider, account.accountId)
        .catch((cause): McpAccountCheck => ({ ...account, problem: cause instanceof Error ? cause.message : String(cause), servers: [] }));
      if (id !== run.current) return null;
      setEntries((current) => current?.map((entry) => (keyOf(entry.account) === keyOf(account) ? { ...entry, check, checking: false } : entry)) ?? null);
      return check;
    },
    [bridge],
  );
  const signIn = useCallback(
    (row: Pick<McpRow, "name" | "chips">) => {
      setSigningIn((current) => new Set(current).add(row.name));
      const targets = row.chips.filter((chip) => chip.state === "needs-sign-in").map(({ provider, accountId }) => ({ provider, accountId }));
      void bridge.mcp.signIn(row.name, targets).catch((cause) => {
        setSigningIn((current) => new Set([...current].filter((name) => name !== row.name)));
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [bridge],
  );
  const refresh = useCallback(async () => {
    const id = ++run.current;
    setError("");
    let accounts: McpAccount[];
    try {
      accounts = await bridge.mcp.accounts();
    } catch (cause) {
      if (id === run.current) setError(cause instanceof Error ? cause.message : "Could not reach the computer. Check the connection, then refresh.");
      return;
    }
    if (id !== run.current) return;
    setEntries((current) =>
      accounts.map((account) => ({ account, check: current?.find((entry) => keyOf(entry.account) === keyOf(account))?.check ?? null, checking: true })),
    );
    const checks = await Promise.all(accounts.map((account) => checkOne(account, id)));
    if (id !== run.current) return;
    const at = Date.now();
    setCheckedAt(at);
    setNow(at);
    const name = pendingSignIn.current;
    if (!name) return;
    pendingSignIn.current = null;
    const chips = checks.flatMap((check): McpChip[] =>
      check && !check.problem
        ? check.servers
            .filter((server) => server.name === name && server.state === "needs-sign-in")
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
    if (chips.length) signIn({ name, chips });
  }, [bridge, checkOne, signIn]);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void refresh();
    }, 50);
  }, [refresh]);
  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(
    () =>
      bridge.mcp?.onChanged?.((event) => {
        if (event.signIn) {
          if (event.last || event.signIn !== "done") setSigningIn((current) => new Set([...current].filter((name) => name !== event.name)));
          if (event.signIn === "failed" && event.error) setError(event.error);
        }
        const account = event.provider && entriesRef.current?.find((entry) => keyOf(entry.account) === `${event.provider}:${event.accountId}`)?.account;
        if (account) {
          setEntries((current) => current?.map((entry) => (keyOf(entry.account) === keyOf(account) ? { ...entry, checking: true } : entry)) ?? null);
          void checkOne(account, run.current);
        } else if (!event.provider) scheduleRefresh();
      }),
    [bridge, checkOne, scheduleRefresh],
  );
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const checks = (entries ?? []).flatMap((entry) => (entry.check ? [entry.check] : []));
  const { attention, user, other } = groupMcpRows(checks);
  const problems = checks.filter((check) => check.problem);
  const checking = entries === null || entries.some((entry) => entry.checking);
  const ownAttention = attention.filter((row) => row.editable);
  const outsideAttention = attention.filter((row) => !row.editable);
  const outside = [...new Set([...outsideAttention.map((row) => row.source ?? "Built in"), ...other.map((group) => group.source)])]
    .sort((a, b) => mcpSourceRank(a) - mcpSourceRank(b) || a.localeCompare(b))
    .map((source) => ({
      source,
      attention: outsideAttention.filter((row) => (row.source ?? "Built in") === source),
      rows: other.find((group) => group.source === source)?.rows ?? [],
    }));
  const outsideCount = outside.reduce((sum, group) => sum + group.attention.length + group.rows.length, 0);

  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  const cancelSignIn = (row: McpRow) => void bridge.mcp.cancelSignIn(row.name).catch(fail);
  const onSwitch = (row: McpRow) => (chip: McpChip, on: boolean) => void bridge.mcp.toggle(chip.provider, chip.accountId, row.name, on).catch(fail);
  const edit = async (row: McpRow) => {
    setError("");
    const target = mcpEditTarget(row);
    const initial = await bridge.mcp.definition(row.name, target).catch((cause: unknown) => {
      fail(cause);
      return undefined;
    });
    if (initial) setSheet({ initial, target, previous: { name: row.name, target } });
    else if (initial === null) setError("Couldn’t read this server’s settings. Edit it in its CLI config.");
  };
  const removeRow = async (row: McpRow) => {
    setError("");
    const failed: { target: McpTarget; message: string }[] = [];
    for (const target of mcpRemoveTargets(row)) {
      try {
        await bridge.mcp.remove(row.name, target);
      } catch (cause) {
        failed.push({ target, message: cause instanceof Error ? cause.message : String(cause) });
      }
    }
    if (failed.length)
      setError(`Couldn’t remove ${row.name} from ${mcpTargetPlaces(failed.map((item) => item.target))}. ${failed.map((item) => item.message).join(" ")}`);
    scheduleRefresh();
  };
  const save = async (def: McpServerDefinition, target: McpTarget) => {
    pendingSignIn.current = def.type !== "stdio" && !remote && !sheet?.previous ? def.name : null;
    try {
      await (def.type === "stdio" || !remote ? bridge.mcp.save : bridge.mcp.saveUrl)(def, target, sheet?.previous);
    } catch (cause) {
      pendingSignIn.current = null;
      throw cause;
    }
    scheduleRefresh();
  };
  const seconds = checkedAt ? Math.max(1, Math.round((now - checkedAt) / 1000)) : null;

  const actions = (
    <div className="flex shrink-0 gap-2">
      <IconButton label="Refresh" icon={RefreshIcon} size={32} variant="secondary" disabled={checking} onClick={() => void refresh()}>
        {checking ? <SpinnerRing size={14} /> : undefined}
      </IconButton>
      <Button data-mcp-add onClick={() => setSheet({})}>
        <Icon icon={PlusSignIcon} size={14} />
        Add server
      </Button>
    </div>
  );
  const intro = (
    <p className="text-13 text-ink-2">
      Tool servers your Chats load, for every account on {remote ? "that computer" : thisComputer}.
      {checking ? " Checking…" : seconds ? ` Checked ${seconds} s ago.` : ""}
    </p>
  );

  return (
    <div data-mcp-page className={title ? "" : "mt-6"}>
      {title ? (
        <>
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-22 font-semibold tracking-[-0.02em] text-ink">{title}</h1>
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
        <InlineError>{error}</InlineError>
        {problems.length > 0 && (
          <div className="space-y-1">
            {problems.map((check) => (
              <p key={keyOf(check)} data-mcp-problem={keyOf(check)} className="text-12 text-ink-3">
                {providerName(check.provider)} · {check.label}: {check.problem}
              </p>
            ))}
          </div>
        )}
        {ownAttention.length > 0 && (
          <section className="space-y-2">
            <SectionLabel className="px-1">Needs sign-in · {ownAttention.length}</SectionLabel>
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
            <SectionLabel className="px-1">Your servers · {user.length}</SectionLabel>
            <div className={card}>
              {user.map((row) => (
                <McpServerRow
                  key={row.name}
                  row={row}
                  open={open === row.name}
                  onToggleOpen={() => setOpen(open === row.name ? null : row.name)}
                  onSwitch={onSwitch(row)}
                  onEdit={remote && row.transport === "command" ? undefined : () => void edit(row)}
                  onRemove={() => void removeRow(row)}
                  removePlaces={mcpTargetPlaces(mcpRemoveTargets(row))}
                />
              ))}
            </div>
          </section>
        )}
        {outsideCount > 0 && (
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            <McpOtherHeader open={otherOpen} count={outsideCount} attention={outsideAttention.length} onToggle={() => setOtherOpen(!otherOpen)} />
            {otherOpen && (
              <div className="space-y-3 px-4 pt-3 pb-4">
                <p className="text-12 text-ink-2">Set up outside Milagre. Turn them on or off here; change them where they live.</p>
                {outside.map((group) => (
                  <div key={group.source} className="space-y-1.5">
                    <div className="flex min-h-6 items-center justify-between gap-3 px-0.5">
                      <SectionLabel as="h3">{group.source}</SectionLabel>
                      {group.source === "claude.ai connectors" ? (
                        <a
                          href="https://claude.ai/settings/connectors"
                          target="_blank"
                          rel="noreferrer"
                          className={`${buttonClass({ variant: "link", size: 24 })} -mr-2`}
                        >
                          Manage on claude.ai
                        </a>
                      ) : (
                        whereOf(group.source) && <span className="text-12 text-ink-3">{whereOf(group.source)}</span>
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
          <EmptyState title="No MCP servers yet" className="px-6 py-6">
            Add one with Add server.
          </EmptyState>
        )}
      </div>
      {sheet && <McpServerSheet initial={sheet.initial} initialTarget={sheet.target} remote={remote} onSave={save} onClose={() => setSheet(null)} />}
    </div>
  );
}
