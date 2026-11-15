import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { CONTEXT_DEFAULTS, type ContextSettings } from "@milagre/shared/context-settings";
import { useTheme } from "./theme";
import { Field, Toggle, pressStyle, tap, useStyles } from "./ui";
import { lineHeight, radius, space, type } from "./design-tokens";
import { useContextSettings } from "./context-settings";
import { useCompactButtonDisplay, useShowContextSize } from "./chat-display-setting";
import { ContextBar } from "./context-bar";

function ThresholdField({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (n: number) => void;
}) {
  const { colors } = useTheme();
  const [text, setText] = useState(String(value));
  const [previous, setPrevious] = useState(value);
  if (previous !== value) {
    setPrevious(value);
    setText(String(value));
  }
  const commit = () => {
    const n = Number(text);
    if (text.trim() && Number.isFinite(n)) {
      const next = Math.max(min, Math.min(max, Math.round(n)));
      setText(String(next));
      onChange(next);
    } else setText(String(value));
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <Text style={{ flex: 1, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, color: colors.ink }}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Decrease ${label}`}
          disabled={disabled || value <= min}
          onPress={() => onChange(value - 1)}
          style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
        >
          <Text style={{ color: colors.ink2 }}>−</Text>
        </Pressable>
        <Field
          label={`${label} percentage`}
          hideLabel
          keyboardType="number-pad"
          value={text}
          onChangeText={setText}
          onEndEditing={commit}
          onSubmitEditing={commit}
          editable={!disabled}
          selectTextOnFocus
          style={{ width: 52, minHeight: 44, padding: 6, textAlign: "center", fontSize: type.subheadline }}
        />
        <Text style={{ color: colors.ink2 }}>%</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Increase ${label}`}
          disabled={disabled || value >= max}
          onPress={() => onChange(value + 1)}
          style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
        >
          <Text style={{ color: colors.ink2 }}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}
export function ContextSettingsSection() {
  const styles = useStyles();
  const { colors } = useTheme();
  const host = useContextSettings();
  const value = host.settings;
  const disabled = !host.ready || host.saving;
  const [show, setShow] = useShowContextSize();
  const [display, setDisplay] = useCompactButtonDisplay();
  const save = (patch: Partial<ContextSettings>) => void host.save(patch);
  return (
    <View style={{ gap: 12 }}>
      <Text style={styles.section}>Context size</Text>
      <View style={styles.card}>
        <Toggle title="Show size beside Send" selected={show} onPress={() => setShow(!show)} />
        <Text style={styles.muted}>Tap for usage and Compact now.</Text>
      </View>
      <Toggle title="Show below threshold" selected={display === "always"} onPress={() => setDisplay(display === "always" ? "threshold" : "always")} />
      <View style={{ flexDirection: "row", gap: 12, alignItems: "stretch" }}>
        {(["always", "threshold"] as const).map((mode) => (
          <Pressable
            key={mode}
            accessibilityRole="radio"
            accessibilityState={{ checked: mode === display }}
            accessibilityLabel={mode === "always" ? "Show Compact below threshold: On" : "Show Compact below threshold: Off, default"}
            onPress={() => {
              if (mode === display) return;
              tap();
              setDisplay(mode);
            }}
            style={({ pressed }) => [
              {
                flex: 1,
                padding: space.lg,
                borderRadius: radius.card,
                borderCurve: "continuous",
                borderWidth: mode === display ? 2 : 1,
                // Selection is ink, as on the other choice cards: accent is for focus and links.
                borderColor: mode === display ? colors.ink : colors.line,
                backgroundColor: colors.surface,
                minHeight: 196,
                gap: space.md,
              },
              pressStyle({ pressed }),
            ]}
          >
            <View style={{ backgroundColor: colors.field, borderRadius: radius.control, borderCurve: "continuous", padding: space.md, gap: space.lg }}>
              {[42, 78].map((n) => (
                <View key={n} style={{ gap: 4 }}>
                  <Text style={{ fontSize: type.caption2, lineHeight: lineHeight.caption2, color: colors.ink3 }}>At {n}%</Text>
                  <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 4 }}>
                    {(mode === "always" || n >= value.buttonThreshold) && (
                      <Text
                        style={{ fontSize: type.caption2, lineHeight: lineHeight.caption2, color: n >= value.buttonThreshold ? colors.orangeInk : colors.ink2 }}
                      >
                        Compact
                      </Text>
                    )}
                    <Text style={{ fontSize: type.caption2, lineHeight: lineHeight.caption2, color: colors.ink2 }}>{n}%</Text>
                  </View>
                </View>
              ))}
            </View>
            <Text style={{ fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "600", color: colors.ink }}>
              {mode === "always" ? "On" : "Off · default"}
            </Text>
            <Text style={{ fontSize: type.caption1, lineHeight: lineHeight.caption1, color: colors.ink3 }}>
              {mode === "always" ? "Show Compact from the first message." : "Show Compact only at your threshold."}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.card}>
        <Toggle title="Auto compact quietly" selected={value.autoCompact} disabled={disabled} onPress={() => save({ autoCompact: !value.autoCompact })} />
        <Text style={styles.muted}>Compacts at your limit. No context size, button or notifications.</Text>
      </View>
      <Text style={styles.section}>Thresholds on this computer</Text>
      <View style={[styles.card, { gap: 12 }]}>
        <ContextBar settings={value} disabled={disabled} onChange={save} />
        <ThresholdField
          label="Compact button at"
          value={value.buttonThreshold}
          min={5}
          max={90}
          disabled={disabled}
          onChange={(buttonThreshold) => save({ buttonThreshold })}
        />
        <View style={styles.separator} />
        <ThresholdField
          label="Auto compact at"
          value={value.autoThreshold}
          min={value.buttonThreshold + 5}
          max={95}
          disabled={disabled}
          onChange={(autoThreshold) => save({ autoThreshold })}
        />
      </View>
      <Text style={styles.muted}>Auto compact waits for the reply to finish. Thresholds apply to every Claude Chat on this computer.</Text>
      <Pressable
        disabled={disabled}
        accessibilityRole="button"
        onPress={() => save({ buttonThreshold: CONTEXT_DEFAULTS.buttonThreshold, autoThreshold: CONTEXT_DEFAULTS.autoThreshold })}
        style={({ pressed }) => [{ minHeight: 44, justifyContent: "center" }, pressStyle({ pressed, disabled })]}
      >
        <Text style={{ color: colors.accentInk, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>Reset to defaults</Text>
      </Pressable>
      {host.error ? (
        <Text accessibilityRole="alert" style={{ color: colors.redInk }}>
          {host.error}
        </Text>
      ) : !host.ready ? (
        <Text style={styles.muted}>Connect to an updated computer to change thresholds.</Text>
      ) : null}
    </View>
  );
}
