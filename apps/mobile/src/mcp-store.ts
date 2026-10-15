import type { McpAccount, McpAccountCheck, McpChip, McpServerDefinition, McpTarget } from "@milagre/shared/mcp";
import type { Live, LiveOptions } from "./live.ts";

export type McpEntry = { account: McpAccount; check: McpAccountCheck | null };
export type McpState = { entries: McpEntry[] | null; error: string; busy: boolean };
/** The part of the phone client the store needs. */
export type McpClient = {
  url: string;
  call<T>(method: string, args?: unknown[]): Promise<T>;
  live(scope: string, options: LiveOptions): Live;
};

export const MCP_IDLE: McpState = { entries: null, error: "", busy: false };
const keyOf = (account: Pick<McpAccount, "provider" | "accountId">) => `${account.provider}:${account.accountId}`;

/** One computer's MCP list, shared by the list, detail and add screens. Every account is checked at once and fills in as it answers. */
export function createMcpStore(client: McpClient) {
  let state: McpState = MCP_IDLE;
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

  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Starts the live subscription for the first screen that needs the list, and checks again. Returns the release. */
    acquire() {
      holders++;
      if (holders === 1) {
        void refresh();
        open();
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holders--;
        if (!holders) {
          live?.close();
          live = null;
        }
      };
    },
    /** The app came back to the foreground: the socket may be gone, and signals may have been missed. */
    resume() {
      if (!holders) return;
      open();
      void refresh();
    },
    refresh,
    toggle: (chip: McpChip, name: string, on: boolean) => client.call("mcp:toggle", [chip.provider, chip.accountId, name, on]).then(refresh),
    remove: (name: string, target: McpTarget) => client.call("mcp:remove", [name, target]).then(refresh),
    definition: (name: string, target: McpTarget) => client.call<McpServerDefinition | null>("mcp:definition", [name, target]),
    saveUrl: (def: McpServerDefinition, target: McpTarget, previous?: { name: string; target: McpTarget }) =>
      client.call("mcp:saveUrl", [def, target, previous ?? null]).then(refresh),
  };
}

const stores = new Map<string, ReturnType<typeof createMcpStore>>();
/** One store per connected computer, so every screen shows the same state. */
export function mcpStoreFor(client: McpClient) {
  let store = stores.get(client.url);
  if (!store) {
    store = createMcpStore(client);
    stores.set(client.url, store);
  }
  return store;
}
