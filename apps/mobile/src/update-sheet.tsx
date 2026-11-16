import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppState, Image, View, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useNavigationContainerRef } from "expo-router";
import * as Updates from "expo-updates";
import type { NavigationState, PartialState } from "expo-router/react-navigation";
import { createUpdateController, watchUpdates, type UpdateState } from "./update-controller";
import { lineHeight, radius, type } from "./design-tokens";
import { SpinnerRing } from "./icons";
import { useTheme } from "./theme";
import { PillButton, useAnnounce } from "./ui";

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
  const value = useMemo(() => ({ state, check: controller.check, install: controller.install, dismiss: defer }), [state, controller, defer]);
  return <AppUpdates.Provider value={value}>{children}</AppUpdates.Provider>;
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
      style={{ position: "absolute", right: 4, top: 4, width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.green }}
    />
  );
}

export function UpdateSheet({ state, onUpdate, onRetry, onDismiss }: { state: UpdateState; onUpdate: () => void; onRetry: () => void; onDismiss: () => void }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const busy = state.status === "checking" || state.status === "downloading" || state.status === "restarting";
  const title =
    state.status === "checking"
      ? "Checking for updates"
      : state.status === "downloading"
        ? "Downloading update"
        : state.status === "restarting"
          ? "Updating Milagre"
          : state.status === "up-to-date"
            ? "Milagre is up to date"
            : state.status === "check-error"
              ? "Could not check for updates"
              : "Update Milagre";
  const description =
    state.status === "ready"
      ? "A newer version is ready. Update for the latest fixes, or keep going on this one."
      : state.status === "restarting"
        ? "Milagre is restarting with the new version."
        : state.status === "up-to-date"
          ? "You have the latest version."
          : busy
            ? "You can keep using Milagre while the update downloads."
            : "";
  const retry = state.status === "error" || state.status === "check-error";
  // Status changes and errors, not the title the screen opens with (VoiceOver reads that as the screen appears).
  useAnnounce(state.error ? `${title}. ${state.error}` : title);
  return (
    <View style={{ flex: 1, paddingTop: insets.top + 48, paddingBottom: insets.bottom + 16, paddingHorizontal: 24 }}>
      <View style={{ alignItems: "center", gap: 8 }}>
        <Text
          accessibilityRole="header"
          style={{ color: colors.ink, fontSize: type.title2, lineHeight: lineHeight.title2, fontWeight: "600", textAlign: "center" }}
        >
          {title}
        </Text>
        {description ? (
          <Text style={{ maxWidth: 320, color: colors.ink2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, textAlign: "center" }}>
            {description}
          </Text>
        ) : null}
        {state.error ? (
          <Text
            selectable
            accessibilityRole="alert"
            style={{ maxWidth: 320, color: colors.redInk, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, textAlign: "center" }}
          >
            {state.error}
          </Text>
        ) : null}
      </View>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 24 }}>
        <Image source={require("../assets/splash-mark-dark.png")} accessibilityIgnoresInvertColors style={{ width: 112, height: 112, tintColor: colors.ink }} />
        {busy && <SpinnerRing size={20} tone="ink2" />}
      </View>
      <View style={{ flexDirection: "row", justifyContent: "center", gap: 12 }}>
        {state.status === "up-to-date" ? (
          <PillButton title="Done" onPress={onDismiss} style={{ flex: 1, maxWidth: 240 }} />
        ) : state.status === "restarting" ? null : (
          <>
            <PillButton title="Not now" secondary onPress={onDismiss} />
            {state.status === "ready" || retry ? (
              <PillButton
                title={state.error ? "Try again" : "Update"}
                onPress={state.status === "ready" ? onUpdate : onRetry}
                style={{ flex: 1, maxWidth: 240 }}
              />
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}
