import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Linking, Platform, Share, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { createDesignPageSharing } from "./design-page-sharing";
import type { Client } from "./client";
import type { DesignPageShare } from "@milagre/shared/artifact";
import { CircleButton, PageScroll, PillButton, useStyles } from "./ui";
import { useTheme } from "./theme";

/** The parent keys this view by host and Chat and unmounts it when Designs is off. */
export function DesignPageShareSheet({
  client,
  chatId,
  kind = "designs",
  onClose,
  onBusyChange,
  onAvailabilityChange,
}: {
  client: Client;
  chatId?: string | null;
  kind?: "designs" | "artifacts";
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
  onAvailabilityChange?: (available: boolean | null) => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const sharing = useMemo(() => createDesignPageSharing(client, chatId, kind), [client, chatId, kind]);
  const state = useSyncExternalStore(sharing.subscribe, sharing.getSnapshot);
  useEffect(() => {
    onAvailabilityChange?.(state.checking ? null : (state.availability?.available ?? null));
  }, [state.checking, state.availability?.available, onAvailabilityChange]);
  useEffect(() => onBusyChange?.(!!state.busy), [state.busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  const [title, setTitle] = useState(kind === "artifacts" ? "Artifact" : "Designs");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [publishedId, setPublishedId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const featured = chatId ? state.shares.find((share) => share.id === publishedId) : undefined;
  const history = state.shares.filter((share) => share.id !== publishedId);
  const showHistory = !chatId || historyOpen || !!state.error || history.some((share) => share.pending && !share.revoked);
  useEffect(() => {
    void sharing.refresh();
    void sharing.checkAvailability();
    return () => sharing.dispose();
  }, [sharing]);
  const act = async (action: () => Promise<unknown>, success = "") => {
    setNotice("");
    try {
      await action();
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not open this link.");
    }
  };
  const publish = async () => {
    setNotice("");
    await sharing.publish(title);
    const result = sharing.getSnapshot();
    const share = result.shares[0];
    if (!result.error && share && !share.pending && !share.revoked) {
      setPublishedId(share.id);
      setHistoryOpen(false);
    } else setHistoryOpen(true);
  };
  const details = (share: DesignPageShare, prominent = false) => (
    <View
      key={share.id}
      style={{
        gap: 10,
        paddingVertical: prominent ? 0 : 14,
        borderBottomWidth: prominent ? 0 : 1,
        borderBottomColor: colors.line,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text
          selectable
          style={{
            color: colors.ink,
            fontSize: 15,
            fontWeight: "500",
            flex: 1,
          }}
        >
          {share.title}
        </Text>
        <Text style={styles.muted}>
          {share.kind === "artifacts" ? "Artifact" : `${share.designCount} ${share.designCount === 1 ? "design" : "designs"}`}
          {share.revoked ? " · Revoked" : ""}
        </Text>
      </View>
      {!prominent && <Text style={styles.muted}>{new Date(share.createdAt).toLocaleString()}</Text>}
      {share.pending && !share.revoked && <Text style={styles.muted}>Publication not confirmed. Check this link before publishing again.</Text>}
      {share.revoked ? (
        <Text style={styles.muted}>Hosted page removed. Copies may remain online.</Text>
      ) : (
        <>
          <Text
            selectable
            accessibilityLabel="Snapshot link"
            style={{
              color: colors.ink2,
              fontSize: 13,
              lineHeight: 20,
              padding: 12,
              borderRadius: 10,
              backgroundColor: colors.field,
            }}
          >
            {share.url}
          </Text>
          <PillButton title="Copy link" secondary={!prominent} onPress={() => void act(() => Clipboard.setStringAsync(share.url), "Link copied.")} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <PillButton
              title="Share link"
              secondary
              style={{ borderWidth: 0, paddingHorizontal: 8 }}
              onPress={() =>
                void act(() => Share.share(Platform.OS === "ios" ? { url: share.url, title: share.title } : { message: share.url, title: share.title }))
              }
            />
            <PillButton
              title="Open link"
              secondary
              style={{ borderWidth: 0, paddingHorizontal: 8 }}
              onPress={() => void act(() => Linking.openURL(share.url))}
            />
            {confirm !== share.id && (
              <PillButton
                title="Revoke link"
                secondary
                style={{ borderWidth: 0, paddingHorizontal: 8 }}
                disabled={!!state.busy}
                onPress={() => setConfirm(share.id)}
              />
            )}
          </View>
          {confirm === share.id && (
            <View style={{ gap: 10 }}>
              <Text style={styles.muted}>Remove this hosted page? Copies may remain online.</Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <PillButton title="Cancel" secondary disabled={!!state.busy} onPress={() => setConfirm(null)} />
                <PillButton title="Revoke link" disabled={!!state.busy} loading={state.busy === share.id} onPress={() => void sharing.revoke(share.id)} />
              </View>
            </View>
          )}
        </>
      )}
    </View>
  );
  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          padding: 16,
        }}
      >
        <CircleButton
          label={chatId ? (kind === "artifacts" ? "Back to artifact" : "Back to designs") : "Back to Experimental"}
          icon={ArrowLeft01Icon}
          onPress={state.busy ? undefined : onClose}
        />
        <Text
          accessibilityRole="header"
          style={{
            color: colors.ink,
            fontSize: 19,
            fontWeight: "600",
            flex: 1,
          }}
        >
          {!chatId ? "Published pages" : featured ? (featured.revoked ? "Snapshot removed" : "Snapshot shared") : "Share a snapshot"}
        </Text>
      </View>
      <PageScroll
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: 24,
          gap: 16,
        }}
      >
        {chatId && (
          <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 21 }}>
            {featured
              ? "This snapshot stays frozen. Later edits stay private."
              : kind === "artifacts"
                ? "A frozen copy of this artifact. Later edits stay private."
                : "A frozen copy of every saved design on this page. Later edits stay private."}
          </Text>
        )}
        {featured && details(featured, true)}
        <View style={{ gap: 5 }}>
          <Text style={{ color: colors.ink, fontSize: 13, fontWeight: "600" }}>Public access</Text>
          <Text style={styles.muted}>Anyone with the link can view, copy or redistribute it. Copies may remain online permanently.</Text>
          {chatId && (
            <Text style={styles.muted}>
              {kind === "artifacts"
                ? "Comments and Chat messages stay private. The full saved HTML, including hidden content, is shared. External resources are blocked."
                : "Unsaved edits, comments and Chat messages stay private. Shared files can include content clipped by frames."}
            </Text>
          )}
        </View>
        {chatId && !featured && (
          <>
            <View style={{ gap: 6 }}>
              <Text style={{ color: colors.ink2, fontSize: 13 }}>Page title</Text>
              <TextInput
                accessibilityLabel="Page title"
                value={title}
                onChangeText={setTitle}
                maxLength={120}
                editable={!state.busy}
                selectionColor={colors.accent}
                style={styles.input}
                returnKeyType="done"
              />
            </View>
            {state.checking ? (
              <Text style={styles.muted}>Checking publishing availability...</Text>
            ) : !state.availability?.available ? (
              <View style={{ gap: 8 }}>
                <Text style={{ color: colors.ink }}>Publishing is unavailable</Text>
                <Text style={styles.muted}>{state.availability?.reason || "The sharing service is unavailable."}</Text>
                <PillButton title="Retry check" secondary disabled={!!state.busy} onPress={() => void sharing.checkAvailability()} />
              </View>
            ) : null}
            <PillButton
              title="Publish snapshot"
              disabled={!!state.busy || state.loading || !state.loaded || state.checking || !state.availability?.available || !title.trim()}
              loading={state.busy === "publish"}
              onPress={() => void publish()}
            />
          </>
        )}
        {featured && (
          <PillButton
            title="Publish another snapshot"
            secondary
            disabled={!!state.busy}
            onPress={() => {
              setPublishedId(null);
              setNotice("");
            }}
          />
        )}
        {state.error && (
          <View style={{ gap: 10 }}>
            <Text accessibilityRole="alert" selectable style={{ color: colors.red }}>
              {state.error}
            </Text>
            <PillButton title="Refresh links" secondary disabled={!!state.busy} onPress={() => void sharing.refresh()} />
          </View>
        )}
        {!!notice && (
          <Text accessibilityLiveRegion="polite" selectable style={{ color: colors.ink2 }}>
            {notice}
          </Text>
        )}
        {state.loading ? (
          <Text style={styles.muted}>Loading links...</Text>
        ) : !chatId && !history.length ? (
          <Text style={styles.muted}>No snapshots published yet.</Text>
        ) : null}
        {!!history.length && (
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: colors.line,
              paddingTop: 12,
            }}
          >
            {chatId && !state.error && !history.some((share) => share.pending && !share.revoked) ? (
              <PillButton
                title={`${showHistory ? "Hide" : "Show"} published snapshots (${history.length})`}
                secondary
                style={{ borderWidth: 0 }}
                onPress={() => setHistoryOpen((open) => !open)}
              />
            ) : (
              <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 15, fontWeight: "600" }}>
                Published snapshots
              </Text>
            )}
            {showHistory && history.map((share) => details(share))}
          </View>
        )}
      </PageScroll>
    </View>
  );
}
