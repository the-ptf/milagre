import { Linking, Text, View } from "react-native";
import { Stack, router } from "expo-router";
import { ArrowRight01Icon, Notification01Icon } from "@hugeicons/core-free-icons";
import { notificationChimeLabel } from "@milagre/shared/notification-chimes";
import { useAttentionButton } from "../../attention";
import { useActivity } from "../../live-activity";
import { usePush } from "../../push";
import { useSession } from "../../session";
import { Icon } from "../../icons";
import { ErrorNotice, ListRow, PillButton, PullDown, Toggle, useStyles } from "../../ui";
import { SettingsScroll } from "../../settings-find";
import { NotificationScheduleSetting } from "../../notification-schedule-setting";
import { useTheme } from "../../theme";

export default function NotificationsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Notifications" }} />
      <NotificationsView />
    </>
  );
}

/** Notification controls for the native Settings stack. */
export function NotificationsView() {
  const { colors } = useTheme();
  const styles = useStyles();
  const push = usePush();
  const activity = useActivity();
  const session = useSession();
  const [attentionButton, setAttentionButton] = useAttentionButton();
  const state = push.state;
  return (
    <SettingsScroll>
      <View style={[styles.card, { gap: 16 }]}>
        <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
          <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: colors.field, alignItems: "center", justifyContent: "center" }}>
            <Icon icon={Notification01Icon} size={24} tone="ink" />
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={styles.subtitle}>Chat notifications</Text>
            <Text style={styles.muted}>{state?.enabled ? "On" : "Off"}</Text>
          </View>
        </View>
        <Text style={styles.text}>Know when an agent needs you or finishes a turn, even when Milagre is closed.</Text>
        <PillButton
          title={state?.enabled ? "Turn off notifications" : "Enable notifications"}
          secondary={state?.enabled}
          loading={push.busy}
          disabled={!state || push.busy || (!state.enabled && (!!push.unavailable || !session.hosts.length))}
          onPress={() => void (state?.enabled ? push.disable() : push.enable())}
        />
        {push.unavailable ? (
          <Text style={styles.muted}>{push.unavailable}</Text>
        ) : !session.hosts.length ? (
          <Text style={styles.muted}>Pair a computer to receive its Chat notifications.</Text>
        ) : null}
      </View>
      <View style={styles.card}>
        <Toggle
          title="Notify when waiting"
          selected={state?.notifyWhenWaiting ?? true}
          disabled={!state || push.busy}
          onPress={() => void push.preferences({ notifyWhenWaiting: !state?.notifyWhenWaiting })}
        />
        <Text style={styles.muted}>Approvals and questions that need your input.</Text>
        <View style={styles.separator} />
        <Toggle
          title="Notify when finished"
          selected={state?.notifyOnCompletion ?? true}
          disabled={!state || push.busy}
          onPress={() => void push.preferences({ notifyOnCompletion: !state?.notifyOnCompletion })}
        />
        <Text style={styles.muted}>Completed turns and turns that fail.</Text>
        <View style={styles.separator} />
        <Toggle title="Attention button" selected={attentionButton} onPress={() => setAttentionButton(!attentionButton)} />
        <Text style={styles.muted}>When a Chat in another Project needs an approval or an answer.</Text>
      </View>
      <NotificationScheduleSetting />
      <View style={[styles.card, { gap: 4 }]}>
        <ListRow
          title="Notification chime"
          onPress={() => router.push("/chime-sheet")}
          trailing={
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Text style={{ color: colors.ink3, fontSize: 17 }}>{notificationChimeLabel(state?.chime)}</Text>
              <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
            </View>
          }
        />
        <Text style={styles.muted}>Plays when a Chat finishes or needs you, on this phone. Picking one plays it.</Text>
      </View>
      <View style={styles.card}>
        <Toggle
          title="Live Activities"
          selected={activity.enabled}
          disabled={activity.busy || !activity.available || !session.hosts.length}
          onPress={() => void activity.toggle()}
        />
        <View style={styles.separator} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: colors.ink, fontSize: 17, flex: 1 }}>Show in Live Activities</Text>
          <PullDown
            label="Show in Live Activities"
            title="Show in Live Activities"
            sections={[
              {
                items: [
                  { id: "all", title: "Running agents and questions", checked: activity.mode === "all" },
                  { id: "questions", title: "Questions only", checked: activity.mode === "questions" },
                ],
              },
            ]}
            nativeTrigger={{
              title: activity.mode === "questions" ? "Questions only" : "Agents + questions",
              systemImage: "list.bullet",
              showIcon: false,
              disabled: activity.busy,
              maxWidth: 150,
            }}
            onSelect={(id) => {
              if (id === "all" || id === "questions") void activity.changeMode(id);
            }}
          >
            <Text style={styles.text}>{activity.mode === "questions" ? "Questions only" : "Running agents and questions"}</Text>
          </PullDown>
        </View>
        {!activity.available ? <Text style={styles.muted}>Live Activities are unavailable in this build or disabled in system settings.</Text> : null}
        {activity.error ? <ErrorNotice message={activity.error} /> : null}
      </View>
      {push.error ? <ErrorNotice message={push.error} /> : null}
      {state?.pending.length ? (
        <Text style={styles.muted}>
          Removal is pending for {state.pending.map((host) => host.name).join(", ")}. Milagre will retry when you open the app and the computer is online.
        </Text>
      ) : null}
      <Text style={styles.muted}>
        Alerts include Chat previews. Expo, Apple and Google process notification content. Your computer must stay online to send alerts.
      </Text>
      <PillButton title="Open system settings" secondary onPress={() => void Linking.openSettings()} />
    </SettingsScroll>
  );
}
