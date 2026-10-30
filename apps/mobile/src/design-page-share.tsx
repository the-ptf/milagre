import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Linking, Platform, Share, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { createDesignPageSharing } from "./design-page-sharing";
import type { Client } from "./client";
import type { DesignPageShare } from "@milagre/shared/artifact";
import { lineHeight, radius, space, type } from "./design-tokens";
import { CircleButton, EmptyState, ErrorNotice, PageScroll, PillButton, SheetHeader, Toast, useStyles } from "./ui";
import { useTheme } from "./theme";

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
  const link = (share: DesignPageShare) => (
    <>
      <Text
        selectable
        accessibilityLabel="Snapshot link"
        style={{
          color: colors.ink2,
          fontSize: type.footnote,
          lineHeight: lineHeight.footnote,
          padding: space.lg,
          borderRadius: radius.control,
          borderCurve: "continuous",
          backgroundColor: colors.field,
        }}
      >
        {share.url}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
        <PillButton title="Copy link" secondary onPress={() => void act(() => Clipboard.setStringAsync(share.url), "Link copied.")} />
        <PillButton
          title="Share link"
          variant="plain"
          onPress={() =>
            void act(() => Share.share(Platform.OS === "ios" ? { url: share.url, title: share.title } : { message: share.url, title: share.title }))
          }
        />
        <PillButton title="Open link" variant="plain" onPress={() => void act(() => Linking.openURL(share.url))} />
      </View>
    </>
  );
  const revokeControl = (share: DesignPageShare) =>
    confirm === share.id ? (
      <View style={{ gap: space.lg }}>
        <Text style={styles.muted}>Remove this page? Copies may remain online.</Text>
        <View style={{ flexDirection: "row", gap: space.md }}>
          <PillButton title="Cancel" variant="plain" muted disabled={!!state.busy} onPress={() => setConfirm(null)} />
          <PillButton title="Revoke link" destructive disabled={!!state.busy} loading={state.busy === share.id} onPress={() => void revoke(share.id)} />
        </View>
      </View>
    ) : (
      <PillButton
        title="Revoke link"
        variant="plain"
        destructive
        style={{ alignSelf: "flex-start" }}
        disabled={!!state.busy}
        onPress={() => setConfirm(share.id)}
      />
    );
  const savedPage = (share: DesignPageShare) => (
    <View key={share.id} style={{ gap: space.lg, paddingVertical: space.xl, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.lg }}>
        <Text selectable style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "500", flex: 1 }}>
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
      {state.error && <ErrorNotice message={state.error} retry={() => void sharing.refresh()} retryTitle="Refresh" disabled={!!state.busy} />}
      {state.loading && <Text style={styles.muted}>Loading…</Text>}
    </>
  );
  return (
    <View style={{ flex: 1 }}>
      <SheetHeader
        title={chatId ? "Share" : "Published pages"}
        leading={
          inSheet ? undefined : (
            <CircleButton
              label={chatId ? (kind === "artifacts" ? "Back to artifact" : "Back to designs") : "Back to Milagre"}
              icon={ArrowLeft01Icon}
              disabled={!!state.busy}
              onPress={onClose}
            />
          )
        }
      />
      <PageScroll
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: space.gutter,
          paddingBottom: space.xxl,
          gap: space.xl,
        }}
      >
        {chatId ? (
          <>
            {current && (
              <View style={{ gap: space.lg }}>
                {link(current)}
                {current.pending && <Text style={styles.muted}>Not confirmed yet. Update to retry.</Text>}
              </View>
            )}
            <Text style={styles.muted}>
              {kind === "artifacts" ? "Anyone with the link can view it, hidden HTML included." : "Anyone with the link can view it."}
            </Text>
            {state.checking ? (
              <Text style={styles.muted}>Checking the sharing service…</Text>
            ) : !state.availability?.available ? (
              <View style={{ gap: space.md }}>
                <Text style={{ color: colors.ink, fontSize: type.body, lineHeight: lineHeight.body }}>Publishing is unavailable</Text>
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
              <View style={{ gap: space.sm }}>
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
            {!state.loading && !state.shares.length && !state.error && <EmptyState title="No pages published yet" />}
            {!!state.shares.length && <View>{state.shares.map(savedPage)}</View>}
          </>
        )}
      </PageScroll>
      {toast && <Toast key={toast.key} text={toast.text} />}
    </View>
  );
}
