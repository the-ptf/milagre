import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { canCancelOutbox, outboxStatus } from "@milagre/shared/outbox";
import { outbox, useOutbox } from "./outbox";
import { useTheme } from "./theme";
import { PageScroll } from "./primitives/page-scroll";
import { radius, type } from "./design-tokens";

export function OutboxMessages({
  computerId,
  owner,
  sessionId,
  worktreeId,
  onOpen,
}: {
  computerId?: string;
  owner?: string;
  sessionId?: number;
  worktreeId?: number;
  onOpen?: (id: number) => void;
}) {
  const snapshot = useOutbox();
  const { colors } = useTheme();
  const [error, setError] = useState("");
  const items = snapshot.items.filter((item) => (!computerId || item.computerId === computerId) && (!owner || item.owner === owner));
  const act = (work: Promise<unknown>) => {
    setError("");
    void work.catch((error: Error) => setError(error.message));
  };
  if (!items.length && !snapshot.error && !error) return null;
  const button = (label: string, onPress: () => void) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 6 }}
    >
      <Text style={{ color: colors.ink, fontSize: type.footnote, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
  return (
    <View
      accessibilityLabel="Messages on this device"
      style={{ borderRadius: radius.card, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, padding: 12 }}
    >
      <Text style={{ color: colors.orangeInk, fontSize: type.footnote, fontWeight: "600" }}>Messages on this device</Text>
      <Text style={{ color: colors.ink3, fontSize: type.caption1 }}>Delivery resumes while Milagre is open. Sent means the computer saved the message.</Text>
      {!!(snapshot.error || error) && (
        <Text accessibilityRole="alert" style={{ color: colors.orangeInk }}>
          {snapshot.error || error}
        </Text>
      )}
      {snapshot.error && snapshot.loaded && button("Retry saving", () => act(outbox.retryStorage()))}
      <PageScroll
        style={{ maxHeight: 180, flexGrow: 0 }}
        contentContainerStyle={{ padding: 0, paddingBottom: 0 }}
        contentInsetAdjustmentBehavior="never"
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
      >
        {items.map((item) => (
          <View key={item.id} style={{ borderTopWidth: 1, borderColor: colors.line, paddingTop: 8 }}>
            <Text style={{ color: colors.ink2, fontSize: type.caption1 }}>
              {item.computerName} · {(item.sessionId ?? item.request.sessionId) ? `Chat #${item.sessionId ?? item.request.sessionId}` : "New Chat"} ·{" "}
              {outboxStatus(item)}
            </Text>
            <Text numberOfLines={2} style={{ color: colors.ink, fontSize: type.subheadline }}>
              {item.request.body || "Attachments"}
            </Text>
            {!!item.attachments.length && (
              <Text style={{ color: colors.ink3, fontSize: type.caption1 }}>{item.attachments.map((file) => file.name).join(", ")}</Text>
            )}
            {!!item.error && <Text style={{ color: colors.orangeInk, fontSize: type.footnote }}>{item.error}</Text>}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {item.status !== "sending" &&
                item.status !== "sent" &&
                item.phase !== "creating" &&
                button(item.phase === "dispatching" ? "Check delivery" : "Retry", () => act(outbox.retry(item.id)))}
              {item.status === "failed" &&
                canCancelOutbox(item) &&
                sessionId != null &&
                worktreeId != null &&
                button("Recover to this Chat", () => act(outbox.recover(item.id, { sessionId, worktreeId })))}
              {onOpen && item.status === "sent" && item.sessionId != null && button("Open Chat", () => onOpen(item.sessionId!))}
              {canCancelOutbox(item) && button(item.status === "sent" ? "Dismiss" : "Cancel message", () => act(outbox.remove(item.id)))}
            </View>
          </View>
        ))}
      </PageScroll>
    </View>
  );
}
