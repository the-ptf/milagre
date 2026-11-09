import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import type { AgentSession } from "@milagre/shared/model";
import type { Client } from "./client";

/**
 * The phone reads the Chat on screen, as desktop does (runtime.cjs readOpenChat): opening it clears its Unread mark, and
 * so does a reply that lands while it shows. On screen means its screen has focus, the app is in the foreground and no
 * side panel covers it, so "Mark as unread" from the sidebar sticks until the Chat is opened again.
 */
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
