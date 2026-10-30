import { Pressable, Text, View } from "react-native";
import { Tick02Icon, VolumeHighIcon } from "@hugeicons/core-free-icons";
import { NOTIFICATION_CHIMES, parseNotificationChime } from "@milagre/shared/notification-chimes";
import { Icon } from "../icons";
import { playNotificationChime } from "../notification-chime-audio";
import { usePush } from "../push";
import { SheetBody, SheetHeader, pressStyle, useStyles } from "../ui";
import { useTheme } from "../theme";
import { lineHeight, type } from "../design-tokens";

/**
 * Settings > Notifications > Notification chime. A tap picks the chime and plays it; the sheet stays open so the next
 * one can be tried. The choice rides along with this phone's push registration, so each Mac sends it as the sound.
 */
export default function ChimeSheet() {
  const { colors } = useTheme();
  const styles = useStyles();
  const push = usePush();
  const chosen = parseNotificationChime(push.state?.chime);
  return (
    <SheetBody>
      <SheetHeader title="Notification chime" style={{ paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0 }} />
      <View accessibilityRole="radiogroup" style={[styles.card, { paddingVertical: 4 }]}>
        {NOTIFICATION_CHIMES.map((chime, index) => {
          const checked = chime.id === chosen;
          return (
            <View key={chime.id}>
              {index > 0 && <View style={styles.separator} />}
              <Pressable
                accessibilityRole="radio"
                accessibilityLabel={chime.label}
                accessibilityState={{ checked, disabled: !push.state }}
                disabled={!push.state}
                onPress={() => {
                  playNotificationChime(chime.id);
                  if (!checked) void push.preferences({ chime: chime.id });
                }}
                style={({ pressed }) => [
                  { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48 },
                  pressStyle({ pressed, disabled: !push.state, kind: "row" }),
                ]}
              >
                <Text style={{ flex: 1, color: colors.ink, fontSize: type.body, lineHeight: lineHeight.body }}>{chime.label}</Text>
                {checked && chime.id !== "system" && <Icon icon={VolumeHighIcon} tone="accent" size={18} />}
                <View style={{ width: 18 }}>{checked && <Icon icon={Tick02Icon} tone="accent" size={18} />}</View>
              </Pressable>
            </View>
          );
        })}
      </View>
      <Text style={[styles.caption, { textAlign: "center" }]}>
        {push.state?.enabled
          ? "Plays when a Chat finishes or needs you. Tap one to hear it."
          : "Turn on notifications in Settings › Notifications to hear it when a Chat finishes or needs you."}
      </Text>
    </SheetBody>
  );
}
