import { useCallback, useEffect, useState } from "react";
import type { ConnectorInput, ConnectorMovable, ConnectorSummary, ConnectorUpdate, EmailConnectInput } from "@milagre/shared/connectors";
import type { McpAccount, McpProvider } from "@milagre/shared/mcp";
import type { MilagreBridge } from "../../electron";

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const REPLACED = /Replaced by a newer sign-in/;

/** The computer's Connectors, the provider Accounts they can reach, and the Everywhere servers that can become one. */
export function useConnectors(bridge: MilagreBridge = window.milagre) {
  const [connectors, setConnectors] = useState<ConnectorSummary[] | null>(null);
  const [accounts, setAccounts] = useState<McpAccount[]>([]);
  const [movable, setMovable] = useState<ConnectorMovable[]>([]);
  const [moved, setMoved] = useState<string[]>([]);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setError("");
    try {
      const [list, found, moves, movedHere] = await Promise.all([
        Promise.resolve().then(() => bridge.connectors.list()),
        Promise.resolve()
          .then(() => bridge.mcp.accounts())
          .catch(() => []),
        Promise.resolve()
          .then(() => bridge.connectors.movable())
          .catch(() => []),
        Promise.resolve()
          .then(() => bridge.connectors.moved())
          .catch(() => []),
      ]);
      setConnectors(list);
      setAccounts(found);
      setMovable(moves);
      setMoved(movedHere);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [bridge]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => bridge.connectors?.onChanged?.((event) => setConnectors(event.connectors)), [bridge]);

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
    moved,
    signingIn,
    error,
    refresh,
    signIn,
    add: async (input: ConnectorInput) => signInIfNeeded(await bridge.connectors.add(input)),
    cancelSignIn: () => run(() => bridge.connectors.cancelSignIn()),
    dismissMoved: () =>
      run(async () => {
        await bridge.connectors.dismissMoved();
        setMoved([]);
      }),
    check: (id: string) => run(() => bridge.connectors.check(id)),
    /** Milagre's own Linear sign-in, from the Linear preset: turns Linear on and opens its sign-in window. */
    connectLinear: async () => {
      setError("");
      await bridge.saveLinearEnabled(true);
      await bridge.connectLinear({ window: true });
      await refresh();
    },
    /** Checks a mailbox's sign-in and saves it for the Email connector. Rejects so the sheet can show the problem. */
    connectEmail: async (input: EmailConnectInput) => {
      setError("");
      await bridge.connectors.connectEmail(input);
    },
    disconnectEmail: (mailbox: string) => run(() => bridge.connectors.disconnectEmail(mailbox)),
    /** Saves an edit; a new app (Client ID) signs in right after. Rejects so the sheet can show the problem. */
    update: async (id: string, patch: ConnectorUpdate, signInAfter: boolean) => {
      setError("");
      await bridge.connectors.update(id, patch);
      if (signInAfter) void signIn(id);
    },
    signOut: (id: string) => run(() => bridge.connectors.signOut(id)),
    remove: (id: string) => run(() => bridge.connectors.remove(id)),
    setAccess: (id: string, provider: McpProvider, accountId: string, on: boolean, workspace?: string) =>
      run(() => bridge.connectors.setAccess(id, provider, accountId, on, ...(workspace === undefined ? [] : [workspace]))),
    move: (name: string) =>
      run(async () => {
        const moved = await bridge.connectors.move(name);
        setMovable((current) => current.filter((item) => item.name !== name));
        signInIfNeeded(moved);
      }),
  };
}

export type ConnectorsState = ReturnType<typeof useConnectors>;
