import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { SpinnerRing } from "./icons";
import { CircleButton, useStyles } from "./ui";

const WAIT_MS = 15_000;

export function PrPending({ number, waiting, onClose }: { number: number; waiting: boolean; onClose?: () => void }) {
  const styles = useStyles();
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
        <View style={{ flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 16 }}>
          <CircleButton label="Close" icon={Cancel01Icon} onPress={onClose} />
        </View>
      )}
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
        {spinning && <SpinnerRing size={20} />}
        <Text style={[styles.muted, { textAlign: "center" }]}>
          {spinning
            ? `Opening ${label}…`
            : waiting
              ? `Couldn't open ${label}. Open its Chat and try again.`
              : "This PR's Worktree isn't on this computer anymore."}
        </Text>
      </View>
    </View>
  );
}
