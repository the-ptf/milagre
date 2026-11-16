import { useState } from "react";
import { Alert, Image, Platform, Pressable, Text, View, type ImageSourcePropType } from "react-native";
import { getAppIconName, setAlternateAppIcon, supportsAlternateIcons } from "expo-alternate-app-icons";
import { Findable } from "./settings-find";
import { useTheme } from "./theme";
import { radius, space } from "./design-tokens";
import { pressStyle, SectionLabel, tap, useStyles } from "./ui";

/** The alternate icons app.json's expo-alternate-app-icons entry compiles into the build. `id` null is the main icon. */
const APP_ICONS: { id: string | null; name: string; thumb: ImageSourcePropType }[] = [
  { id: null, name: "Milagre", thumb: require("../assets/app-icons/thumbs/default.png") },
  { id: "Dawn", name: "Dawn", thumb: require("../assets/app-icons/thumbs/dawn.png") },
  { id: "MonoDark", name: "Black", thumb: require("../assets/app-icons/thumbs/mono-dark.png") },
  { id: "MonoLight", name: "White", thumb: require("../assets/app-icons/thumbs/mono-light.png") },
  { id: "Sunset", name: "Sunset", thumb: require("../assets/app-icons/thumbs/sunset.png") },
  { id: "Aurora", name: "Aurora", thumb: require("../assets/app-icons/thumbs/aurora.png") },
  { id: "Glass", name: "Glass", thumb: require("../assets/app-icons/thumbs/glass.png") },
  { id: "EightBit", name: "8-bit", thumb: require("../assets/app-icons/thumbs/eight-bit.png") },
];

/** Settings › Appearance › App icon: iOS only, where the system swaps the Home Screen icon and confirms with its own alert. */
export function AppIconSection() {
  const { colors } = useTheme();
  const styles = useStyles();
  const [current, setCurrent] = useState<string | null>(() => (supportsAlternateIcons ? getAppIconName() : null));
  if (Platform.OS !== "ios" || !supportsAlternateIcons) return null;
  async function choose(id: string | null) {
    if (id === current) return;
    tap();
    const previous = current;
    setCurrent(id);
    try {
      await setAlternateAppIcon(id as Parameters<typeof setAlternateAppIcon>[0]);
    } catch (error) {
      setCurrent(previous);
      Alert.alert("Couldn't change the icon", error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <View style={{ gap: 8 }}>
      <SectionLabel>App icon</SectionLabel>
      <Findable title="App icon">
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel="App icon"
          style={[styles.card, { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-start", columnGap: 12, rowGap: 16 }]}
        >
          {APP_ICONS.map((icon) => {
            const selected = icon.id === current;
            return (
              <Pressable
                key={icon.name}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                accessibilityLabel={`${icon.name} icon`}
                onPress={() => void choose(icon.id)}
                style={({ pressed }) => [{ width: 68, alignItems: "center", gap: 6 }, pressStyle({ pressed })]}
              >
                <View
                  style={{
                    padding: space.xxs,
                    borderRadius: radius.sheet,
                    borderCurve: "continuous",
                    borderWidth: 2,
                    borderColor: selected ? colors.ink : "transparent",
                  }}
                >
                  <Image source={icon.thumb} style={{ width: 56, height: 56, borderRadius: radius.card, borderCurve: "continuous" }} />
                </View>
                <Text numberOfLines={1} style={[styles.caption, { color: selected ? colors.ink : undefined }]}>
                  {icon.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Findable>
    </View>
  );
}
