import { Text, View } from "react-native";
import { lineHeight, type } from "../design-tokens";
import { useTheme } from "../theme";
import { useStyles } from "./styles";
import { useAnnounce } from "./announce";
import { PillButton } from "./pill-button";

/**
 * A blocking failure (tier 2): a redTint card with the message in redInk 15/20 and its retry inside, read aloud as it
 * shows. A field-level or in-card error is an `InlineError`.
 */
export function ErrorNotice({
  message,
  retry,
  retryTitle = "Reconnect",
  disabled = false,
  loading = false,
}: {
  message: string;
  retry?: () => void;
  retryTitle?: string;
  disabled?: boolean;
  loading?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  // role "alert" is never spoken on iOS, so the message is announced on both platforms.
  useAnnounce(message, { onMount: true });
  return (
    <View accessibilityRole="alert" style={styles.error}>
      <Text selectable style={{ color: colors.redInk, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
        {message}
      </Text>
      {retry && <PillButton disabled={disabled} loading={loading} title={retryTitle} variant="secondary" onPress={retry} style={{ alignSelf: "flex-start" }} />}
    </View>
  );
}
