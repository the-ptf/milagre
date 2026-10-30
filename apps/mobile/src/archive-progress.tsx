import { useSyncExternalStore } from "react";
import { StyleSheet, Text, View } from "react-native";
import { archiveActivity, subscribeArchiveActivity } from "./archive";
import { SpinnerRing } from "./icons";
import { useAnnounce, useStyles } from "./ui";
import { lineHeight, radius, type } from "./design-tokens";
import { createStylesHook, type Palette } from "./theme";

/** Which Chats are archiving and the last archive notice, kept across screens. */
export function useArchiveActivity() {
  return useSyncExternalStore(subscribeArchiveActivity, archiveActivity);
}

export function ArchiveProgress() {
  const styles = useStyles();
  useAnnounce("Archiving Chat", { onMount: true });
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Archiving Chat"
      style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 8 }}
    >
      <SpinnerRing size={16} />
      <Text style={styles.muted}>Archiving…</Text>
    </View>
  );
}

/** Desktop's archiving pill: a SpinnerRing and "Archiving…" over a Chat's row while it archives; the row itself fades and takes no taps until the archive ends. */
export function ArchivingOverlay({ title }: { title: string }) {
  const s = useS();
  useAnnounce(`Archiving ${title}`, { onMount: true });
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={`Archiving ${title}`} style={[StyleSheet.absoluteFill, s.overlay]}>
      <View style={s.pill}>
        <SpinnerRing size={12} />
        <Text style={s.label}>Archiving…</Text>
      </View>
    </View>
  );
}

const makeS = (colors: Palette) =>
  StyleSheet.create({
    overlay: { alignItems: "center", justifyContent: "center" },
    pill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      minHeight: 24,
      paddingHorizontal: 8,
      borderRadius: radius.full,
      borderCurve: "continuous",
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
    },
    label: { color: colors.ink, fontSize: type.caption1, lineHeight: lineHeight.caption1, fontWeight: "500" },
  });
const useS = createStylesHook(makeS);
