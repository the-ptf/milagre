import { OutboxService } from "../outbox";
import { ProviderUpdatesProvider } from "../provider-update-notice";
import { useState } from "react";
import { Platform } from "react-native";
import { Stack, router } from "expo-router";
import { ThemeProvider, DarkTheme, DefaultTheme } from "expo-router/react-navigation";
import { StatusBar } from "expo-status-bar";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SessionProvider, useSession } from "../session";
import { ActivityProvider } from "../live-activity";
import { PushProvider } from "../push";
import { StartupSplash } from "../startup-splash";
import { radius } from "../design-tokens";
import { useTheme } from "../theme";
import { UpdateShell } from "../update-sheet";
import { stackScreenOptions } from "../stack-options";
import { SidePanelsHost, SidePanelsProvider, enterUnderPanel } from "../side-panels";
import { setConfirmPresenter } from "../confirm-store";
import { setChoicePresenter } from "../choice-store";
import { setPromptPresenter } from "../text-prompt";
import { setChatPageDisk } from "../chat-pages";
import { chatPageDisk } from "../chat-page-disk";
import { setLinkPresenter } from "../link-chat-store";
import { SplitProvider } from "../split-context";
import { HardwareShortcuts, SplitShell } from "../split-layout";
import { paneScreenLayout } from "../beside-session";

setConfirmPresenter(() => router.push("/confirm-sheet"));
setChoicePresenter(() => router.push("/choice-sheet"));
setPromptPresenter(() => router.push("/prompt-sheet"));
setChatPageDisk(chatPageDisk);
setLinkPresenter(() => router.push("/link-chat"));

export const unstable_settings = { anchor: "index" };

export default function Layout() {
  const { colors: palette, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const base = scheme === "dark" ? DarkTheme : DefaultTheme;
  const theme = {
    ...base,
    colors: { ...base.colors, primary: palette.accent, background: palette.page, card: palette.page, text: palette.ink, border: palette.line },
  };
  const sheet = {
    presentation: "formSheet",
    sheetGrabberVisible: true,
    sheetCornerRadius: radius.sheet,
    headerShown: false,
    contentStyle: { backgroundColor: palette.page },
  } as const;
  // Android: react-native-screens 4.30 learns the status bar height only from a later insets change, so a full-height
  // reach the top and keep their content below the status bar themselves: a page with a native header (Settings, the
  const fullStackSheet = {
    ...sheet,
    sheetAllowedDetents: [1],
    ...(Platform.OS === "android" ? { sheetShouldOverflowTopInset: true } : {}),
  };
  const fullSheet = {
    ...fullStackSheet,
    ...(Platform.OS === "android" ? { contentStyle: { backgroundColor: palette.page, paddingTop: insets.top } } : {}),
  };
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SessionProvider>
          <OutboxService />
          <PushProvider>
            <ActivityProvider>
              <SidePanelsProvider>
                <SplitProvider>
                  <ThemeProvider value={theme}>
                    {/* oxlint-disable-next-line react/style-prop-object -- React Native style object; the rule targets web DOM styles */}
                    <StatusBar style="auto" />
                    <UpdateShell>
                      <ProviderUpdatesProvider>
                        {/* On a wide iPad the Chats list is pinned beside the screen; narrower, it slides over it. */}
                        <SplitShell>
                          <Stack screenOptions={stackScreenOptions(palette)} screenLayout={paneScreenLayout}>
                            <Stack.Screen name="index" options={{ title: "Computers" }} />
                            {/* Settings: one sheet holding a Stack of its own (app/(settings)/_layout.tsx), so its pages open inside it; a card on an iPad. */}
                            <Stack.Screen
                              name="(settings)"
                              options={
                                // A native sheet stops near 580 pt on an iPad, too narrow for the list beside a page: there
                                Platform.OS === "ios" && Platform.isPad
                                  ? {
                                      presentation: "transparentModal",
                                      animation: "fade",
                                      headerShown: false,
                                      contentStyle: { backgroundColor: "transparent" },
                                    }
                                  : fullStackSheet
                              }
                            />
                            <Stack.Screen
                              name="update-sheet"
                              options={{
                                presentation: "fullScreenModal",
                                animation: "fade",
                                headerShown: false,
                                contentStyle: { backgroundColor: palette.page },
                              }}
                            />
                            <Stack.Screen name="confirm-sheet" options={{ ...sheet, sheetAllowedDetents: "fitToContents" }} />
                            <Stack.Screen name="prompt-sheet" options={{ ...sheet, sheetAllowedDetents: "fitToContents" }} />
                            <Stack.Screen name="orchestrator-hint" options={{ ...sheet, sheetAllowedDetents: "fitToContents" }} />
                            {/* Native search needs the header visible at presentation: enabling it later remounts the sheet. */}
                            <Stack.Screen
                              name="choice-sheet"
                              options={{ ...sheet, headerShown: true, headerBackVisible: false, sheetAllowedDetents: [0.75, 1], sheetInitialDetentIndex: 0 }}
                            />
                            <Stack.Screen name="chime-sheet" options={{ ...sheet, sheetAllowedDetents: "fitToContents" }} />
                            <Stack.Screen name="add-computer" options={fullSheet} />
                            <Stack.Screen name="pair" options={{ title: "Pairing" }} />
                            <Stack.Screen name="projects" options={{ title: "Projects" }} />
                            <Stack.Screen name="canvas" options={{ title: "Canvas" }} />
                            <Stack.Screen name="routines" options={{ title: "Routines" }} />
                            <Stack.Screen name="pull-requests" options={{ title: "Pull requests" }} />
                            <Stack.Screen name="design-library" options={{ title: "Designs" }} />
                            <Stack.Screen name="orchestrator" options={{ title: "Orchestrator" }} />
                            <Stack.Screen name="orchestrator-task" options={{ ...sheet, sheetAllowedDetents: [0.7, 1], sheetInitialDetentIndex: 0 }} />
                            <Stack.Screen name="orchestrator-waiting" options={{ ...sheet, sheetAllowedDetents: [0.7, 1], sheetInitialDetentIndex: 0 }} />
                            <Stack.Screen name="routine" options={{ title: "Routine" }} />
                            <Stack.Screen name="routine-form" options={fullSheet} />
                            <Stack.Screen name="flow-run" options={{ title: "Run" }} />
                            <Stack.Screen name="flow-step" options={fullSheet} />
                            <Stack.Screen name="flow-add-step" options={{ ...sheet, sheetAllowedDetents: "fitToContents" }} />
                            <Stack.Screen name="flow-publish" options={{ ...sheet, sheetAllowedDetents: "fitToContents" }} />
                            <Stack.Screen name="link-projects" options={fullSheet} />
                            <Stack.Screen name="link-chat" options={fullSheet} />
                            <Stack.Screen name="choose-projects" options={{ ...sheet, sheetAllowedDetents: [0.6, 1], sheetInitialDetentIndex: 0 }} />
                            <Stack.Screen
                              name="chat"
                              options={({ route }) => ({
                                title: "Chat",
                                // The Chat clears its own header (topClear) and fades the transcript under it, on Android too.
                                headerTransparent: true,
                                headerStyle: { backgroundColor: "transparent" },
                                ...(enterUnderPanel(route.key) ? { animation: "none" as const } : {}),
                              })}
                            />
                            <Stack.Screen name="context-sheet" options={{ ...sheet, sheetAllowedDetents: "fitToContents" }} />
                            <Stack.Screen name="permission-sheet" options={{ ...sheet, sheetAllowedDetents: [0.42, 0.6], sheetInitialDetentIndex: 0 }} />
                            <Stack.Screen name="model-sheet" options={fullSheet} />
                            <Stack.Screen name="agents" options={{ ...sheet, sheetAllowedDetents: [0.5, 1], sheetInitialDetentIndex: 0 }} />
                            <Stack.Screen
                              name="inbox"
                              options={{ ...sheet, sheetAllowedDetents: "fitToContents", contentStyle: { backgroundColor: palette.surface } }}
                            />
                            <Stack.Screen name="ports-sheet" options={{ ...sheet, sheetAllowedDetents: [0.5, 1] }} />
                            {/* A full-screen page, not a sheet: a downward drag on the simulator must reach the device, not dismiss the viewer. */}
                            <Stack.Screen
                              name="simulator-sheet"
                              options={{ presentation: "fullScreenModal", headerShown: false, contentStyle: { backgroundColor: palette.page } }}
                            />
                            <Stack.Screen name="browser-sheet" options={fullSheet} />
                            <Stack.Screen
                              name="terminal-sheet"
                              options={{ presentation: "fullScreenModal", headerShown: false, contentStyle: { backgroundColor: palette.page } }}
                            />
                            <Stack.Screen
                              name="artifact-sheet"
                              options={{ presentation: "fullScreenModal", headerShown: false, contentStyle: { backgroundColor: palette.page } }}
                            />
                            <Stack.Screen name="design-share-sheet" options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
                            <Stack.Screen
                              name="diagram-sheet"
                              options={{ presentation: "fullScreenModal", headerShown: false, contentStyle: { backgroundColor: palette.surface } }}
                            />
                            <Stack.Screen name="activity" options={{ ...sheet, sheetAllowedDetents: [0.5, 1] }} />
                            <Stack.Screen name="background" options={{ ...sheet, sheetAllowedDetents: [0.5, 1] }} />
                            <Stack.Screen name="handoff-brief" options={{ ...sheet, sheetAllowedDetents: [0.5, 1] }} />
                            <Stack.Screen
                              name="viewer"
                              options={{
                                presentation: "transparentModal",
                                headerShown: false,
                                animation: "none",
                                contentStyle: { backgroundColor: "transparent" },
                              }}
                            />
                            <Stack.Screen name="chat-details" options={{ title: "Rename Chat" }} />
                            <Stack.Screen name="changes" options={{ title: "Changes" }} />
                            <Stack.Screen name="file-preview" options={{ title: "File preview" }} />
                            <Stack.Screen name="diff" options={{ title: "Diff" }} />
                            <Stack.Screen name="(pr)" options={fullStackSheet} />
                            <Stack.Screen name="pr-file" options={{ title: "" }} />
                          </Stack>
                        </SplitShell>
                        <SidePanelsHost />
                        <HardwareShortcuts />
                      </ProviderUpdatesProvider>
                    </UpdateShell>
                    <Splash />
                  </ThemeProvider>
                </SplitProvider>
              </SidePanelsProvider>
            </ActivityProvider>
          </PushProvider>
        </SessionProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

function Splash() {
  const session = useSession();
  const [shown, setShown] = useState(true);
  return shown ? <StartupSplash ready={session.booted} onDone={() => setShown(false)} /> : null;
}
