import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { IconButton, useStyles } from "./ui";
import { useTheme } from "./theme";

const WAIT_MS = 15_000;

/**
 * A PR page that can't show yet: the Chat's Project is still loading or the phone is reconnecting (a spinner until
 * it can), or the Worktree isn't on this Mac anymore. With `onClose`, the X closes the sheet, as the PR's own top row does.
 */
export function PrPending({ number, waiting, onClose }: { number: number; waiting: boolean; onClose?: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  // A Project that never arrives (its Chat was closed, the Mac went away) stops the wait after a while.
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setGaveUp(true), WAIT_MS);
    return () => clearTimeout(timer);
  }, [waiting]);
  const spinning = waiting && !gaveUp;
  const label = Number.isSafeInteger(number) && number > 0 ? `PR #${number}` : "the PR";
  return (
    <View style={[styles.screen, { paddingTop: 16 }]}>
      {onClose && (
        <View style={{ flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 12 }}>
          <IconButton label="Close" icon={Cancel01Icon} size={44} onPress={onClose} />
        </View>
      )}
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
        {spinning && <ActivityIndicator color={colors.ink3} />}
        <Text style={[styles.muted, { textAlign: "center" }]}>
          {spinning ? `Opening ${label}…` : waiting ? `Couldn't open ${label}. Open its Chat and try again.` : "This PR's Worktree isn't on this Mac anymore."}
        </Text>
      </View>
    </View>
  );
}
