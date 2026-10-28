import { useState } from "react";
import { Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { ChatStep } from "@milagre/shared/model";
import { stepSections } from "@milagre/shared/tool-activity";
import { IconButton, PillButton, useStyles } from "./ui";
import { useTheme } from "./theme";

export function StepOutput({ step }: { step: ChatStep }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [all, setAll] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const sections = stepSections(step);
  const lines = sections.output.replace(/\n$/, "").split("\n");
  const clipped = !all && lines.length > 40;
  const tail = step.kind === "shell" || step.kind === "setup";
  const output = clipped ? (tail ? lines.slice(-40) : lines.slice(0, 40)).join("\n") : sections.output;
  const copy = (label: string, text: string) =>
    void Clipboard.setStringAsync(text).then(
      () => setCopyStatus(`${label} copied`),
      () => setCopyStatus(`${label} copy failed`),
    );
  return (
    <View style={{ gap: 12 }}>
      {[
        [sections.inputLabel, sections.input],
        [sections.outputLabel, output],
      ].map(([label = "", text = ""], index) =>
        text ? (
          <View key={label} style={{ gap: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text accessibilityLiveRegion="polite" style={styles.caption}>
                {label}
                {index === 1 && clipped ? ` · ${tail ? "last" : "first"} 40 of ${lines.length} lines` : ""}
                {copyStatus === `${label} copied` ? " · Copied" : copyStatus === `${label} copy failed` ? " · Copy failed" : ""}
              </Text>
              <IconButton
                size={44}
                label={copyStatus === `${label} copied` ? `${label} copied` : `Copy ${label.toLowerCase()}`}
                icon={copyStatus === `${label} copied` ? Tick02Icon : Copy01Icon}
                onPress={() => copy(label, index === 1 ? sections.output : text)}
              />
            </View>
            <Text selectable style={[styles.code, { fontSize: 12, color: colors.ink2 }]}>
              {text}
            </Text>
          </View>
        ) : null,
      )}
      {clipped && <PillButton title={`Show ${lines.length - 40} ${tail ? "earlier" : "more"} lines`} secondary onPress={() => setAll(true)} />}
    </View>
  );
}
