import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Copy01Icon, GitForkIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import * as Clipboard from "expo-clipboard";
import type { ChatMessage } from "@milagre/shared/model";
import type { AgentRun } from "@milagre/shared/agent-runs";
import { space } from "./design-tokens";
import { IconButton, PillButton } from "./ui";

export function MessageToolbar({
  text,
  message,
  run,
  onFork,
  onDone,
  align = "start",
}: {
  text?: string;
  message?: ChatMessage;
  run?: AgentRun;
  onFork?: (messageId: number) => void;
  onDone?: () => void;
  align?: "start" | "end";
}) {
  const forkThis = !run && message && message.id > 0 && onFork ? () => onFork(message.id) : undefined;
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  if (run || (!text?.trim() && !forkThis && !onDone)) return null;
  async function copy() {
    await Clipboard.setStringAsync(text ?? "");
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, alignSelf: align === "end" ? "flex-end" : "flex-start" }}>
      {!!text?.trim() && (
        <IconButton
          label={copied ? "Copied message" : "Copy message"}
          icon={copied ? Tick02Icon : Copy01Icon}
          tone={copied ? "green" : "ink3"}
          size={44}
          onPress={() => void copy()}
        />
      )}
      {forkThis && <IconButton label="Fork Chat from here" icon={GitForkIcon} tone="ink3" size={44} onPress={forkThis} />}
      {onDone && <PillButton title="Done" icon={Tick02Icon} variant="plain" size="small" muted accessibilityLabel="Mark Done" onPress={onDone} />}
    </View>
  );
}
