import { useCallback, useMemo, useState } from "react";
import { useFocusEffect } from "expo-router";
import type { SecretInput, SecretPatch, SecretSharingComputer, SecretSummary, SecretUse } from "@milagre/shared/secrets";
import { useSession } from "./session";

/** `at` is when it was read: the clock relative times count from. */
type Loaded = { locked: boolean; secrets: SecretSummary[]; at: number };

const message = (failure: unknown, fallback: string) => (failure instanceof Error && failure.message ? failure.message : fallback);

/** The connected computer's secrets, without values: read again each time the page comes into view. */
export function useSecrets() {
  const client = useSession().client;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(
    async (live: () => boolean) => {
      if (!client) return;
      try {
        const { unlocked } = await client.call<{ unlocked: boolean }>("secrets:status", []);
        const secrets = unlocked ? await client.call<SecretSummary[]>("secrets:list", []) : [];
        if (!live()) return;
        setLoaded({ locked: !unlocked, secrets, at: Date.now() });
        setError("");
      } catch (failure) {
        if (live()) setError(message(failure, "Could not read secrets from your computer."));
      }
    },
    [client],
  );
  useFocusEffect(
    useCallback(() => {
      let live = true;
      void load(() => live);
      const socket = client?.live("", {
        onSignal: (signal) => {
          if (signal === "secrets") void load(() => live);
        },
        onStatus: () => {},
      });
      return () => {
        live = false;
        socket?.close();
      };
    }, [load, client]),
  );
  const reload = useCallback(() => void load(() => true), [load]);
  const put = useCallback(
    (secret: SecretSummary) =>
      setLoaded((current) =>
        current
          ? { ...current, secrets: [...current.secrets.filter((item) => item.name !== secret.name), secret].sort((a, b) => a.name.localeCompare(b.name)) }
          : current,
      ),
    [],
  );
  const actions = useMemo(
    () => ({
      async set(input: SecretInput) {
        if (!client) throw new Error("Connect to your computer first.");
        const secret = await client.call<SecretSummary>("secrets:set", [input]);
        put(secret);
        return secret;
      },
      async update(name: string, patch: SecretPatch) {
        if (!client) throw new Error("Connect to your computer first.");
        const secret = await client.call<SecretSummary>("secrets:update", [{ name, ...patch }]);
        put(secret);
        return secret;
      },
      async remove(name: string) {
        if (!client) throw new Error("Connect to your computer first.");
        await client.call<{ removed: boolean }>("secrets:delete", [{ name }]);
        setLoaded((current) => (current ? { ...current, secrets: current.secrets.filter((item) => item.name !== name) } : current));
      },
    }),
    [client, put],
  );
  return { client, loaded, error, reload, ...actions };
}

/** The connected computer's name, as its secrets' `changedOn` names it. */
export function useThisComputerName() {
  const session = useSession();
  const host = session.client ? session.hosts.find((saved) => saved.id === session.client?.url) : undefined;
  return session.hostName || host?.name || "";
}

/** The connected computer's paired computers and whether its secrets go to each: read on focus and on every secrets change. */
export function useSecretSharing() {
  const client = useSession().client;
  const [list, setList] = useState<SecretSharingComputer[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!client) return;
      let live = true;
      const read = () =>
        client.call<SecretSharingComputer[]>("secrets:sharing", []).then(
          (value) => {
            if (!live) return undefined;
            setList(value);
            setError("");
            return undefined;
          },
          (failure) => live && setError(message(failure, "Could not read which computers get these secrets.")),
        );
      void read();
      const socket = client.live("", {
        onSignal: (signal) => {
          if (signal === "secrets") void read();
        },
        onStatus: () => {},
      });
      return () => {
        live = false;
        socket.close();
      };
    }, [client]),
  );
  const share = useCallback(
    async (computer: string, on: boolean) => {
      if (!client) return;
      setBusy(computer);
      setError("");
      try {
        setList(await client.call<SecretSharingComputer[]>("secrets:share", [{ computer, on }]));
      } catch (failure) {
        setError(message(failure, "Could not change sharing on your computer."));
      } finally {
        setBusy(null);
      }
    },
    [client],
  );
  return { list, error, busy, share };
}

/** A secret's recent uses, newest first. */
export function useSecretLog(name: string | undefined) {
  const client = useSession().client;
  const [uses, setUses] = useState<SecretUse[] | null>(null);
  const [error, setError] = useState("");
  useFocusEffect(
    useCallback(() => {
      if (!client || !name) return;
      let live = true;
      client.call<SecretUse[]>("secrets:log", [{ name }]).then(
        (value) => {
          if (!live) return undefined;
          setUses(value);
          setError("");
          return undefined;
        },
        (failure) => live && setError(message(failure, "Could not read this secret's uses.")),
      );
      return () => {
        live = false;
      };
    }, [client, name]),
  );
  return { uses, error };
}

/** The Projects a secret can be scoped to: each origin the computer's Projects have, once, plus any the scope already names. */
export function useProjectOrigins(scoped: "all" | string[]) {
  const recent = useSession().recent;
  return useMemo(() => {
    const seen = new Map<string, string>();
    for (const project of recent) {
      if (!project.origin || project.link || seen.has(project.origin)) continue;
      seen.set(project.origin, project.name || project.path.split("/").findLast(Boolean) || project.origin);
    }
    if (Array.isArray(scoped)) for (const origin of scoped) if (!seen.has(origin)) seen.set(origin, origin.split("/").at(-1) || origin);
    return [...seen].map(([origin, name]) => ({ origin, name }));
  }, [recent, scoped]);
}
