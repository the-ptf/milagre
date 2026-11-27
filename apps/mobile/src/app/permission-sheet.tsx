import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { PERMISSION_MODES } from "@milagre/shared/model-copy";
import type { PermissionMode } from "@milagre/shared/model";
import { PermissionIcon, useChatPermissionMode } from "../agent-controls";
import { useComposer, useSession } from "../session";
import { CheckRow, CircleButton, Group, SheetHeader, useStyles } from "../ui";
import { projectOfKey, sessionIdFromKey } from "@milagre/shared/agent-runs";

export default function PermissionSheet() {
  const styles = useStyles();
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  const composer = useComposer();
  const session = useSession();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const draft = /#new:/.test(chatId);
  const project = session.snapshot?.project;
  const chatMode = !draft && project?.path === projectOfKey(chatId) ? project.state.sessions[sessionIdFromKey(chatId)]?.permissionMode : undefined;
  const current = useChatPermissionMode(chatId);
  const pick = async (mode: PermissionMode) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      if (!draft) {
        if (!session.client) throw new Error("Reconnect to change this Chat's permissions.");
        await session.client.call("agent:set-permission-mode", [{ chatId, mode }]);
      }
      composer.setPreferences((all) => ({
        ...all,
        [chatId]: { ...(all[chatId] || composer.defaults), permissionMode: mode, permissionPick: { mode, over: chatMode } },
      }));
      composer.setDefaultPermission(mode);
      router.back();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 32 }}>
      <SheetHeader title="Permissions" leading={<CircleButton label="Close" icon={Cancel01Icon} onPress={() => router.back()} />} />
      <View style={{ paddingHorizontal: 16, gap: 12 }}>
        {!!error && (
          <Text accessibilityRole="alert" style={styles.caption}>
            {error}
          </Text>
        )}
        <Group role="radiogroup" accessibilityLabel="Permissions">
          {PERMISSION_MODES.map((mode) => (
            <CheckRow
              key={mode.id}
              title={mode.name}
              leading={<PermissionIcon mode={mode.id} size={20} />}
              checked={mode.id === current}
              onPress={() => void pick(mode.id)}
            />
          ))}
        </Group>
      </View>
    </ScrollView>
  );
}
