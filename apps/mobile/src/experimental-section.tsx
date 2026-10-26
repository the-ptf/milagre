import { Text, View } from "react-native";
import { useFloatingInbox, useFloatingInboxActivity } from "./floating-inbox-setting";
import { useUltracodeFatality } from "./ultracode-fatality-setting";
import { Toggle, useStyles } from "./ui";

/** Settings › Experimental: this phone's experimental features, like desktop's Experimental section. */
export function ExperimentalSection() {
  const styles = useStyles();
  const [floatingInbox, setFloatingInbox] = useFloatingInbox();
  const [inboxActivity, setInboxActivity] = useFloatingInboxActivity();
  const [fatality, setFatality] = useUltracodeFatality();
  return (
    <View style={{ gap: 8 }}>
      <View style={[styles.card, { gap: 4 }]}>
        <Toggle title="Floating inbox" selected={floatingInbox} onPress={() => setFloatingInbox(!floatingInbox)} />
        <Text style={styles.caption}>
          A movable inbox button in the Chat. Tap to answer questions or approve requests. Flick it toward the left or right edge to tuck it away.
        </Text>
        {floatingInbox && (
          <View style={{ marginLeft: 16, gap: 4 }}>
            <Toggle title="Show chat activity" selected={inboxActivity} onPress={() => setInboxActivity(!inboxActivity)} />
            <Text style={styles.caption}>Include working chats with a progress summary and finished updates. Off: only questions and permission requests.</Text>
          </View>
        )}
      </View>
      <View style={[styles.card, { gap: 4 }]}>
        <Toggle title="Ultracode Fatality" selected={fatality} onPress={() => setFatality(!fatality)} />
        <Text style={styles.caption}>
          Turning Ultracode on darkens the screen, slams ULTRACODE across it Mortal Kombat style, and an announcer says it out loud.
        </Text>
      </View>
    </View>
  );
}
