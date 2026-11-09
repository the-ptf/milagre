import { mcpTargetPlaces, type McpAccount, type McpAccountCheck, type McpChip, type McpServerDefinition, type McpTarget } from "@milagre/shared/mcp";
import type { Live, LiveOptions } from "./live.ts";

type McpEntry = { account: McpAccount; check: McpAccountCheck | null };
/** `pending` holds the value a switch was just flipped to, by `provider:accountId:name`, until its write settles. */
export type McpState = { entries: McpEntry[] | null; error: string; busy: boolean; pending: Record<string, boolean> };
/** Foreground and background changes, so the live socket is closed while the app is away. */
export type McpAppState = { subscribe(listener: (active: boolean) => void): () => void };
/** The part of the phone client the store needs. */
export type McpClient = {
  url: string;
  call<T>(method: string, args?: unknown[]): Promise<T>;
  live(scope: string, options: LiveOptions): Live;
};

export const MCP_IDLE: McpState = { entries: null, error: "", busy: false, pending: {} };
const keyOf = (account: Pick<McpAccount, "provider" | "accountId">) => `${account.provider}:${account.accountId}`;
export const mcpPendingKey = (chip: Pick<McpChip, "provider" | "accountId">, name: string) => `${keyOf(chip)}:${name}`;

/** One computer's MCP list, shared by the list, detail and add screens. Every account is checked at once and fills in as it answers. */
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
      // The demo computer (or an older Mac) refuses the method with a 403; anything else is a lost connection.
      if (id === run)
        set({
          busy: false,
          error:
            (cause as { status?: number }).status === 403
              ? "Not available on this computer. Update Milagre on the Mac, then refresh."
              : "Could not reach the computer. Check the connection, then refresh.",
        });
      return;
    }
    if (id !== run) return;
    // Rows already checked stay on screen while the new check runs, so a refresh or a switch never blanks the list.
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

  /** One account checked again (after its switch), unless a full refresh has started since. */
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
      // A dropped socket may have missed a signal; check again once it is back.
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

  /** Optimistic: a switch that was written shows its new value until the re-check answers. */
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
    /** The session built a new client for this computer (new token or route): every later call goes through it. */
    setClient(next: McpClient) {
      if (next === client) return;
      client = next;
      if (!holders) return;
      open();
      void refresh();
    },
    /** Starts the live subscription for the first screen that needs the list, and checks again. Returns the release. */
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
    /** Resolves once the Mac took the write; only the toggled account is checked again (the Mac's mcp signal refreshes the rest). */
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
    /** Removes the server from every config that holds it, trying each even after one fails; the failures come back as
     * one error, by place. The list re-checks either way. */
    async remove(name: string, targets: McpTarget[]) {
      const failed: { target: McpTarget; message: string }[] = [];
      for (const target of targets) {
        try {
          await client.call("mcp:remove", [name, target]);
        } catch (cause) {
          failed.push({ target, message: cause instanceof Error ? cause.message : "Could not reach the computer." });
        }
      }
      void refresh();
      if (failed.length)
        throw new Error(`Couldn’t remove ${name} from ${mcpTargetPlaces(failed.map((item) => item.target))}. ${failed.map((item) => item.message).join(" ")}`);
    },
    definition: (name: string, target: McpTarget) => client.call<McpServerDefinition | null>("mcp:definition", [name, target]),
    async saveUrl(def: McpServerDefinition, target: McpTarget, previous?: { name: string; target: McpTarget }) {
      await client.call("mcp:saveUrl", [def, target, previous ?? null]);
      void refresh();
    },
  };
}
