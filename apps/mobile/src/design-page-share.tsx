import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Linking, Platform, Share, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { createDesignPageSharing } from "./design-page-sharing";
import type { Client } from "./client";
import type { DesignPageShare } from "@milagre/shared/artifact";
import { CircleButton, PageScroll, PillButton, useStyles } from "./ui";
import { useTheme } from "./theme";
import { ToastPill } from "./primitives/toast";

const when = (share: DesignPageShare) =>
  `${share.updatedAt ? "Updated" : "Published"} ${new Date(share.updatedAt ?? share.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
const olderLinksNotice = (count = 0) =>
  count ? `${count === 1 ? "An older link" : `${count} older links`} could not be revoked yet. Revoke in Settings > Milagre > Published pages.` : "";

/** A Chat page has one public link, and publishing again updates the snapshot behind it. Without a chatId this lists
 * every page published from the host. The parent keys this view by host and Chat and unmounts it when Designs is off. */
export function DesignPageShareSheet({
  client,
  chatId,
  kind = "designs",
  onClose,
  onBusyChange,
  onAvailabilityChange,
  inSheet = false,
}: {
  client: Client;
  chatId?: string | null;
  kind?: "designs" | "artifacts";
  onClose: () => void;
  /** Shown in a bottom sheet over the page, which has its own grabber to close: no Back button. */
  inSheet?: boolean;
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
  const [confirm, setConfirm] = useState<string | null>(null);
  // What an action did shows as a toast over the sheet, not as text in it.
  const [toast, setToast] = useState<{ text: string; key: number } | null>(null);
  const toastKey = useRef(0);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }, [toast]);
  const showToast = (text: string) => text && setToast({ text, key: ++toastKey.current });
  const current = chatId ? state.shares.find((share) => !share.revoked) : undefined;
  // The host names the page after its Chat; this only satisfies an older host, which requires a title.
  const title = current?.title ?? (kind === "artifacts" ? "Artifact" : "Designs");
  useEffect(() => {
    void sharing.refresh();
    void sharing.checkAvailability();
    return () => sharing.dispose();
  }, [sharing]);
  const act = async (action: () => Promise<unknown>, success = "") => {
    try {
      await action();
      showToast(success);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not open this link.");
    }
  };
  const publish = async () => {
    const updating = !!current;
    setConfirm(null);
    await sharing.publish(title);
    const result = sharing.getSnapshot();
    const share = result.shares[0];
    if (result.error || !share) return;
    // Publishing copies the link right away: sharing it is what comes next.
    const copied = await Clipboard.setStringAsync(share.url).then(
      () => true,
      () => false,
    );
    showToast([updating ? "Snapshot updated." : "Published.", copied ? "Link copied." : "", olderLinksNotice(share.olderLinks)].filter(Boolean).join(" "));
  };
  const revoke = async (id: string) => {
    await sharing.revoke(id);
    const result = sharing.getSnapshot();
    if (!result.error) {
      setConfirm(null);
      showToast("Link revoked. Copies may remain online.");
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
          <Text accessibilityRole="alert" selectable style={{ color: colors.redInk }}>
            {state.error}
          </Text>
          <PillButton title="Refresh" secondary disabled={!!state.busy} onPress={() => void sharing.refresh()} />
        </View>
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
        {!inSheet && (
          <CircleButton
            label={chatId ? (kind === "artifacts" ? "Back to artifact" : "Back to designs") : "Back to Milagre"}
            icon={ArrowLeft01Icon}
            onPress={state.busy ? undefined : onClose}
          />
        )}
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
            <Text style={styles.muted}>
              {kind === "artifacts" ? "Anyone with the link can view it, hidden HTML included." : "Anyone with the link can view it."}
            </Text>
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
              disabled={!!state.busy || state.loading || !state.loaded || state.checking || !state.availability?.available}
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
      {toast && (
        <View key={toast.key} pointerEvents="none" style={{ position: "absolute", left: 16, right: 16, bottom: 24, alignItems: "center" }}>
          <ToastPill text={toast.text} />
        </View>
      )}
    </View>
  );
}
