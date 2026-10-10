import { useState } from "react";
import { Stack, router } from "expo-router";
import { ThemeProvider, DarkTheme, DefaultTheme } from "expo-router/react-navigation";
import { StatusBar } from "expo-status-bar";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SessionProvider, useSession } from "../session";
import { ActivityProvider } from "../live-activity";
import { PushProvider } from "../push";
import { StartupSplash } from "../startup-splash";
import { useTheme } from "../theme";
import { UpdateShell } from "../update-sheet";
import { SidePanelsHost, SidePanelsProvider } from "../side-panels";
import { setConfirmPresenter } from "../confirm-store";
import { setChoicePresenter } from "../choice-store";
import { setLinkPresenter } from "../link-chat-store";

// Confirmations open as a bottom sheet over whatever is showing, the side panels included.
setConfirmPresenter(() => router.push("/confirm-sheet"));
setChoicePresenter(() => router.push("/choice-sheet"));
setLinkPresenter(() => router.push("/link-chat"));

export default function Layout() {
  const { colors: palette, scheme } = useTheme();
  const base = scheme === "dark" ? DarkTheme : DefaultTheme;
  const theme = {
    ...base,
    colors: { ...base.colors, primary: palette.accent, background: palette.page, card: palette.page, text: palette.ink, border: palette.line },
  };
  // Titles sit inline in a transparent top bar; content blurs softly as it scrolls under it (iOS 26 scroll edge effect).
  const sheet = {
    presentation: "formSheet",
    sheetGrabberVisible: true,
    sheetCornerRadius: 28,
    headerShown: false,
    contentStyle: { backgroundColor: palette.page },
  } as const;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SessionProvider>
          <PushProvider>
            <ActivityProvider>
              <SidePanelsProvider>
                <ThemeProvider value={theme}>
                  {/* oxlint-disable-next-line react/style-prop-object -- React Native style object; the rule targets web DOM styles */}
                  <StatusBar style="auto" />
                  <UpdateShell>
                    <Stack
                      screenOptions={{
                        headerTransparent: true,
                        headerStyle: { backgroundColor: "transparent" },
                        scrollEdgeEffects: { top: "soft" },
                        headerTintColor: palette.ink,
                        headerTitleStyle: { color: palette.ink, fontWeight: "600", fontSize: 17 },
                        contentStyle: { backgroundColor: palette.page },
                        headerShadowVisible: false,
                        headerBackButtonDisplayMode: "minimal",
                      }}
                    >
                      <Stack.Screen name="index" options={{ title: "Computers" }} />
                      <Stack.Screen name="project-accounts" options={{ title: "Project Accounts" }} />
                      <Stack.Screen name="accounts" options={{ title: "Accounts" }} />
                      <Stack.Screen name="settings" options={{ title: "Settings" }} />
                      <Stack.Screen name="appearance" options={{ title: "Appearance" }} />
                      <Stack.Screen name="update-sheet" options={{ ...sheet, sheetAllowedDetents: "fitToContents" }} />
                      <Stack.Screen name="confirm-sheet" options={{ ...sheet, sheetAllowedDetents: "fitToContents" }} />
                      {/* Native search needs the header visible at presentation: enabling it later remounts the sheet. */}
                      <Stack.Screen
                        name="choice-sheet"
                        options={{ ...sheet, headerShown: true, headerBackVisible: false, sheetAllowedDetents: [0.75, 1], sheetInitialDetentIndex: 0 }}
                      />
                      <Stack.Screen name="notifications" options={{ title: "Notifications" }} />
                      <Stack.Screen name="usage" options={{ title: "Plan usage" }} />
                      <Stack.Screen name="skills" options={{ title: "Skills" }} />
                      <Stack.Screen name="mcp" options={{ title: "MCP" }} />
                      <Stack.Screen name="experimental" options={{ title: "Experimental" }} />
                      <Stack.Screen name="skill" options={{ title: "Skill" }} />
                      <Stack.Screen name="add-computer" options={{ ...sheet, sheetAllowedDetents: [1] }} />
                      <Stack.Screen name="pair" options={{ title: "Pairing" }} />
                      <Stack.Screen name="projects" options={{ title: "Projects" }} />
                      <Stack.Screen name="project-settings" options={{ title: "Project" }} />
                      <Stack.Screen name="link-projects" options={{ ...sheet, sheetAllowedDetents: [1] }} />
                      <Stack.Screen name="link-chat" options={{ ...sheet, sheetAllowedDetents: [1] }} />
                      <Stack.Screen name="choose-projects" options={{ ...sheet, sheetAllowedDetents: [0.6, 1], sheetInitialDetentIndex: 0 }} />
                      <Stack.Screen name="chat" options={{ title: "Chat" }} />
                      <Stack.Screen name="context-sheet" options={{ ...sheet, sheetAllowedDetents: "fitToContents" }} />
                      <Stack.Screen name="permission-sheet" options={{ ...sheet, sheetAllowedDetents: [0.42, 0.6], sheetInitialDetentIndex: 0 }} />
                      {/* Full height: the effort, Fast and Ultracode panel pinned at the bottom leaves a half-height sheet room for one model. */}
                      <Stack.Screen name="model-sheet" options={{ ...sheet, sheetAllowedDetents: [1] }} />
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
                      <Stack.Screen name="browser-sheet" options={{ ...sheet, sheetAllowedDetents: [1] }} />
                      {/* Full screen too: a downward drag scrolls the Terminal's output instead of dismissing it. */}
                      <Stack.Screen
                        name="terminal-sheet"
                        options={{ presentation: "fullScreenModal", headerShown: false, contentStyle: { backgroundColor: palette.page } }}
                      />
                      {/* Full screen too: a design scrolls and takes taps of its own. */}
                      <Stack.Screen
                        name="artifact-sheet"
                        options={{ presentation: "fullScreenModal", headerShown: false, contentStyle: { backgroundColor: palette.page } }}
                      />
                      <Stack.Screen name="activity" options={{ ...sheet, sheetAllowedDetents: [0.5, 1] }} />
                      <Stack.Screen name="handoff-brief" options={{ ...sheet, sheetAllowedDetents: [0.5, 1] }} />
                      <Stack.Screen
                        name="viewer"
                        options={{ presentation: "transparentModal", headerShown: false, animation: "none", contentStyle: { backgroundColor: "transparent" } }}
                      />
                      <Stack.Screen name="chat-details" options={{ title: "Rename Chat" }} />
                      <Stack.Screen name="changes" options={{ title: "Changes" }} />
                      <Stack.Screen name="file-preview" options={{ title: "File preview" }} />
                      <Stack.Screen name="diff" options={{ title: "Diff" }} />
                    </Stack>
                    <SidePanelsHost />
                  </UpdateShell>
                  <Splash />
                </ThemeProvider>
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
