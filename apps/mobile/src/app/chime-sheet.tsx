import { Text } from "react-native";
import { VolumeHighIcon } from "@hugeicons/core-free-icons";
import { NOTIFICATION_CHIMES, parseNotificationChime } from "@milagre/shared/notification-chimes";
import { Icon } from "../icons";
import { playNotificationChime } from "../notification-chime-audio";
import { usePush } from "../push";
import { CheckRow, Group, SheetBody, SheetHeader, useStyles } from "../ui";

/**
 * Settings > Notifications > Notification chime. A tap picks the chime and plays it; the sheet stays open so the next
 * one can be tried. The choice rides along with this phone's push registration, so each Mac sends it as the sound.
 */
export default function ChimeSheet() {
  const styles = useStyles();
  const push = usePush();
  const chosen = parseNotificationChime(push.state?.chime);
  return (
    <>
      <SheetHeader title="Notification chime" />
      <SheetBody style={{ paddingTop: 8 }}>
        <Group role="radiogroup" accessibilityLabel="Notification chime" inset={0}>
          {NOTIFICATION_CHIMES.map((chime) => {
            const checked = chime.id === chosen;
            return (
              <CheckRow
                key={chime.id}
                title={chime.label}
                checked={checked}
                disabled={!push.state}
                trailing={checked && chime.id !== "system" ? <Icon icon={VolumeHighIcon} tone="ink3" size={18} /> : undefined}
                onPress={() => {
                  playNotificationChime(chime.id);
                  if (!checked) void push.preferences({ chime: chime.id });
                }}
              />
            );
          })}
        </Group>
        <Text style={[styles.caption, { textAlign: "center" }]}>
          {push.state?.enabled
            ? "Plays when a Chat finishes or needs you. Tap one to hear it."
            : "Turn on notifications in Settings › Notifications to hear it when a Chat finishes or needs you."}
        </Text>
      </SheetBody>
    </>
  );
}
