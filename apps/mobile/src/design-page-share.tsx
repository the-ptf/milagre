import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Linking, Platform, Share, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { createDesignPageSharing } from "./design-page-sharing";
import type { Client } from "./client";
import type { DesignPageShare } from "@milagre/shared/artifact";
import { CircleButton, PageScroll, PillButton, useStyles } from "./ui";
import { useTheme } from "./theme";

const when = (share: DesignPageShare) =>
  `${share.updatedAt ? "Updated" : "Published"} ${new Date(share.updatedAt ?? share.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
const olderLinksNotice = (count = 0) =>
  count ? `${count === 1 ? "An older link" : `${count} older links`} could not be revoked yet. Revoke in Experimental > Published pages.` : "";

/** A Chat page has one public link, and publishing again updates the snapshot behind it. Without a chatId this lists
 * every page published from the host. The parent keys this view by host and Chat and unmounts it when Designs is off. */
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
  // Until the person edits it, the title field shows the live link's title.
  const [draft, setDraft] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const current = chatId ? state.shares.find((share) => !share.revoked) : undefined;
  const title = draft ?? current?.title ?? (kind === "artifacts" ? "Artifact" : "Designs");
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
    const updating = !!current;
    setNotice("");
    setConfirm(null);
    await sharing.publish(title);
    const result = sharing.getSnapshot();
    const share = result.shares[0];
    if (!result.error && share) setNotice([updating ? "Snapshot updated." : "", olderLinksNotice(share.olderLinks)].filter(Boolean).join(" "));
  };
  const revoke = async (id: string) => {
    setNotice("");
    await sharing.revoke(id);
    const result = sharing.getSnapshot();
    if (!result.error) {
      setConfirm(null);
      setNotice("Link revoked. Copies may remain online.");
    }
  };
  const quiet = { borderWidth: 0, paddingHorizontal: 8 };
  const link = (share: DesignPageShare) => (
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
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <PillButton title="Copy link" secondary onPress={() => void act(() => Clipboard.setStringAsync(share.url), "Link copied.")} />
        <PillButton
          title="Share link"
          secondary
          style={quiet}
          onPress={() =>
            void act(() => Share.share(Platform.OS === "ios" ? { url: share.url, title: share.title } : { message: share.url, title: share.title }))
          }
        />
        <PillButton title="Open link" secondary style={quiet} onPress={() => void act(() => Linking.openURL(share.url))} />
      </View>
    </>
  );
  const revokeControl = (share: DesignPageShare) =>
    confirm === share.id ? (
      <View style={{ gap: 10 }}>
        <Text style={styles.muted}>Remove this page? Copies may remain online.</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <PillButton title="Cancel" secondary disabled={!!state.busy} onPress={() => setConfirm(null)} />
          <PillButton title="Revoke link" disabled={!!state.busy} loading={state.busy === share.id} onPress={() => void revoke(share.id)} />
        </View>
      </View>
    ) : (
      <PillButton title="Revoke link" secondary style={[quiet, { alignSelf: "flex-start" }]} disabled={!!state.busy} onPress={() => setConfirm(share.id)} />
    );
  const savedPage = (share: DesignPageShare) => (
    <View key={share.id} style={{ gap: 10, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.line }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <Text selectable style={{ color: colors.ink, fontSize: 15, fontWeight: "500", flex: 1 }}>
          {share.title}
        </Text>
        <Text style={styles.muted}>
          {share.kind === "artifacts" ? "Artifact" : `${share.designCount} ${share.designCount === 1 ? "design" : "designs"}`}
          {share.revoked ? " · Revoked" : ""}
        </Text>
      </View>
      <Text style={styles.muted}>{when(share)}</Text>
      {share.pending && !share.revoked && <Text style={styles.muted}>Not confirmed. The link may not work yet.</Text>}
      {share.revoked ? (
        <Text style={styles.muted}>Removed. Copies may remain online.</Text>
      ) : (
        <>
          {link(share)}
          {revokeControl(share)}
        </>
      )}
    </View>
  );
  const messages = (
    <>
      {state.error && (
        <View style={{ gap: 10 }}>
          <Text accessibilityRole="alert" selectable style={{ color: colors.red }}>
            {state.error}
          </Text>
          <PillButton title="Refresh" secondary disabled={!!state.busy} onPress={() => void sharing.refresh()} />
        </View>
      )}
      {!!notice && (
        <Text accessibilityLiveRegion="polite" selectable style={{ color: colors.ink2 }}>
          {notice}
        </Text>
      )}
      {state.loading && <Text style={styles.muted}>Loading...</Text>}
    </>
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
          {chatId ? "Share" : "Published pages"}
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
        {chatId ? (
          <>
            {current && (
              <View style={{ gap: 10 }}>
                {link(current)}
                {current.pending && <Text style={styles.muted}>Not confirmed yet. Update to retry.</Text>}
              </View>
            )}
            <View style={{ gap: 6 }}>
              <Text style={{ color: colors.ink2, fontSize: 13 }}>Page title</Text>
              <TextInput
                accessibilityLabel="Page title"
                accessibilityHint={kind === "artifacts" ? "Anyone with the link can view it, hidden HTML included." : "Anyone with the link can view it."}
                value={title}
                onChangeText={setDraft}
                maxLength={120}
                editable={!state.busy}
                selectionColor={colors.accent}
                style={styles.input}
                returnKeyType="done"
              />
              <Text style={styles.muted}>
                {kind === "artifacts" ? "Anyone with the link can view it, hidden HTML included." : "Anyone with the link can view it."}
              </Text>
            </View>
            {state.checking ? (
              <Text style={styles.muted}>Checking the sharing service...</Text>
            ) : !state.availability?.available ? (
              <View style={{ gap: 8 }}>
                <Text style={{ color: colors.ink }}>Publishing is unavailable</Text>
                <Text style={styles.muted}>{state.availability?.reason || "The sharing service is unavailable."}</Text>
                <PillButton title="Retry check" secondary disabled={!!state.busy} onPress={() => void sharing.checkAvailability()} />
              </View>
            ) : null}
            <PillButton
              title={current ? "Update snapshot" : "Publish"}
              disabled={!!state.busy || state.loading || !state.loaded || state.checking || !state.availability?.available || !title.trim()}
              loading={state.busy === "publish"}
              onPress={() => void publish()}
            />
            {current && (
              <View style={{ gap: 6 }}>
                {confirm !== current.id && <Text style={styles.muted}>{when(current)}</Text>}
                {revokeControl(current)}
              </View>
            )}
            {messages}
          </>
        ) : (
          <>
            <Text style={styles.muted}>Anyone with a link can view its page.</Text>
            {messages}
            {!state.loading && !state.shares.length && !state.error && <Text style={styles.muted}>No pages published yet.</Text>}
            {!!state.shares.length && <View>{state.shares.map(savedPage)}</View>}
          </>
        )}
      </PageScroll>
    </View>
  );
}
