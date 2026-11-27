import { Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { CommandLineIcon, Globe02Icon, Mail01Icon } from "@hugeicons/core-free-icons";
import { CONNECTOR_PRESETS, connectorPreset, type ConnectorPreset, type ConnectorSummary } from "@milagre/shared/connectors";
import { radius, type } from "./design-tokens";
import { Icon } from "./icons";
import { useTheme } from "./theme";

const LINEAR_ICON = CONNECTOR_PRESETS.find((preset) => preset.id === "linear")?.iconPath;

/** A preset or connector's square mark: its brand path, else a mail or command glyph, else its first letter. */
export function ConnectorTile({ preset, connector, size = 32 }: { preset?: ConnectorPreset; connector?: ConnectorSummary; size?: 32 | 56 }) {
  const { colors } = useTheme();
  const found = preset ?? (connector ? connectorPreset(connector) : null);
  const iconPath = connector?.kind === "linear" ? LINEAR_ICON : found?.iconPath;
  const mail = connector?.kind === "email" || found?.auth === "email";
  const command = connector?.kind === "command" || found?.auth === "command";
  const name = connector?.name ?? found?.name ?? "";
  const glyph = size === 56 ? 28 : 18;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size === 56 ? radius.card : radius.control - 2,
        borderCurve: "continuous",
        backgroundColor: colors.field,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {iconPath ? (
        <Svg width={glyph} height={glyph} viewBox="0 0 24 24">
          <Path d={iconPath} fill={colors.ink} />
        </Svg>
      ) : mail || command || !name ? (
        <Icon icon={mail ? Mail01Icon : command ? CommandLineIcon : Globe02Icon} tone="ink" size={size === 56 ? 24 : 18} />
      ) : (
        <Text style={{ color: colors.ink, fontSize: size === 56 ? type.title2 : type.subheadline, fontWeight: "600" }}>
          {name.trim().charAt(0).toUpperCase()}
        </Text>
      )}
    </View>
  );
}
