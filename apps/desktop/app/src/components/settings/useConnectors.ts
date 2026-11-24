import { useCallback, useEffect, useState } from "react";
import type { ConnectorInput, ConnectorMovable, ConnectorSummary } from "@milagre/shared/connectors";
import type { McpAccount, McpProvider } from "@milagre/shared/mcp";
import type { MilagreBridge } from "../../electron";

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const REPLACED = /Replaced by a newer sign-in/;

/** The computer's Connectors, the provider Accounts they can reach, and the Everywhere servers that can become one. */
export function useConnectors(bridge: MilagreBridge = window.milagre) {
  const [connectors, setConnectors] = useState<ConnectorSummary[] | null>(null);
  const [accounts, setAccounts] = useState<McpAccount[]>([]);
  const [movable, setMovable] = useState<ConnectorMovable[]>([]);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setError("");
    try {
      const [list, found, moves] = await Promise.all([
        bridge.connectors.list(),
        bridge.mcp.accounts().catch(() => []),
        bridge.connectors.movable().catch(() => []),
      ]);
      setConnectors(list);
      setAccounts(found);
      setMovable(moves);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [bridge]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => bridge.connectors.onChanged((event) => setConnectors(event.connectors)), [bridge]);

  const signIn = useCallback(
    async (id: string) => {
      setError("");
      setSigningIn(id);
      try {
        await bridge.connectors.signIn(id);
      } catch (cause) {
        if (!REPLACED.test(messageOf(cause))) setError(messageOf(cause));
      } finally {
        setSigningIn((current) => (current === id ? null : current));
      }
    },
    [bridge],
  );
  const run = (work: () => Promise<unknown>) => {
    setError("");
    void work().catch((cause: unknown) => setError(messageOf(cause)));
  };
  const signInIfNeeded = (connector: ConnectorSummary) => {
    if (connector.state === "needs-sign-in") void signIn(connector.id);
    return connector;
  };

  return {
    connectors,
    accounts,
    movable,
    signingIn,
    error,
    refresh,
    signIn,
    add: async (input: ConnectorInput) => signInIfNeeded(await bridge.connectors.add(input)),
    cancelSignIn: () => run(() => bridge.connectors.cancelSignIn()),
    check: (id: string) => run(() => bridge.connectors.check(id)),
    signOut: (id: string) => run(() => bridge.connectors.signOut(id)),
    remove: (id: string) => run(() => bridge.connectors.remove(id)),
    setAccess: (id: string, provider: McpProvider, accountId: string, on: boolean) => run(() => bridge.connectors.setAccess(id, provider, accountId, on)),
    move: (name: string) =>
      run(async () => {
        const moved = await bridge.connectors.move(name);
        setMovable((current) => current.filter((item) => item.name !== name));
        signInIfNeeded(moved);
      }),
  };
}

export type ConnectorsState = ReturnType<typeof useConnectors>;
