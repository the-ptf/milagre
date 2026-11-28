import { useCallback, useState } from "react";
import { router, useFocusEffect } from "expo-router";
import type { ConnectorSummary } from "@milagre/shared/connectors";
import type { McpAccount } from "@milagre/shared/mcp";
import { emailSetupPrompt } from "@milagre/shared/email";
import { useSession } from "./session";

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** The connected computer's Connectors and provider Accounts, reloaded on focus, and a way to call a method and reload. */
export function useConnectors() {
  const { client, hostName } = useSession();
  const [connectors, setConnectors] = useState<ConnectorSummary[] | null>(null);
  const [accounts, setAccounts] = useState<McpAccount[]>([]);
  const [moved, setMoved] = useState<string[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!client) return;
    try {
      const [list, found, movedHere] = await Promise.all([
        client.call<ConnectorSummary[]>("connectors:list", []),
        client.call<McpAccount[]>("mcp:accounts", []).catch(() => [] as McpAccount[]),
        client.call<string[]>("connectors:moved", []).catch(() => [] as string[]),
      ]);
      setConnectors(list);
      setAccounts(found);
      setMoved(movedHere);
      setError("");
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [client]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  const act = useCallback(
    (method: string, args: unknown[]) => {
      if (!client) return Promise.resolve();
      setError("");
      return client.call(method, args).then(load, (cause: unknown) => setError(messageOf(cause)));
    },
    [client, load],
  );
  /** Configure for me: a Chat without a Project on the computer, with the email setup prompt ready to send. */
  const setUpEmail = useCallback(async () => {
    if (!client) return;
    setError("");
    try {
      const home = await client.chatsHome();
      if (!home) throw new Error("This computer can't start a Chat without a Project. Update Milagre on it.");
      const projectPath = home.exists ? home.path : (await client.ensureChatsHome()).path;
      router.dismissAll();
      router.replace({ pathname: "/chat", params: { projectPath, hostId: client.url, prefill: emailSetupPrompt("") } });
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [client]);
  return { client, hostName, connectors, accounts, moved, error, load, act, setUpEmail };
}
