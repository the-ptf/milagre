import { Platform, Pressable, Text, View } from "react-native";
import { Findable } from "./settings-find";
import * as Haptics from "expo-haptics";
import { DIFF_PAIRS, MOTION_SPEEDS, PHONE_CODE_SIZES, PHONE_TEXT_SIZES, PROVIDER_ICON_STYLES } from "@milagre/shared/appearance";
import { DEFAULT_THEME_ID, seedsFrom, themes, themeSwatch, type ThemeChoice, type ThemeGroup } from "@milagre/shared/themes";
import { CustomThemeSection } from "./custom-theme-section";
import { useTheme } from "./theme";
import { PullDown, Segmented, Toggle, useStyles } from "./ui";

const GROUPS: ThemeGroup[] = ["Milagre", "Catppuccin", "Popular"];
const MODES = [
  { value: "system", title: "System" },
  { value: "light", title: "Light" },
  { value: "dark", title: "Dark" },
];

const asOptions = (list: readonly { id: string; label: string }[]) => list.map((entry) => ({ value: entry.id, title: entry.label }));
const TEXT_SIZES = asOptions(PHONE_TEXT_SIZES);
const CODE_SIZES = asOptions(PHONE_CODE_SIZES);
const DIFF_COLORS = asOptions(DIFF_PAIRS);
const MOTIONS = asOptions(MOTION_SPEEDS);
const PROVIDER_ICONS = asOptions(PROVIDER_ICON_STYLES);

/** One choice row: the label and what it changes on the left, a pull-down with the current choice on the right. */
function Choice({
  label,
  detail,
  value,
  options,
  onChange,
}: {
  label: string;
  detail: string;
  value: string;
  options: { value: string; title: string }[];
  onChange: (value: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const current = options.find((option) => option.value === value)?.title ?? "";
  return (
    <Findable title={label}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.ink, fontSize: 17 }}>{label}</Text>
          <Text style={styles.caption}>{detail}</Text>
        </View>
        <PullDown
          label={label}
          title={label}
          sections={[{ items: options.map((option) => ({ id: option.value, title: option.title, checked: option.value === value })) }]}
          nativeTrigger={{ title: current, systemImage: "chevron.up.chevron.down", showIcon: false, maxWidth: 160 }}
          onSelect={(id) => {
            if (id !== value && options.some((option) => option.value === id)) onChange(id);
          }}
        >
          <Text style={styles.text}>{current}</Text>
        </PullDown>
      </View>
    </Findable>
  );
}

function Tile({ id, label, name, detail }: { id: ThemeChoice; label: string; name: string; detail: string }) {
  const { colors, settings, set } = useTheme();
  const styles = useStyles();
  const selected = settings.colorTheme === id;
  const { page, accent } = themeSwatch(id, settings.customTheme);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={label}
      onPress={() => {
        if (Platform.OS === "ios") void Haptics.selectionAsync().catch(() => {});
        set({ colorTheme: id });
      }}
      style={({ pressed }) => ({
        width: "48%",
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        padding: 10,
        borderRadius: 12,
        borderCurve: "continuous",
        backgroundColor: pressed ? colors.hover : colors.field,
        borderWidth: 2,
        borderColor: selected ? colors.accent : "transparent",
      })}
    >
      <View style={{ width: 32, height: 32, borderRadius: 16, overflow: "hidden", backgroundColor: page, borderWidth: 1, borderColor: colors.line }}>
        <View style={{ position: "absolute", right: 0, bottom: 0, width: 16, height: 16, backgroundColor: accent }} />
      </View>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={[styles.text, { fontSize: 14, fontWeight: "500", lineHeight: 18 }]}>
          {name}
        </Text>
        <Text numberOfLines={2} style={styles.caption}>
          {detail}
        </Text>
      </View>
    </Pressable>
  );
}

/** Settings › Appearance: the same modes and themes as desktop's Appearance page. */
export function AppearanceSection() {
  const styles = useStyles();
  const { settings, set } = useTheme();
  // On: start from the current theme's colors and select Custom. Off while Custom is selected: back to Milagre Blue, seeds kept.
  function changeCustomTheme(enabled: boolean) {
    if (!enabled) {
      set({
        customThemeEnabled: false,
        ...(settings.colorTheme === "custom" ? { colorTheme: DEFAULT_THEME_ID } : {}),
      });
      return;
    }
    const from = settings.colorTheme === "custom" ? DEFAULT_THEME_ID : settings.colorTheme;
    set({
      customThemeEnabled: true,
      customTheme: settings.customTheme ?? seedsFrom(from),
      colorTheme: "custom",
    });
  }
  return (
    <View style={{ gap: 20 }}>
      <View style={styles.card}>
        <Text style={styles.label}>Mode</Text>
        <Segmented label="Mode" value={settings.mode} options={MODES} onChange={(mode) => set({ mode: mode as typeof settings.mode })} />
      </View>
      <View style={{ gap: 8 }}>
        <Text style={styles.section}>Text and motion</Text>
        <View style={[styles.card, { gap: 16 }]}>
          <Choice
            label="Text size"
            detail="Messages and the composer."
            value={settings.textSize}
            options={TEXT_SIZES}
            onChange={(textSize) => set({ textSize: textSize as typeof settings.textSize })}
          />
          <Choice
            label="Code size"
            detail="Code blocks and diffs."
            value={settings.codeSize}
            options={CODE_SIZES}
            onChange={(codeSize) => set({ codeSize: codeSize as typeof settings.codeSize })}
          />
          <Choice
            label="Diff colors"
            detail="Additions and deletions, including change counts."
            value={settings.diffColors}
            options={DIFF_COLORS}
            onChange={(diffColors) => set({ diffColors: diffColors as typeof settings.diffColors })}
          />
          <Choice
            label="Animations"
            detail="In-app motion. Navigation transitions stay native."
            value={settings.motion}
            options={MOTIONS}
            onChange={(motion) => set({ motion: motion as typeof settings.motion })}
          />
        </View>
      </View>
      <View style={{ gap: 8 }}>
        <Text style={styles.section}>Icons</Text>
        <View style={styles.card}>
          <Choice
            label="Provider icons"
            detail="Original colors, or black and white to match the mode."
            value={settings.providerIcons}
            options={PROVIDER_ICONS}
            onChange={(providerIcons) => set({ providerIcons: providerIcons as typeof settings.providerIcons })}
          />
        </View>
      </View>
      {GROUPS.map((group) => (
        <View key={group} style={{ gap: 8 }} accessibilityRole="radiogroup" accessibilityLabel={group}>
          <Text style={styles.section}>{group}</Text>
          <View style={[styles.card, { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", columnGap: 0, rowGap: 8 }]}>
            {themes
              .filter((theme) => theme.group === group)
              .map((theme) => (
                <Tile
                  key={theme.id}
                  id={theme.id}
                  label={group === "Milagre" ? theme.name : `${group} ${theme.name}`}
                  name={theme.name}
                  detail={theme.id === "milagre-blue" ? "Default" : theme.id === "gray" ? "Classic" : `Light: ${theme.lightName}`}
                />
              ))}
            {group === "Milagre" && settings.customThemeEnabled && settings.customTheme ? (
              <Tile id="custom" label="Custom" name="Custom" detail="Your colors" />
            ) : null}
          </View>
        </View>
      ))}
      <View style={{ gap: 8 }}>
        <Text style={styles.section}>Custom theme</Text>
        <View style={[styles.card, { gap: 4 }]}>
          <Toggle title="Custom theme" selected={settings.customThemeEnabled} onPress={() => changeCustomTheme(!settings.customThemeEnabled)} />
          <Text style={styles.caption}>Build a theme from a few colors. It shows up as &quot;Custom&quot; with the Milagre themes.</Text>
        </View>
        {settings.customThemeEnabled && <CustomThemeSection />}
      </View>
    </View>
  );
}
