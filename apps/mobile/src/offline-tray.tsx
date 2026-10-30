import { useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, View, type StyleProp, type TextStyle } from "react-native";
import { AlertCircleIcon, Attachment01Icon, Cancel01Icon, Clock01Icon, Image01Icon, LaptopIcon } from "@hugeicons/core-free-icons";
import { canCancelOutbox, type OutboxItem } from "@milagre/shared/outbox";
import { outbox, useOutbox } from "./outbox";
import { useTheme } from "./theme";
import { Icon } from "./icons";
import { IconButton } from "./primitives/icon-button";
import { tap } from "./primitives/tap";
import { radius, type } from "./design-tokens";

// The same rounding as a new Chat's tray in app/chat.tsx, so the two trays match.
const startTrayRadius = 28;

export type OfflineTrayTarget = { computerId: string; owner: string; sessionId: number | null; computerName: string; offline: boolean };

/** The Chat a message lives in: the one it was written in, or the one its New Chat became; null until that Chat exists. */
const outboxChat = (item: OutboxItem) => item.sessionId ?? item.request.sessionId ?? null;
const ofChat = (item: OutboxItem, target: OfflineTrayTarget) =>
  item.computerId === target.computerId && item.owner === target.owner && outboxChat(item) === target.sessionId;

function useTray(target: OfflineTrayTarget) {
  const snapshot = useOutbox();
  const items = snapshot.items.filter((item) => ofChat(item, target) && item.status !== "sent");
  return { snapshot, items, shown: target.offline || items.length > 0 || Boolean(snapshot.error) };
}

/**
 * The composer's tray while its computer can't take messages (design offline-inline-phone v9), like a new Chat's: the
 * messages waiting on this device for this Chat, then the computer's chip, then the composer. With `start`, the new
 * Chat's own tray, whose header already names the computer.
 */
export function ComposerTray({ start, target, children }: { start: boolean; target: OfflineTrayTarget; children: ReactNode }) {
  const { colors } = useTheme();
  const { shown } = useTray(target);
  if (!start && !shown) return <View>{children}</View>;
  return (
    <View
      style={{
        backgroundColor: colors.inset,
        borderWidth: 1,
        borderColor: start ? colors.line : colors.lineStrong,
        borderRadius: startTrayRadius,
        borderCurve: "continuous",
        padding: 5,
        paddingTop: 3,
        gap: 2,
        boxShadow: "0 4px 20px #0000000f",
      }}
    >
      {children}
    </View>
  );
}

/** The rows of the tray, oldest first; inside ComposerTray, just above the composer. */
export function OfflineTray({ target, chip }: { target: OfflineTrayTarget; chip: boolean }) {
  const { colors } = useTheme();
  const { snapshot, items } = useTray(target);
  const [error, setError] = useState("");
  const act = (work: Promise<unknown>) => {
    setError("");
    void work.catch((failure: Error) => setError(failure.message));
  };
  // A message the computer saved is in the transcript now: its copy here goes.
  const delivered = snapshot.items.filter((item) => ofChat(item, target) && item.status === "sent").map((item) => item.id);
  useEffect(() => {
    for (const id of delivered) void outbox.remove(id).catch(() => {});
  }, [delivered.join()]);
  const message = snapshot.error || error;
  return (
    <View accessibilityLabel={`Waiting for ${target.computerName}`}>
      {!!message && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingTop: 6 }}>
          <Text accessibilityRole="alert" style={{ flex: 1, color: colors.orangeInk, fontSize: 13 }}>
            {message}
          </Text>
          {!!snapshot.error && snapshot.loaded && <TextAction label="Retry saving" onPress={() => act(outbox.retryStorage())} />}
        </View>
      )}
      {items.map((item) => (
        <Row key={item.id} item={item} onAct={act} />
      ))}
      {target.offline && chip && (
        <View style={{ flexDirection: "row", paddingHorizontal: 4, paddingTop: 4, paddingBottom: 6 }}>
          <View
            accessible
            accessibilityLabel={`${target.computerName} is offline`}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              height: 28,
              maxWidth: "100%",
              paddingHorizontal: 10,
              borderRadius: radius.chip,
              borderCurve: "continuous",
              backgroundColor: colors.field,
            }}
          >
            <Icon icon={LaptopIcon} tone="ink2" size={14} />
            <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.ink, fontSize: type.subheadline, fontWeight: "500" }}>
              {target.computerName}
            </Text>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.ink4 }} />
            <Text style={{ color: colors.ink3, fontSize: type.subheadline }}>offline</Text>
          </View>
        </View>
      )}
    </View>
  );
}

function Row({ item, onAct }: { item: OutboxItem; onAct: (work: Promise<unknown>) => void }) {
  const { colors } = useTheme();
  const failed = item.status === "failed";
  const images = item.attachments.filter((file) => file.imageId);
  const files = item.attachments.filter((file) => !file.imageId);
  const attachment = images.length
    ? `${images.length} image${images.length === 1 ? "" : "s"}${files.length ? ` + ${files.length} file${files.length === 1 ? "" : "s"}` : ""}`
    : files.length
      ? files.length === 1
        ? files[0]!.name
        : `${files.length} files`
      : "";
  // Waiting needs no word: the clock says it. Only sending and failures do.
  const status = failed ? item.error : item.status === "sending" ? "Sending…" : "";
  // A send that may have reached the computer is checked before it goes again; a Worktree that may exist can't be redone.
  const retry = failed && item.phase !== "creating" ? (item.phase === "dispatching" ? "Check delivery" : "Retry") : null;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingLeft: 10, paddingTop: 8, paddingBottom: 6 }}>
      <View style={{ height: 20, justifyContent: "center" }}>
        <Icon icon={failed ? AlertCircleIcon : Clock01Icon} tone="orangeInk" size={15} strokeWidth={2} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={2} style={{ color: colors.ink, fontSize: 15, lineHeight: 20 }}>
          {item.request.body.trim() || "Attachments"}
        </Text>
        {!!(attachment || status) && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            {!!attachment && <Icon icon={images.length ? Image01Icon : Attachment01Icon} tone="ink3" size={13} />}
            <Text numberOfLines={2} style={{ flexShrink: 1, color: failed ? colors.orangeInk : colors.ink3, fontSize: 13 }}>
              {[attachment, status].filter(Boolean).join(" · ")}
            </Text>
          </View>
        )}
        {retry && (
          <View style={{ flexDirection: "row", paddingTop: 2 }}>
            <TextAction label={retry} onPress={() => onAct(outbox.retry(item.id))} />
          </View>
        )}
      </View>
      {canCancelOutbox(item) ? (
        <View style={{ height: 20, justifyContent: "center" }}>
          <IconButton label="Cancel message" icon={Cancel01Icon} tone="ink3" size={36} onPress={() => onAct(outbox.remove(item.id))} />
        </View>
      ) : (
        <View style={{ width: 36 }} />
      )}
    </View>
  );
}

function TextAction({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({
        minHeight: 32,
        justifyContent: "center",
        paddingHorizontal: 12,
        borderRadius: radius.full,
        backgroundColor: colors.field,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text style={{ color: colors.ink, fontSize: type.subheadline, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

/** "2 waiting" on a Chat's row in the list: messages on this device its computer hasn't taken yet. */
export function WaitingLabel({ computerId, owner, sessionId, style }: { computerId: string; owner: string; sessionId: number; style: StyleProp<TextStyle> }) {
  const { colors } = useTheme();
  const count = useOutbox().items.filter(
    (item) => item.computerId === computerId && item.owner === owner && outboxChat(item) === sessionId && item.status !== "sent",
  ).length;
  if (!count) return null;
  return (
    <Text numberOfLines={1} style={[style, { flexShrink: 0, color: colors.orangeInk }]}>
      {count} waiting
    </Text>
  );
}
