import { Text, View } from "react-native";
import { useTheme } from "../theme";
import { useStyles } from "./styles";
import { PillButton } from "./pill-button";

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
  return (
    <View accessibilityRole="alert" style={styles.error}>
      <Text selectable style={{ color: colors.red, fontSize: 15, lineHeight: 22 }}>
        {message}
      </Text>
      {retry && <PillButton disabled={disabled} loading={loading} title={retryTitle} secondary onPress={retry} style={{ alignSelf: "flex-start" }} />}
    </View>
  );
}
