import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import type { AgentSession } from "@milagre/shared/model";
import type { Client } from "./client";

export function useReadOpenChat(client: Client | null, projectPath: string | undefined, chat: AgentSession | undefined, covered: boolean) {
  const [focused, setFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const watch = AppState.addEventListener("change", (status) => setActive(status === "active"));
    return () => watch.remove();
  }, []);
  const unread = !!chat?.unread;
  const id = chat?.id;
  useEffect(() => {
    if (focused && active && !covered && unread && client && projectPath && id !== undefined)
      void client.call("chat:patch", [projectPath, id, { unread: false }]).catch(() => {});
  }, [focused, active, covered, unread, client, projectPath, id]);
}
