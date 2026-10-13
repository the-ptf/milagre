import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, AppState } from "react-native";
import { router, useGlobalSearchParams, usePathname } from "expo-router";
import { createClient } from "./client";
import { relayRuntime } from "./relay-native";
import { lanRoutes } from "./routes-native";
import { savedHosts } from "./hosts-native";
import { useSession } from "./session";
import { createPushController, notificationTarget, viewedChat, type PushView } from "./push-controller";
import { nativeActivity } from "./live-activity-native";
import { pushNative, pushStore } from "./push-native";
import type { PushPreferences, PushState } from "./push-store";
import type { SavedHost } from "./hosts-store";

function usePushState() {
  const session = useSession();
  const sessionRef = useRef(session);
  useLayoutEffect(() => {
    sessionRef.current = session;
  });
  const path = usePathname();
  const params = useGlobalSearchParams<{ id?: string; worktreeId?: string; projectPath?: string; hostId?: string }>();
  const [state, setState] = useState<PushState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ data: unknown; ticket: number; navigationVersion: number } | null>(null);
  const ticket = useRef(0);
  const activeTap = useRef<string | null>(null);
  const targetGeneration = useRef<number | null>(null);
  const forgetHost = useCallback(async (host: SavedHost) => {
    const current = (await savedHosts.list()).find((item) => item.id === host.id);
    if (current?.token === host.token && current.lastUsed === host.lastUsed) {
      sessionRef.current.cancelNavigation();
      if (sessionRef.current.client?.url === host.id) sessionRef.current.disconnect();
      await nativeActivity?.endAsync(host.id);
      await savedHosts.forget(host.id);
      if (host.relay) relayRuntime.forget(host.relay.hostId);
      lanRoutes.forget(host.id);
      await sessionRef.current.loadHosts();
    }
  }, []);
  // The factory only stores forgetHost; it invokes it later from async refresh, never during render.
  // eslint-disable-next-line react-hooks/refs
  const [controller] = useState(() =>
    createPushController({
      store: pushStore,
      hosts: savedHosts.list,
      forgetHost,
      native: pushNative,
      call: (host, method, args) => createClient(host, fetch, 5000, relayRuntime).call(method, args),
      onError: setError,
    }),
  );
  const targetMatches =
    (!params.hostId || params.hostId === session.client?.url) && (!params.projectPath || params.projectPath === session.snapshot?.project.path);
  const chat: PushView =
    path === "/chat" && targetMatches && session.client && session.snapshot && params.id && /^\d+$/.test(String(params.id))
      ? { hostId: session.client.url, chatId: `${session.snapshot.project.path}#${params.id}` }
      : null;
  // A sheet's route replaces /chat, but the Chat it opened over is still on screen.
  const [shown, setShown] = useState<PushView>(null);
  const view = viewedChat(path, chat, shown, session.client?.url);
  if (view?.hostId !== shown?.hostId || view?.chatId !== shown?.chatId) setShown(view);
  const viewRef = useRef(view);
  useLayoutEffect(() => {
    viewRef.current = view;
  });
  const publish = useCallback(async () => setState(await pushStore.read()), []);
  const refreshing = useRef<Promise<void> | null>(null);
  const refresh = useCallback(() => {
    if (refreshing.current) return refreshing.current;
    const next = controller
      .refresh()
      .catch((e) => setError(e.message))
      .then(publish)
      .catch((e) => setError(e.message))
      .finally(() => {
        refreshing.current = null;
      });
    refreshing.current = next;
    return next;
  }, [controller, publish]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await publish();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const hostKeys = session.hosts.map((host) => `${host.id}:${host.lastUsed}`).join("|");
  useEffect(() => {
    void refresh();
  }, [refresh, hostKeys]);
  const route = JSON.stringify([path, params.hostId, params.projectPath, params.id, params.worktreeId]);
  const previousRoute = useRef(route);
  useEffect(() => {
    if (previousRoute.current !== route) {
      ticket.current++;
      if (targetGeneration.current === sessionRef.current.navigationVersion()) sessionRef.current.cancelNavigation();
      targetGeneration.current = null;
      activeTap.current = null;
      setPending(null);
      previousRoute.current = route;
    }
  }, [route]);
  const invalidatePending = useCallback(() => {
    ticket.current++;
    activeTap.current = null;
  }, []);
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void pushNative
      .listen(
        () => (AppState.currentState === "active" ? viewRef.current : null),
        (data) => {
          const eventId = (data as { eventId?: unknown } | null)?.eventId;
          if (typeof eventId === "string" && eventId && activeTap.current === eventId) return;
          activeTap.current = typeof eventId === "string" ? eventId : null;
          sessionRef.current.claimAutoOpen();
          sessionRef.current.cancelNavigation();
          setPending({ data, ticket: ++ticket.current, navigationVersion: sessionRef.current.navigationVersion() });
        },
        () => void refresh(),
      )
      .then((cleanup) => {
        if (cancelled) cleanup();
        else stop = cleanup;
      })
      .catch((e) => setError(e.message));
    return () => {
      cancelled = true;
      invalidatePending();
      stop?.();
    };
  }, [refresh, invalidatePending]);
  useEffect(() => {
    const update = () => void controller.focus(AppState.currentState === "active" ? viewRef.current : null).catch(() => {});
    update();
    const timer = setInterval(update, 10000);
    const subscription = AppState.addEventListener("change", (next) => {
      update();
      if (next === "active") void refresh();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [controller, refresh, view?.hostId, view?.chatId, state?.enabled]);
  useEffect(() => {
    if (!pending || !session.booted) return;
    void (async () => {
      const saved = await savedHosts.list();
      const removals = (await pushStore.read()).pending;
      const hosts = saved.filter(
        (host) => !removals.some((item) => item.forgotten && item.id === host.id && item.token === host.token && item.lastUsed === host.lastUsed),
      );
      if (pending.ticket !== ticket.current || pending.navigationVersion !== sessionRef.current.navigationVersion()) return;
      const target = notificationTarget(pending.data, hosts);
      if (!target) throw new Error("This notification belongs to a computer that is no longer paired. Pair it again to open its Chat.");
      const opening = sessionRef.current.openNotificationTarget(target.host, target.projectPath, target.sessionId);
      targetGeneration.current = sessionRef.current.navigationVersion();
      const opened = await opening;
      if (opened && pending.ticket === ticket.current) {
        router.dismissAll();
        router.replace({ pathname: "/chat", params: { id: String(target.sessionId), projectPath: target.projectPath, hostId: target.host.address } });
      }
    })()
      .catch((e) => {
        if (pending.ticket === ticket.current) Alert.alert("Could not open Chat", e.message);
      })
      .finally(() => {
        if (pending.ticket === ticket.current) {
          targetGeneration.current = null;
          activeTap.current = null;
          setPending(null);
        }
      });
  }, [pending, session.booted]);
  return {
    state,
    error,
    busy,
    unavailable: pushNative.available(),
    refresh,
    enable: () => run(() => controller.enable()),
    disable: () => run(() => controller.disable()),
    preferences: (value: Partial<PushPreferences>) => run(() => controller.preferences(value)),
    forget: async (host: SavedHost) => {
      await controller.forget(host);
      await publish();
    },
  };
}
const PushContext = createContext<ReturnType<typeof usePushState> | null>(null);
export function PushProvider({ children }: { children: React.ReactNode }) {
  const value = usePushState();
  return <PushContext.Provider value={value}>{children}</PushContext.Provider>;
}
export function usePush() {
  const push = useContext(PushContext);
  if (!push) throw new Error("PushProvider is required");
  return push;
}
