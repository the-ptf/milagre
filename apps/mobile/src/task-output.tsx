import { useCallback, useEffect, useState } from "react";
import { AppState, Text, View } from "react-native";
import { useIsFocused } from "expo-router";
import { plainTaskOutput } from "@milagre/shared/chat-activity";
import { useTaskOutput } from "@milagre/shared/use-task-output";
import type { BackgroundTaskOutput } from "@milagre/shared/model";
import { useSession } from "./session";
import { fonts, useTheme } from "./theme";
import { ErrorNotice } from "./ui";

export function TaskOutput({ chatKey, taskId, running }: { chatKey: string; taskId: string; running: boolean }) {
  const { colors, codeSize } = useTheme();
  const { client } = useSession();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    return () => listener.remove();
  }, []);
  const read = useCallback(async () => {
    if (!client) throw new Error("Connect to the computer to read this command's output.");
    return (await client.call("chat:task-output", [chatKey, taskId])) as BackgroundTaskOutput;
  }, [client, chatKey, taskId]);
  const { output, error } = useTaskOutput(read, focused && foreground, running);
  return (
    <View style={{ gap: 8, padding: 12, borderRadius: 12, backgroundColor: colors.field }}>
      {!!error && <ErrorNotice message={error} />}
      {output?.truncated && <Text style={{ color: colors.ink3, fontSize: 12 }}>Showing the latest output.</Text>}
      <Text selectable style={{ color: colors.ink2, fontSize: codeSize, lineHeight: Math.round(codeSize * 1.5), fontFamily: fonts.mono }}>
        {output ? plainTaskOutput(output.output) || "No output yet." : error ? "" : "Loading output..."}
      </Text>
    </View>
  );
}
