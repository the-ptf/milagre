import { useSyncExternalStore } from "react";
import { StyleSheet, Text, View } from "react-native";
import { archiveActivity, subscribeArchiveActivity } from "./archive";
import { SpinnerRing } from "./icons";
import { useStyles } from "./ui";
import { createStylesHook, type Palette } from "./theme";

/** Which Chats are archiving and the last archive notice, kept across screens. */
export function useArchiveActivity() {
  return useSyncExternalStore(subscribeArchiveActivity, archiveActivity);
}

export function ArchiveProgress() {
  const styles = useStyles();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Deleting Chat"
      accessibilityLiveRegion="polite"
      style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 8 }}
    >
      <SpinnerRing size={14} />
      <Text style={styles.muted}>Deleting...</Text>
    </View>
  );
}

/** Desktop's archiving pill: a SpinnerRing and "Deleting..." over a Chat's row while it archives; the row itself fades and takes no taps until the archive ends. */
export function ArchivingOverlay({ title }: { title: string }) {
  const s = useS();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`Deleting ${title}`}
      accessibilityLiveRegion="polite"
      style={[StyleSheet.absoluteFill, s.overlay]}
    >
      <View style={s.pill}>
        <SpinnerRing size={12} />
        <Text style={s.label}>Deleting...</Text>
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
      height: 24,
      paddingHorizontal: 10,
      borderRadius: 12,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
    },
    label: { color: colors.ink, fontSize: 12, fontWeight: "500" },
  });
const useS = createStylesHook(makeS);
