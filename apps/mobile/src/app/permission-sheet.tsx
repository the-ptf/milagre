import { ScrollView, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { PERMISSION_MODES } from "@milagre/shared/model-copy";
import type { PermissionMode } from "@milagre/shared/model";
import { PermissionIcon } from "../agent-controls";
import { useComposer, useSession } from "../session";
import { CheckRow, CircleButton, Group, SheetHeader, useStyles } from "../ui";
import { projectOfKey, sessionIdFromKey } from "@milagre/shared/agent-runs";
import { chatPreferences } from "../turn-options";

/** Desktop's permission picker as a sheet: Ask approval, Auto mode, Full permission. A tap applies it and closes. */
export default function PermissionSheet() {
  const styles = useStyles();
  const { chatId, busy } = useLocalSearchParams<{ chatId: string; busy?: string }>();
  const composer = useComposer();
  const session = useSession();
  const draft = /#new:/.test(chatId);
  const project = session.snapshot?.project;
  const chatMode = !draft && project?.path === projectOfKey(chatId) ? project.state.sessions[sessionIdFromKey(chatId)]?.permissionMode : undefined;
  const current = chatPreferences(
    composer.preferences[chatId],
    composer.defaults,
    chatMode,
    session.snapshot?.runs.runs[chatId]?.permissionMode,
  ).permissionMode;
  // Like desktop: the pick becomes the default for new Chats and applies to this Chat's agent right away, including a
  // turn that is running (its next tool request uses the new mode). A Chat not yet sent has no agent to tell.
  const pick = (mode: PermissionMode) => {
    composer.setPreferences((all) => ({
      ...all,
      [chatId]: { ...(all[chatId] || composer.defaults), permissionMode: mode, permissionPick: { mode, over: chatMode } },
    }));
    composer.setDefaultPermission(mode);
    if (session.client && !draft) void session.client.call("agent:set-permission-mode", [{ chatId, mode }]).catch(() => {});
    router.back();
  };
  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 32 }}>
      <SheetHeader title="Permissions" leading={<CircleButton label="Close" icon={Cancel01Icon} onPress={() => router.back()} />} />
      <View style={{ paddingHorizontal: 16, gap: 12 }}>
        {busy === "1" && <Text style={styles.caption}>Applies to your next message. This turn keeps its permissions.</Text>}
        <Group role="radiogroup" accessibilityLabel="Permissions">
          {PERMISSION_MODES.map((mode) => (
            <CheckRow
              key={mode.id}
              title={mode.name}
              subtitle={mode.description}
              leading={<PermissionIcon mode={mode.id} size={20} />}
              checked={mode.id === current}
              onPress={() => pick(mode.id)}
            />
          ))}
        </Group>
      </View>
    </ScrollView>
  );
}
