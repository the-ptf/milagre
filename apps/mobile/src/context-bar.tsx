import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { CONTEXT_GRADIENT_COLORS, CONTEXT_GRADIENT_STOPS, normalizeContextSettings, type ContextSettings } from "@milagre/shared/context-settings";
import { useTheme } from "./theme";

export function ContextBar({
  percent = 100,
  settings,
  onChange,
  disabled = false,
}: {
  percent?: number;
  settings: ContextSettings;
  onChange?: (patch: Partial<ContextSettings>) => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(300);
  const [draft, setDraft] = useState<ContextSettings | null>(null);
  const drag = useRef({ x: 0, value: 0, next: settings });
  const shown = draft ?? settings;
  const close = shown.autoThreshold - shown.buttonThreshold < 12;
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ height: close ? 76 : 56, marginHorizontal: 8 }}>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel="Context usage"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(percent) }}
        style={{ position: "absolute", left: 0, right: 0, top: 32, height: 6, borderRadius: 999, overflow: "hidden", backgroundColor: colors.lineStrong }}
      >
        <View style={{ width: `${Math.max(0, Math.min(100, percent))}%`, height: 6, overflow: "hidden", borderRadius: 999 }}>
          <LinearGradient
            colors={CONTEXT_GRADIENT_COLORS}
            locations={CONTEXT_GRADIENT_STOPS}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={{ width, height: 6 }}
          />
        </View>
      </View>
      {(["buttonThreshold", "autoThreshold"] as const).map((key) => (
        <View
          key={key}
          accessible
          accessibilityRole={onChange ? "adjustable" : "text"}
          accessibilityLabel={key === "buttonThreshold" ? "Compact button threshold" : "Automatic compaction threshold"}
          accessibilityValue={{
            min: key === "buttonThreshold" ? 5 : settings.buttonThreshold + 5,
            max: key === "buttonThreshold" ? 90 : 95,
            now: shown[key],
            text: `${shown[key]}%`,
          }}
          accessibilityActions={onChange ? [{ name: "increment" }, { name: "decrement" }] : undefined}
          onAccessibilityAction={(e) => {
            if (onChange && !disabled)
              onChange(normalizeContextSettings({ ...settings, [key]: settings[key] + (e.nativeEvent.actionName === "increment" ? 1 : -1) }));
          }}
          onStartShouldSetResponder={() => Boolean(onChange) && !disabled}
          onResponderGrant={(e) => {
            drag.current = { x: e.nativeEvent.pageX, value: settings[key], next: settings };
          }}
          onResponderMove={(e) => {
            const n = drag.current.value + ((e.nativeEvent.pageX - drag.current.x) / width) * 100;
            const next = normalizeContextSettings({ ...settings, [key]: key === "buttonThreshold" ? Math.min(n, settings.autoThreshold - 5) : n });
            drag.current.next = next;
            setDraft(next);
          }}
          onResponderRelease={() => {
            onChange?.(drag.current.next);
            setDraft(null);
          }}
          onResponderTerminate={() => setDraft(null)}
          style={{
            position: "absolute",
            left: (width * shown[key]) / 100 - 22,
            top: close && key === "autoThreshold" ? 35 : 0,
            width: 44,
            height: close ? 35 : 56,
            alignItems: "center",
            opacity: disabled ? 0.5 : 1,
          }}
        >
          <Text
            style={{
              transform: close && key === "autoThreshold" ? [{ translateY: 18 }] : undefined,
              fontSize: 11,
              fontWeight: "600",
              color: key === "buttonThreshold" ? colors.orangeInk : colors.ink,
              fontVariant: ["tabular-nums"],
            }}
          >
            {shown[key]}%
          </Text>
          <View
            style={{
              position: "absolute",
              top: close && key === "autoThreshold" ? -9 : 26,
              width: 18,
              height: 18,
              borderRadius: 999,
              borderWidth: 2.5,
              borderColor: key === "buttonThreshold" ? colors.orange : colors.ink,
              backgroundColor: colors.surface,
            }}
          />
        </View>
      ))}
    </View>
  );
}
