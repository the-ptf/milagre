import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, AppState, View, Text } from "react-native";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { router, useNavigationContainerRef } from "expo-router";
import * as Updates from "expo-updates";
import type { NavigationState, PartialState } from "expo-router/react-navigation";
import { createUpdateController, watchUpdates, type UpdateState } from "./update-controller";
import { useTheme } from "./theme";
import { IconButton, PillButton } from "./ui";

const AppUpdates = createContext<{ state: UpdateState; check: (force?: boolean) => Promise<void>; install: () => Promise<void>; dismiss: () => void } | null>(
  null,
);
export function useAppUpdates() {
  const updates = useContext(AppUpdates);
  if (!updates) throw new Error("App updates need UpdateShell.");
  return updates;
}

export function UpdateShell({ children }: { children: ReactNode }) {
  const { isStartupProcedureRunning, isChecking, isDownloading, isUpdatePending, checkError, downloadError, downloadedUpdate } = Updates.useUpdates();
  const controller = useMemo(
    () =>
      createUpdateController({
        enabled: !__DEV__ && Updates.isEnabled,
        check: Updates.checkForUpdateAsync,
        fetch: Updates.fetchUpdateAsync,
        reload: Updates.reloadAsync,
      }),
    [],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.get, controller.get);
  useEffect(() => {
    controller.syncNative({ isStartupProcedureRunning, isChecking, isDownloading, isUpdatePending, checkError, downloadError, downloadedUpdate });
    if (AppState.currentState === "active") void controller.check();
  }, [controller, isStartupProcedureRunning, isChecking, isDownloading, isUpdatePending, checkError, downloadError, downloadedUpdate]);
  useEffect(
    () =>
      watchUpdates(controller, {
        active: () => AppState.currentState === "active",
        watchActive: (listener) => {
          const subscription = AppState.addEventListener("change", listener);
          return () => subscription.remove();
        },
        schedule: (refresh, ms) => {
          const timer = setInterval(refresh, ms);
          return () => clearInterval(timer);
        },
      }),
    [controller],
  );
  const { presented, dismiss } = useUpdatePresentation(state);
  const navigationRef = useNavigationContainerRef();
  const pushed = useRef(false);
  const showing = useRef(presented);
  const defer = useCallback(() => {
    showing.current = false;
    dismiss();
  }, [dismiss]);
  useEffect(() => {
    showing.current = presented;
    if (!presented) {
      pushed.current = false;
      return;
    }
    const present = () => {
      if (!showing.current) return;
      const navigation = updateNavigator(navigationRef.getRootState());
      if (!navigation?.key) return;
      const sheetIndex = navigation.routes.findIndex((route) => route.name === "update-sheet");
      if (sheetIndex >= 0) {
        pushed.current = false;
        // An in-flight connection or notification can navigate after the prompt opens.
        // Keep that destination underneath one prompt, preserving its page state.
        if (sheetIndex !== navigation.index) {
          const routes = [...navigation.routes.filter((_, index) => index !== sheetIndex), { name: "update-sheet" }];
          navigationRef.dispatch({ type: "RESET", target: navigation.key, payload: { ...navigation, routes, index: routes.length - 1 } });
        }
      } else if (!pushed.current) {
        pushed.current = true;
        router.push("/update-sheet");
      }
    };
    const unsubscribe = navigationRef.addListener("state", present);
    present();
    return unsubscribe;
  }, [presented, navigationRef]);
  return <AppUpdates.Provider value={{ state, check: controller.check, install: controller.install, dismiss: defer }}>{children}</AppUpdates.Provider>;
}

// Expo Router wraps the app stack in its generated root navigator.
function updateNavigator(state: NavigationState | PartialState<NavigationState> | undefined): NavigationState | PartialState<NavigationState> | undefined {
  if (!state) return;
  if ("routeNames" in state && state.routeNames?.includes("update-sheet")) return state;
  for (const route of state.routes) {
    const navigator = updateNavigator(route.state);
    if (navigator) return navigator;
  }
}

export function useUpdatePresentation(state: UpdateState) {
  const actionable = state.status === "ready" || state.status === "error";
  const [presentation, setPresentation] = useState({
    status: state.status,
    updateId: state.updateId,
    presented: actionable && AppState.currentState === "active",
    dismissed: false,
  });
  if (presentation.status !== state.status || presentation.updateId !== state.updateId) {
    const dismissed = presentation.dismissed && (!state.updateId || state.updateId === presentation.updateId);
    setPresentation({
      ...presentation,
      status: state.status,
      updateId: state.updateId,
      dismissed,
      presented: presentation.presented || (!dismissed && actionable && AppState.currentState === "active"),
    });
  }
  const dismiss = useCallback(() => setPresentation((previous) => ({ ...previous, presented: false, dismissed: true })), []);
  useEffect(() => {
    // Dismissal survives foreground checks; a different downloaded update can prompt again.
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") setPresentation((previous) => ({ ...previous, presented: previous.presented || (!previous.dismissed && actionable) }));
    });
    return () => subscription.remove();
  }, [actionable]);
  return { presented: presentation.presented, dismiss };
}

export function UpdateSettingsBadge() {
  const { state } = useAppUpdates();
  const { colors } = useTheme();
  if (!["ready", "downloading", "error"].includes(state.status)) return null;
  return (
    <View
      accessibilityLabel="Update available"
      pointerEvents="none"
      style={{ position: "absolute", right: 5, top: 5, width: 7, height: 7, borderRadius: 4, backgroundColor: colors.green }}
    />
  );
}

export function UpdateSheet({
  state,
  onUpdate,
  onRetry,
  onDismiss,
  onNotes,
}: {
  state: UpdateState;
  onUpdate: () => void;
  onRetry: () => void;
  onDismiss: () => void;
  onNotes: () => void;
}) {
  const { colors } = useTheme();
  const actionable = state.status === "ready" || state.status === "error";
  const busy = state.status === "checking" || state.status === "downloading" || state.status === "restarting";
  const title =
    state.status === "checking"
      ? "Checking for updates"
      : state.status === "downloading"
        ? "Downloading update"
        : state.status === "restarting"
          ? "Applying update"
          : state.status === "up-to-date"
            ? "Up to date"
            : state.status === "check-error"
              ? "Could not check for updates"
              : "Update available";
  const description =
    state.status === "ready"
      ? "A new version of Milagre is ready. Update now to restart the app and apply it."
      : state.status === "restarting"
        ? "Milagre is restarting with the new version."
        : state.status === "up-to-date"
          ? "You have the latest version of Milagre."
          : busy
            ? "You can keep using Milagre while the update downloads."
            : "";
  return (
    <View accessibilityLiveRegion="polite" style={{ padding: 24, paddingTop: 32, gap: 20 }}>
      <View style={{ gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          {busy && <ActivityIndicator accessibilityLabel={title} color={colors.ink2} />}
          <Text accessibilityRole="header" style={{ flex: 1, color: colors.ink, fontSize: 24, fontWeight: "600" }}>
            {title}
          </Text>
          {state.status !== "restarting" && <IconButton label="Dismiss update" icon={Cancel01Icon} onPress={onDismiss} />}
        </View>
        {description ? <Text style={{ color: colors.ink2, fontSize: 16, lineHeight: 23 }}>{description}</Text> : null}
        {state.error ? (
          <Text selectable accessibilityRole="alert" style={{ color: colors.red, fontSize: 15, lineHeight: 22 }}>
            {state.error}
          </Text>
        ) : null}
      </View>
      <View style={{ gap: 10 }}>
        {(actionable || state.status === "downloading") && <PillButton title="What's new" secondary onPress={onNotes} />}
        {actionable || state.status === "check-error" ? (
          <PillButton title={state.error ? "Try again" : "Update now"} onPress={state.status === "ready" ? onUpdate : onRetry} />
        ) : null}
        {state.status === "up-to-date" && <PillButton title="Done" secondary onPress={onDismiss} />}
      </View>
    </View>
  );
}
