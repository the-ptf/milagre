import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { Search01Icon } from "@hugeicons/core-free-icons";
import {
  CONNECTOR_CATEGORIES,
  connectorPreset,
  connectorSignInLabel,
  searchConnectorPresets,
  type ConnectorCategory,
  type ConnectorPreset,
} from "@milagre/shared/connectors";
import { ConnectorTile } from "./connector-tile";
import { radius, space } from "./design-tokens";
import { Icon } from "./icons";
import { useTheme } from "./theme";
import { Chip, Field, InlineError, Tag, pressStyle, useStyles } from "./ui";
import { useConnectors } from "./use-connectors";

/** What tapping a tile does on the phone: Email starts an agent that sets it up; the rest finish on the computer. */
const PHONE_LINE: Partial<Record<ConnectorPreset["auth"], string>> = { email: "An agent sets it up" };

function Tile({ preset, added, onPress }: { preset: ConnectorPreset; added: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${preset.name}. ${preset.description}${added ? " Added." : ""}`}
      onPress={onPress}
      style={({ pressed }) => [
        {
          flexBasis: "48%",
          flexGrow: 1,
          minHeight: 128,
          padding: space.lg,
          gap: space.md,
          borderRadius: radius.card,
          borderCurve: "continuous",
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.line,
        },
        pressStyle({ pressed, kind: "control" }),
      ]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <ConnectorTile preset={preset} />
        {added ? <Tag label="Added" tone="green" /> : null}
      </View>
      <Text style={[styles.text, { fontWeight: "600" }]} numberOfLines={1}>
        {preset.name}
      </Text>
      <Text style={[styles.footnote, { flex: 1, color: colors.ink2 }]} numberOfLines={2}>
        {preset.description}
      </Text>
      <Text style={styles.caption} numberOfLines={1}>
        {PHONE_LINE[preset.auth] ?? connectorSignInLabel(preset)}
      </Text>
    </Pressable>
  );
}

/** Browse services: every catalog entry by category. Email sets itself up through an agent; the rest are added on the computer. */
export function ConnectorGallery() {
  const styles = useStyles();
  const { client, hostName, connectors, error, setUpEmail } = useConnectors();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ConnectorCategory | null>(null);
  if (!client) return null;
  const added = new Set(
    (connectors ?? []).map((item) => (item.kind === "linear" ? "linear" : item.kind === "email" ? "email" : connectorPreset(item)?.id)).filter(Boolean),
  );
  const found = searchConnectorPresets(query, category ?? undefined);
  const sections = CONNECTOR_CATEGORIES.map((section) => ({ ...section, presets: found.filter((preset) => preset.category === section.id) })).filter(
    (section) => section.presets.length > 0,
  );
  const open = (preset: ConnectorPreset) => {
    if (preset.auth === "email") return void setUpEmail();
    Alert.alert(
      `Add ${preset.name} on ${hostName || "your computer"}`,
      preset.auth === "browser"
        ? "Its sign-in page opens in the browser there. Open Settings › Connectors in Milagre on that computer."
        : "It needs a token, an app or a command set up there. Open Settings › Connectors in Milagre on that computer.",
    );
  };
  return (
    <View style={{ gap: 16 }}>
      <Field
        label="Search services"
        hideLabel
        placeholder={`Search ${searchConnectorPresets("").length} services`}
        value={query}
        onChangeText={setQuery}
        leading={<Icon icon={Search01Icon} size={18} />}
        autoCorrect={false}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.md }}>
        <Chip label="All" selected={category === null} onPress={() => setCategory(null)} />
        {CONNECTOR_CATEGORIES.map((item) => (
          <Chip key={item.id} label={item.label} selected={category === item.id} onPress={() => setCategory(item.id)} />
        ))}
      </ScrollView>
      <InlineError message={error} />
      {sections.map((section) => (
        <View key={section.id} style={{ gap: 8 }}>
          <Text accessibilityRole="header" style={[styles.section, { paddingHorizontal: space.lg }]}>
            {section.id === "builtin" ? "Built into Milagre" : section.label}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
            {section.presets.map((preset) => (
              <Tile key={preset.id} preset={preset} added={added.has(preset.id)} onPress={() => open(preset)} />
            ))}
          </View>
        </View>
      ))}
      {sections.length === 0 ? <Text style={styles.muted}>{`Nothing matches "${query}".`}</Text> : null}
      <Text style={styles.footnote}>Services that sign in with a browser, a token or a command are added in Milagre on {hostName || "your computer"}.</Text>
    </View>
  );
}
