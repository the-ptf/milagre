import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { groupMcpRows, type McpChip, type McpServerDefinition, type McpTarget } from "@milagre/shared/mcp";
import { createMcpStore, MCP_IDLE, mcpPendingKey, type McpAppState, type McpClient } from "./mcp-store";
import { useSession } from "./session";

const subscribeNone = () => () => {};
const idle = () => MCP_IDLE;

const appState: McpAppState = {
  subscribe(listener) {
    const watch = AppState.addEventListener("change", (status) => {
      if (status === "active") listener(true);
      else if (status === "background") listener(false);
    });
    return () => watch.remove();
  },
};

const stores = new Map<string, ReturnType<typeof createMcpStore>>();
function storeFor(client: McpClient) {
  let store = stores.get(client.url);
  if (!store) {
    store = createMcpStore(client, appState);
    stores.set(client.url, store);
  }
  return store;
}

export function useMcp() {
  const client = useSession().client;
  const store = client ? storeFor(client) : null;
  const state = useSyncExternalStore(store?.subscribe ?? subscribeNone, store?.get ?? idle);
  useEffect(() => {
    if (!store || !client) return;
    store.setClient(client);
    return store.acquire();
  }, [store, client]);
  const checks = (state.entries ?? []).flatMap((entry) => (entry.check ? [entry.check] : []));
  return {
    entries: state.entries,
    error: state.error,
    checks,
    groups: groupMcpRows(checks),
    problems: checks.filter((check) => check.problem),
    checking: state.busy || (state.entries === null && !state.error),
    pending: (chip: McpChip, name: string): boolean | undefined => state.pending[mcpPendingKey(chip, name)],
    refresh: () => store?.refresh(),
    toggle: (chip: McpChip, name: string, on: boolean) => store?.toggle(chip, name, on),
    remove: (name: string, targets: McpTarget[]) => store?.remove(name, targets),
    definition: (name: string, target: McpTarget) => store?.definition(name, target) ?? Promise.resolve(null),
    saveUrl: (def: McpServerDefinition, target: McpTarget, previous?: { name: string; target: McpTarget }) =>
      store ? store.saveUrl(def, target, previous) : Promise.reject(new Error("Connect to a computer before adding an MCP server.")),
  };
}
