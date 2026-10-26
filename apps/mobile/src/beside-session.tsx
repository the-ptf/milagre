import { reconcileState } from "@milagre/shared/reconcile";
import { READ_RETRY_BUDGET, retryKind, retrySend } from "@milagre/shared/send-retry";
import type { AgentCliStatus, AgentModels } from "@milagre/shared/model";
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { allComputers } from "./all-computers";
import { createClient, type Client, type Snapshot } from "./client";
import { syncProject } from "./live";
import { relayRuntime } from "./relay-native";
import { SessionScope, useMainSession, useRetireCaughtUp, type Session } from "./session";
import { closeBeside, openBeside, type BesideChat } from "./split-chats";
import { useDesigns } from "./use-designs";

/**
 * The Chat beside the routed one reads its own Project when that isn't the open one: its own snapshot, kept fresh by its
 * own live socket and polling, through the open computer's client or, for another computer, a client of its own. All of
 * it starts when the pane shows and stops when it closes, narrows away or the app leaves the foreground. Read-marking,
 * notifications, the remembered Chat and switching Projects stay with the routed Chat.
 */
export function BesideSession({ chat, children }: { chat: BesideChat; children: React.ReactNode }) {
  const main = useMainSession();
  // The open Project is the routed Chat's: a Chat of it beside shares the open session, with nothing more to sync.
  const shared = main.client?.url === chat.hostId && main.snapshot?.project.path === chat.projectPath;
  const session = useProjectSession(main, shared ? null : chat);
  useRetireCaughtUp(session?.snapshot ?? null, session?.client?.url);
  useEffect(() => publish(session), [session]);
  useEffect(
    () => () => {
      publish(null);
      touchPane("routed");
    },
    [],
  );
  // The Mac may name the Project by another path (a symlink); the Chat beside takes the one it answered with.
  const loaded = session?.snapshot?.project.path;
  const gone = !!session?.snapshot && loaded === chat.projectPath && !session.snapshot.project.state.sessions[chat.chatId];
  useEffect(() => {
    if (loaded && loaded !== chat.projectPath) openBeside({ ...chat, projectPath: loaded });
    else if (gone) closeBeside();
  }, [loaded, gone, chat]);
  return <SessionScope session={session}>{children}</SessionScope>;
}

/** A Project's own session, as the open one has (session.tsx), for `target`; null while there is none to read. */
function useProjectSession(main: Session, target: BesideChat | null): Session | null {
  const sameHost = !!target && main.client?.url === target.hostId;
  const host = target && !sameHost ? (main.hosts.find((saved) => saved.id === target.hostId) ?? allComputers.hostFor(target.hostId)) : undefined;
  // Every field that addresses or authenticates the computer: a client made for other ones must not outlive them.
  const hostKey = host ? JSON.stringify([host.id, host.address, host.token, host.relay, host.access]) : null;
  const [made, setMade] = useState<{ key: string; client: Client } | null>(null);
  useEffect(() => {
    if (!host || !hostKey) return;
    const client = createClient(host, undefined, undefined, relayRuntime);
    setMade({ key: hostKey, client });
    return () => {
      client.retire();
      setMade((current) => (current?.client === client ? null : current));
    };
    // The key is the host's identity; a new SavedHost object for the same computer keeps the client.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [hostKey]);
  const client = !target ? null : sameHost ? main.client : made?.key === hostKey ? made.client : null;
  const path = target?.projectPath;

  const [held, setHeld] = useState<{ client: Client; path: string; snapshot: Snapshot } | null>(null);
  const [error, setError] = useState("");
  // Only a copy read for this pane: an older one may lack a Chat made since, which would read as the Chat being gone.
  const snapshot = held && held.client === client && held.path === path ? held.snapshot : null;
  // The sync run in progress; a read that lands after it ends, or after the pane moved on, changes nothing.
  const run = useRef<object | null>(null);
  const opened = useRef(false);
  const busyUntil = useRef(0);
  const running = useRef(false);
  const anyRunning = !!snapshot && Object.keys(snapshot.runs.runs).length > 0;
  useEffect(() => {
    running.current = anyRunning;
  }, [anyRunning]);
  const refresh = useCallback(async () => {
    const current = run.current;
    if (!client || !path || !current) return;
    try {
      // The first read opens the Project on the Mac, which a Project it hasn't read yet needs.
      const state = opened.current ? await client.snapshot(path) : await client.open(path);
      if (current !== run.current) return;
      opened.current = true;
      setHeld((previous) => ({
        client,
        path,
        snapshot: previous?.client === client && previous.path === path ? reconcileState(previous.snapshot, state) : state,
      }));
      setError("");
    } catch (failure) {
      if (current === run.current) throw failure;
    }
  }, [client, path]);
  const refreshRuns = useCallback(async () => {
    const current = run.current;
    if (!client || !path || !current || !opened.current) return;
    const runs = await client.runs(path);
    if (current !== run.current) return;
    // A snapshot that landed meanwhile may already hold later runs.
    setHeld((previous) =>
      previous?.client === client && previous.path === path && (runs.seq ?? 0) >= (previous.snapshot.runs.seq ?? 0)
        ? { ...previous, snapshot: reconcileState(previous.snapshot, { ...previous.snapshot, runs }) }
        : previous,
    );
    setError("");
  }, [client, path]);

  // The agents and models this Project's account offers, as the open session reads them for its Project.
  const [providers, setProviders] = useState<{ key: string; models: AgentModels | null; status: AgentCliStatus | null; error: string }>({
    key: "",
    models: null,
    status: null,
    error: "",
  });
  const [providerRevision, setProviderRevision] = useState(0);
  const providerKey = client && path ? `${client.url}|${path}` : "";
  const providerRequest = useRef(0);
  const refreshProviders = useCallback(async () => {
    if (!client || !path) return;
    const version = ++providerRequest.current;
    const current = () => version === providerRequest.current;
    const key = `${client.url}|${path}`;
    setProviderRevision((value) => value + 1);
    try {
      const read = <T,>(command: string) =>
        retrySend(() => client.call<T>(command, [path]), { retryable: (failure) => current() && retryKind(failure) !== null, budget: READ_RETRY_BUDGET });
      const [models, status] = await Promise.all([read<AgentModels>("agent:models"), read<AgentCliStatus>("agent:cli-status")]);
      if (current()) setProviders({ key, models, status, error: "" });
    } catch {
      if (current()) setProviders((previous) => ({ ...previous, key, error: "Could not check the installed agents. Reconnect to check again." }));
    }
  }, [client, path]);
  useEffect(() => {
    if (!client || !path) return;
    void refreshProviders();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshProviders();
    });
    // An answer for another Project or computer is never shown: it carries its own key.
    return () => subscription.remove();
  }, [client, path, refreshProviders]);
  const ownProviders = providers.key === providerKey ? providers : null;

  // Designs is a computer's setting: the open computer's is the open session's, another one's is read here.
  const ownDesigns = useDesigns(sameHost ? null : client, path);
  const designs = sameHost ? main.designs : ownDesigns;
  const { refresh: refreshDesigns, connectionChanged } = ownDesigns;

  useEffect(() => {
    if (!client || !path) return;
    const current = {};
    run.current = current;
    opened.current = false;
    const stop = syncProject({
      connect: (options) => client.live(path, options),
      snapshot: refresh,
      runs: refreshRuns,
      accounts: () => void refreshProviders(),
      ...(sameHost ? {} : { designs: () => void refreshDesigns(), liveStatus: connectionChanged }),
      onError: (failure) => setError(failure.message),
      active: () => AppState.currentState === "active",
      watchActive: (listener) => {
        const subscription = AppState.addEventListener("change", (state) => listener(state === "active"));
        return () => subscription.remove();
      },
      // Live turns refresh every second; an idle Project only needs a slower check for changes made elsewhere.
      pollDelay: () => (running.current || Date.now() < busyUntil.current ? 1000 : 4000),
    });
    return () => {
      if (run.current === current) run.current = null;
      stop();
    };
  }, [client, path, sameHost, refresh, refreshRuns, refreshProviders, refreshDesigns, connectionChanged]);

  const expectActivity = useCallback(() => {
    busyUntil.current = Date.now() + 15000;
  }, []);
  const isSelected = useCallback(() => run.current !== null, []);
  const { previewProject: previewOpen } = main;
  const previewProject = useCallback(
    (projectPath: string) => (sameHost || !client ? previewOpen(projectPath) : client.preview(projectPath)),
    [sameHost, client, previewOpen],
  );
  // Only the routed Chat is remembered for the next launch.
  const rememberChat = useCallback(() => {}, []);
  const hostName = sameHost ? main.hostName : (host?.name ?? "Computer");
  return useMemo(
    () =>
      target
        ? {
            ...main,
            client,
            snapshot,
            error,
            setError,
            refresh,
            expectActivity,
            isSelected,
            previewProject,
            rememberChat,
            hostName,
            designs,
            models: ownProviders?.models ?? null,
            cliStatus: ownProviders?.status ?? null,
            providerError: ownProviders?.error ?? "",
            refreshProviders,
            providerRevision,
          }
        : null,
    [
      target,
      main,
      client,
      snapshot,
      error,
      refresh,
      expectActivity,
      isSelected,
      previewProject,
      rememberChat,
      hostName,
      designs,
      ownProviders,
      refreshProviders,
      providerRevision,
    ],
  );
}

// The pane a touch last landed in. A Chat's sheet opens from a touch in its pane, so it reads that pane's Project.
let touched: "routed" | "beside" = "routed";
export function touchPane(pane: "routed" | "beside") {
  touched = pane;
}

// The Chat beside's own session, while it has one, for the sheets it opens.
let besideSession: Session | null = null;
const listeners = new Set<() => void>();
function publish(session: Session | null) {
  if (besideSession === session) return;
  besideSession = session;
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const currentBesideSession = () => besideSession;

/** The sheets and pages a Chat opens about itself; each reads the Project of the pane it was opened from. */
const CHAT_SCREENS = new Set([
  "activity",
  "agents",
  "artifact-sheet",
  "background",
  "browser-sheet",
  "changes",
  "context-sheet",
  "design-share-sheet",
  "diff",
  "file-preview",
  "model-sheet",
  "permission-sheet",
  "ports-sheet",
  "pr-file",
  "(pr)",
  "simulator-sheet",
  "terminal-sheet",
]);

function PaneScreen({ name, children }: { name: string; children: React.ReactElement }) {
  // Decided once, as the screen opens: a later touch elsewhere doesn't move an open sheet to another Project.
  const [beside] = useState(() => touched === "beside" && CHAT_SCREENS.has(name));
  const session = useSyncExternalStore(subscribe, currentBesideSession);
  return <SessionScope session={beside ? session : null}>{children}</SessionScope>;
}

/** The root Stack's screen layout: a Chat sheet opened from the Chat beside reads that Chat's Project. */
export function paneScreenLayout({ route, children }: { route: { name: string }; children: React.ReactElement }) {
  return <PaneScreen name={route.name}>{children}</PaneScreen>;
}
