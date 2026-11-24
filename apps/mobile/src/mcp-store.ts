import type { McpAccount, McpAccountCheck, McpChip } from "@milagre/shared/mcp";
import type { Live, LiveOptions } from "./live.ts";

type McpEntry = { account: McpAccount; check: McpAccountCheck | null };
export type McpState = { entries: McpEntry[] | null; error: string; busy: boolean; pending: Record<string, boolean> };
export type McpAppState = { subscribe(listener: (active: boolean) => void): () => void };
export type McpClient = {
  url: string;
  call<T>(method: string, args?: unknown[]): Promise<T>;
  live(scope: string, options: LiveOptions): Live;
};

export const MCP_IDLE: McpState = { entries: null, error: "", busy: false, pending: {} };
const keyOf = (account: Pick<McpAccount, "provider" | "accountId">) => `${account.provider}:${account.accountId}`;
export const mcpPendingKey = (chip: Pick<McpChip, "provider" | "accountId">, name: string) => `${keyOf(chip)}:${name}`;

export function createMcpStore(initial: McpClient, appState?: McpAppState) {
  let client = initial;
  let state: McpState = MCP_IDLE;
  let unwatch: (() => void) | null = null;
  let run = 0;
  let holders = 0;
  let live: Live | null = null;
  const listeners = new Set<() => void>();
  const set = (next: Partial<McpState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  async function refresh() {
    const id = ++run;
    set({ busy: true });
    let accounts: McpAccount[];
    try {
      accounts = await client.call<McpAccount[]>("mcp:accounts", []);
    } catch (cause) {
      if (id === run)
        set({
          busy: false,
          error:
            (cause as { status?: number }).status === 403
              ? "Not available on this computer. Update Milagre on it, then refresh."
              : "Could not reach the computer. Check the connection, then refresh.",
        });
      return;
    }
    if (id !== run) return;
    const before = new Map((state.entries ?? []).map((entry) => [keyOf(entry.account), entry.check]));
    set({ error: "", entries: accounts.map((account) => ({ account, check: before.get(keyOf(account)) ?? null })) });
    await Promise.all(
      accounts.map(async (account) => {
        const check = await client
          .call<McpAccountCheck>("mcp:check", [account.provider, account.accountId])
          .catch((): McpAccountCheck => ({ ...account, problem: "Could not check. Check the computer connection, then refresh.", servers: [] }));
        if (id === run) set({ entries: state.entries?.map((entry) => (keyOf(entry.account) === keyOf(account) ? { ...entry, check } : entry)) ?? null });
      }),
    );
    if (id === run) set({ busy: false });
  }

  async function recheck(account: Pick<McpAccount, "provider" | "accountId">) {
    const id = run;
    if (!state.entries?.some((entry) => keyOf(entry.account) === keyOf(account))) return;
    const check = await client.call<McpAccountCheck>("mcp:check", [account.provider, account.accountId]).catch(() => null);
    if (!check || id !== run) return;
    set({ entries: state.entries?.map((entry) => (keyOf(entry.account) === keyOf(account) ? { ...entry, check } : entry)) ?? null });
  }

  function open() {
    live?.close();
    let down = false;
    live = client.live("", {
      onSignal: (signal) => {
        if (signal === "mcp") void refresh();
      },
      onStatus: (up) => {
        if (up && down) void refresh();
        down = !up;
      },
    });
  }
  function close() {
    live?.close();
    live = null;
  }

  function applyToggle(chip: McpChip, name: string, on: boolean) {
    set({
      entries:
        state.entries?.map((entry) =>
          keyOf(entry.account) !== keyOf(chip) || !entry.check
            ? entry
            : {
                ...entry,
                check: {
                  ...entry.check,
                  servers: entry.check.servers.map((server) => (server.name === name ? { ...server, state: on ? "pending" : "disabled" } : server)),
                },
              },
        ) ?? null,
    });
  }
  const unpend = (key: string) => {
    const { [key]: _gone, ...rest } = state.pending;
    set({ pending: rest });
  };

  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setClient(next: McpClient) {
      if (next === client) return;
      client = next;
      if (!holders) return;
      open();
      void refresh();
    },
    acquire() {
      holders++;
      if (holders === 1) {
        void refresh();
        open();
        unwatch =
          appState?.subscribe((active) => {
            if (!active) return close();
            open();
            void refresh();
          }) ?? null;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holders--;
        if (!holders) {
          close();
          unwatch?.();
          unwatch = null;
        }
      };
    },
    refresh,
    async toggle(chip: McpChip, name: string, on: boolean) {
      const key = mcpPendingKey(chip, name);
      if (key in state.pending) return;
      set({ pending: { ...state.pending, [key]: on } });
      try {
        await client.call("mcp:toggle", [chip.provider, chip.accountId, name, on]);
        applyToggle(chip, name, on);
        void recheck(chip);
      } finally {
        unpend(key);
      }
    },
  };
}
