import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { groupMcpRows, type McpChip, type McpServerDefinition, type McpTarget } from "@milagre/shared/mcp";
import { MCP_IDLE, mcpStoreFor } from "./mcp-store";
import { useSession } from "./session";

const subscribeNone = () => () => {};
const idle = () => MCP_IDLE;

/** The connected computer's MCP servers, shared by every MCP screen (one store per computer, one live subscription). */
export function useMcp() {
  const client = useSession().client;
  const store = client ? mcpStoreFor(client) : null;
  const state = useSyncExternalStore(store?.subscribe ?? subscribeNone, store?.get ?? idle);
  useEffect(() => {
    if (!store) return;
    const release = store.acquire();
    const watch = AppState.addEventListener("change", (status) => {
      if (status === "active") store.resume();
    });
    return () => {
      release();
      watch.remove();
    };
  }, [store]);
  const checks = (state.entries ?? []).flatMap((entry) => (entry.check ? [entry.check] : []));
  return {
    entries: state.entries,
    error: state.error,
    checks,
    groups: groupMcpRows(checks),
    problems: checks.filter((check) => check.problem),
    checking: state.busy || (state.entries === null && !state.error),
    refresh: () => store?.refresh(),
    toggle: (chip: McpChip, name: string, on: boolean) => store?.toggle(chip, name, on),
    remove: (name: string, target: McpTarget) => store?.remove(name, target),
    definition: (name: string, target: McpTarget) => store?.definition(name, target) ?? Promise.resolve(null),
    saveUrl: (def: McpServerDefinition, target: McpTarget, previous?: { name: string; target: McpTarget }) => store?.saveUrl(def, target, previous),
  };
}
