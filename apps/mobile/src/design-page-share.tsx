import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Linking, Platform, Share, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { createDesignPageSharing, type ShareScope } from "./design-page-sharing";
import type { Client } from "./client";
import type { DesignPageShare } from "@milagre/shared/artifact";
import { lineHeight, radius, space, type } from "./design-tokens";
import { CircleButton, EmptyState, ErrorNotice, PageScroll, PillButton, SheetHeader, useStyles } from "./ui";
import { inkFor, useTheme } from "./theme";
import { ToastPill } from "./primitives/toast";
import { sharePublicNotice, shareScopeLabel, shareSheetTitle, shareStateLabel, shareStatusLine } from "./page-share-status";

const TICK_MS = 30_000;
const when = (share: DesignPageShare) =>
  `${share.updatedAt ? "Updated" : "Published"} ${new Date(share.updatedAt ?? share.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
const olderLinksNotice = (count = 0) =>
  count ? `${count === 1 ? "An older link" : `${count} older links`} could not be revoked yet. Revoke in Settings > Milagre > Published pages.` : "";
const FALLBACK_TITLE = { workspace: "Artifact", design: "Design", selection: "Designs", designs: "Designs", artifacts: "Artifact" } as const;
const WORKSPACE: ShareScope = { kind: "workspace" };

function ShareLink({ share, act }: { share: DesignPageShare; act: (action: () => Promise<unknown>, success?: string) => void }) {
  const { colors } = useTheme();
  return (
    <>
      <Text
        selectable
        accessibilityLabel="Page link"
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
        <PillButton title="Copy link" secondary onPress={() => act(() => Clipboard.setStringAsync(share.url), "Link copied.")} />
        <PillButton
          title="Share link"
          variant="plain"
          onPress={() => act(() => Share.share(Platform.OS === "ios" ? { url: share.url, title: share.title } : { message: share.url, title: share.title }))}
        />
        <PillButton title="Open link" variant="plain" onPress={() => act(() => Linking.openURL(share.url))} />
      </View>
    </>
  );
}

/** A scope of a Chat's Artifact to share (`chatId`), or every page this computer published (no `chatId`). */
export function DesignPageShareSheet({
  client,
  chatId,
  scope = WORKSPACE,
  onClose,
  onBusyChange,
  onAvailabilityChange,
  inSheet = false,
}: {
  client: Client;
  chatId?: string | null;
  scope?: ShareScope;
  onClose: () => void;
  inSheet?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onAvailabilityChange?: (available: boolean | null) => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const { kind, designId } = scope;
  const selected = scope.designIds?.join(",") ?? "";
  const sharing = useMemo(
    () => createDesignPageSharing(client, chatId, { kind, ...(designId ? { designId } : {}), ...(selected ? { designIds: selected.split(",") } : {}) }),
    [client, chatId, kind, designId, selected],
  );
  const count = scope.designIds?.length ?? 0;
  const state = useSyncExternalStore(sharing.subscribe, sharing.getSnapshot);
  useEffect(() => {
    onAvailabilityChange?.(state.checking ? null : (state.availability?.available ?? null));
  }, [state.checking, state.availability?.available, onAvailabilityChange]);
  useEffect(() => onBusyChange?.(!!state.busy), [state.busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; key: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const toastKey = useRef(0);
  const showToast = (text: string) => text && setToast({ text, key: ++toastKey.current });
  const current = chatId ? state.shares.find((share) => !share.revoked) : undefined;
  const title = current?.title ?? FALLBACK_TITLE[kind];
  const following = !!current?.live && !current.paused;
  useEffect(() => {
    void sharing.refresh();
    void sharing.checkAvailability();
    return () => sharing.dispose();
  }, [sharing]);
  useEffect(() => {
    if (!following) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void sharing.refresh({ quiet: true });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [following, sharing]);
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
    if (updating) {
      showToast(["Updated.", olderLinksNotice(share.olderLinks)].filter(Boolean).join(" "));
      return;
    }
    const copied = await Clipboard.setStringAsync(share.url).then(
      () => true,
      () => false,
    );
    showToast(["Shared.", copied ? "Link copied." : "", olderLinksNotice(share.olderLinks)].filter(Boolean).join(" "));
  };
  const pause = async (share: DesignPageShare, paused: boolean) => {
    await sharing.setPaused(share.id, paused);
    if (!sharing.getSnapshot().error) showToast(paused ? "Paused. The link keeps its last update." : "Resumed.");
  };
  const revoke = async (id: string) => {
    await sharing.revoke(id);
    const result = sharing.getSnapshot();
    if (!result.error) {
      setConfirm(null);
      showToast("Stopped sharing. Copies may remain online.");
    }
  };
  const unavailable = state.checking || !state.availability?.available;
  const link = (share: DesignPageShare) => <ShareLink share={share} act={(action, success) => void act(action, success)} />;
  const revokeControl = (share: DesignPageShare) =>
    confirm === share.id ? (
      <View style={{ gap: space.lg }}>
        <Text style={styles.muted}>Stop sharing this link? Copies may remain online.</Text>
        <View style={{ flexDirection: "row", gap: space.md }}>
          <PillButton title="Cancel" variant="plain" muted disabled={!!state.busy} onPress={() => setConfirm(null)} />
          <PillButton title="Stop sharing" destructive disabled={!!state.busy} loading={state.busy === share.id} onPress={() => void revoke(share.id)} />
        </View>
      </View>
    ) : (
      <PillButton
        title="Stop sharing"
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
        <Text style={styles.muted}>{`${shareScopeLabel(share.kind)} · ${shareStateLabel(share)}`}</Text>
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
  const availability = state.checking ? (
    <Text style={styles.muted}>Checking the sharing service…</Text>
  ) : !state.availability?.available ? (
    <View style={{ gap: space.md }}>
      <Text style={{ color: colors.ink, fontSize: type.body, lineHeight: lineHeight.body }}>Sharing is unavailable</Text>
      <Text style={styles.muted}>{state.availability?.reason || "The sharing service is unavailable."}</Text>
      <PillButton title="Retry check" secondary disabled={!!state.busy} onPress={() => void sharing.checkAvailability()} />
    </View>
  ) : null;
  const messages = (
    <>
      {state.error && <ErrorNotice message={state.error} retry={() => void sharing.refresh()} retryTitle="Refresh" disabled={!!state.busy} />}
      {state.loading && <Text style={styles.muted}>Loading…</Text>}
    </>
  );
  const shared = (share: DesignPageShare) => (
    <>
      <View style={{ gap: space.lg }}>
        {link(share)}
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: share.live && share.stale ? inkFor(colors, "orange") : colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}
        >
          {shareStatusLine(share, now)}
        </Text>
        {share.pending && <Text style={styles.muted}>Not confirmed yet. Share again to retry.</Text>}
      </View>
      <Text style={styles.muted}>{sharePublicNotice(kind, !share.live, count)}</Text>
      {availability}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
        {share.live && (
          <PillButton
            title={share.paused ? "Resume" : "Pause"}
            secondary
            disabled={!!state.busy}
            loading={state.busy === "pause" || state.busy === "resume"}
            onPress={() => void pause(share, !share.paused)}
          />
        )}
        {(!share.live || share.paused || share.stale || share.pending) && (
          <PillButton
            title={share.live ? "Update now" : "Share again"}
            secondary={share.live}
            disabled={!!state.busy || state.loading || !state.loaded || unavailable}
            loading={state.busy === "publish"}
            onPress={() => void publish()}
          />
        )}
      </View>
      {revokeControl(share)}
    </>
  );
  return (
    <View style={{ flex: 1 }}>
      <SheetHeader
        title={chatId ? shareSheetTitle(kind) : "Published pages"}
        leading={inSheet ? undefined : <CircleButton label="Back" icon={ArrowLeft01Icon} disabled={!!state.busy} onPress={onClose} />}
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
            {current ? (
              shared(current)
            ) : (
              <>
                <Text style={styles.muted}>{sharePublicNotice(kind, false, count)}</Text>
                {availability}
                <PillButton
                  title="Share"
                  disabled={!!state.busy || state.loading || !state.loaded || unavailable}
                  loading={state.busy === "publish"}
                  onPress={() => void publish()}
                />
              </>
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
      {toast && (
        <View key={toast.key} pointerEvents="none" style={{ position: "absolute", left: 16, right: 16, bottom: 24, alignItems: "center" }}>
          <ToastPill text={toast.text} />
        </View>
      )}
    </View>
  );
}
