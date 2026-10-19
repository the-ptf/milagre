import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import {
  customContrast,
  DEFAULT_THEME_ID,
  isHex,
  parseCustomTheme,
  resolvePalette,
  seedsFrom,
  serializeCustomTheme,
  themes,
  type CustomTheme,
  type Scheme,
  type ThemeId,
  type ThemeSeeds,
} from "@milagre/shared/themes";
import { showChoiceSheet } from "./choice-store";
import { presets } from "./custom-theme-presets";
import { useTheme } from "./theme";
import { ErrorNotice, PillButton, Segmented, useStyles } from "./ui";

const FIELDS: { key: keyof ThemeSeeds; name: string }[] = [
  { key: "background", name: "Background" },
  { key: "text", name: "Text" },
  { key: "accent", name: "Accent" },
];
const SCHEMES = [
  { value: "light", title: "Light" },
  { value: "dark", title: "Dark" },
];
const BAD_PASTE = "That isn't a Milagre theme. It needs light and dark, each with background, text and accent hex colors.";
const BAD_HEX = "Use a hex color like #1d1430.";
const NO_CLIPBOARD = "Could not read the clipboard.";

function ColorRow({ name, value, swatches, onCommit }: { name: string; value: string; swatches: string[]; onCommit: (hex: string) => void }) {
  const { colors } = useTheme();
  const styles = useStyles();
  // The field keeps what is typed until it is submitted or a full hex color arrives.
  const [draft, setDraft] = useState<{ source: string; text: string } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const text = draft && draft.source === value ? draft.text : value;
  function commit(raw: string) {
    const next = raw.trim();
    if (isHex(next)) {
      setInvalid(false);
      setDraft(null);
      onCommit(next.toLowerCase());
    } else setInvalid(true);
  }
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: value, borderWidth: 1, borderColor: colors.line }} />
        <Text style={[styles.text, { flex: 1, fontSize: 15, fontWeight: "500" }]}>{name}</Text>
        <TextInput
          accessibilityLabel={`${name} hex`}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          maxLength={7}
          value={text}
          selectionColor={colors.accent}
          placeholderTextColor={colors.ink3}
          onChangeText={(next) => {
            setDraft({ source: value, text: next });
            setInvalid(false);
            if (isHex(next.trim())) commit(next);
          }}
          onSubmitEditing={() => commit(text)}
          onBlur={() => {
            if (isHex(text.trim())) commit(text);
            else if (text !== value) setInvalid(true);
          }}
          style={[styles.input, { width: 110, fontFamily: "Menlo", fontSize: 15 }]}
        />
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        {swatches.map((hex, index) => (
          <Pressable
            key={`${hex}-${index}`}
            accessibilityRole="button"
            accessibilityLabel={`${name} ${hex}`}
            onPress={() => {
              setInvalid(false);
              setDraft(null);
              onCommit(hex);
            }}
            style={{
              width: 28,
              height: 28,
              borderRadius: 14,
              backgroundColor: hex,
              borderWidth: hex.toLowerCase() === value.toLowerCase() ? 2 : 1,
              borderColor: hex.toLowerCase() === value.toLowerCase() ? colors.accent : colors.line,
            }}
          />
        ))}
      </View>
      {invalid ? <ErrorNotice message={BAD_HEX} /> : null}
    </View>
  );
}

function Preview({ theme, scheme }: { theme: CustomTheme; scheme: Scheme }) {
  const p = resolvePalette("custom", scheme, theme);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ borderRadius: 12, borderCurve: "continuous", padding: 12, gap: 8, backgroundColor: p.page, borderWidth: 1, borderColor: p.line }}
    >
      <View style={{ borderRadius: 8, padding: 10, backgroundColor: p.surface }}>
        <Text style={{ color: p.ink, fontSize: 14 }}>Done. The tests pass.</Text>
      </View>
      <View style={{ borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: p.inset }}>
        <Text style={{ color: p.ink2, fontSize: 12, fontFamily: "Menlo" }}>
          <Text style={{ color: p.accent }}>const</Text> theme = custom
        </Text>
      </View>
      <View style={{ alignSelf: "flex-end", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 6, backgroundColor: p.accent }}>
        <Text style={{ color: p.onAccent, fontSize: 13, fontWeight: "600" }}>Send</Text>
      </View>
    </View>
  );
}

/** The Custom theme editor, shown under its switch in Settings › Appearance. Edits select the Custom theme. */
export function CustomThemeSection() {
  const { colors, scheme: onScreen, settings, set } = useTheme();
  const styles = useStyles();
  const [editing, setEditing] = useState<Scheme>(onScreen);
  const [error, setError] = useState("");
  const theme = settings.customTheme ?? seedsFrom(DEFAULT_THEME_ID);
  const seeds = theme[editing];
  const contrast = customContrast(seeds);
  const weak = contrast.text < 4.5 || contrast.accent < 3;
  const swatches = presets(editing);
  const save = (next: CustomTheme) => {
    setError("");
    set({ customTheme: next, colorTheme: "custom" });
  };
  function startFrom() {
    showChoiceSheet({
      title: "Start from",
      placeholder: "Search themes",
      emptyLabel: "No themes",
      items: themes.map((item) => ({ id: item.id, title: item.name, subtitle: item.group })),
      onSelect: (id) => save(seedsFrom(id as ThemeId)),
    });
  }
  async function paste() {
    let clipboard: string;
    try {
      clipboard = await Clipboard.getStringAsync();
    } catch {
      setError(NO_CLIPBOARD);
      return;
    }
    const parsed = parseCustomTheme(clipboard);
    if (parsed) save(parsed);
    else setError(BAD_PASTE);
  }
  return (
    <View style={[styles.card, { gap: 14 }]}>
      <Text style={styles.label}>Editing</Text>
      <Segmented label="Editing" value={editing} options={SCHEMES} onChange={(value) => setEditing(value as Scheme)} />
      {FIELDS.map((field) => (
        <ColorRow
          key={`${editing}-${field.key}`}
          name={field.name}
          value={seeds[field.key]}
          swatches={swatches[field.key]}
          onCommit={(hex) => save({ ...theme, [editing]: { ...seeds, [field.key]: hex } })}
        />
      ))}
      <Preview theme={theme} scheme={editing} />
      <Text style={[styles.caption, weak && { color: colors.orange }]}>
        Text on background: {contrast.text.toFixed(1)}:1. Accent on background: {contrast.accent.toFixed(1)}:1.
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <PillButton title="Start from" secondary onPress={startFrom} />
        <PillButton title="Copy JSON" secondary onPress={() => void Clipboard.setStringAsync(serializeCustomTheme(theme))} />
        <PillButton title="Paste JSON" secondary onPress={() => void paste()} />
        <PillButton title="Reset" secondary onPress={() => save(seedsFrom(DEFAULT_THEME_ID))} />
      </View>
      {error ? <ErrorNotice message={error} /> : null}
    </View>
  );
}
