import { lineHeight, radius, type } from "./design-tokens";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CloudOffIcon, ComputerIcon, LaptopIcon } from "@hugeicons/core-free-icons";
import { GlassSurface } from "./primitives/glass-surface";
import { Icon, type IconData } from "./icons";
import { tap } from "./primitives/tap";
import { DISABLED_OPACITY } from "./ui";
import { useTheme } from "./theme";
import { allComputers } from "./all-computers";
import { isDesktopComputer } from "./computer-actions";
import { useS } from "./navigation-styles";

/** A button in the list's header capsule; the capsule draws the glass behind them all. */
export function HeaderButton({ label, icon, onPress }: { label: string; icon: IconData; onPress: () => void }) {
  const s = useS();
  const { colors } = useTheme();
  // A press tints the glass instead of fading it: UIKit drops Liquid Glass for good when an ancestor's alpha changes.
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      onPress={() => {
        tap();
        onPress();
      }}
      style={s.headerButton}
    >
      {({ pressed }) => (
        <>
          {pressed && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius.sheet, backgroundColor: colors.hover }]} />}
          <Icon icon={icon} tone="ink" size={20} />
        </>
      )}
    </Pressable>
  );
}

/** The Liquid Glass behind the header capsule, as the list's floating controls have. */
export function HeaderGlass() {
  return <GlassSurface radius={radius.sheet} />;
}

/** "2 computers offline" in ink3 at the end of the list, with Retry reading just those computers again. */
export function OfflineLine({ hostIds }: { hostIds: string[] }) {
  const s = useS();
  const { colors } = useTheme();
  const [retrying, setRetrying] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const retry = () => {
    if (retrying) return;
    setRetrying(true);
    void allComputers.refreshHosts(hostIds).finally(() => alive.current && setRetrying(false));
  };
  return (
    <View style={s.offlineLine}>
      <Text style={{ color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
        {hostIds.length === 1 ? "1 computer offline" : `${hostIds.length} computers offline`}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Retry offline computers" disabled={retrying} hitSlop={8} onPress={retry}>
        <Text
          style={{
            color: colors.ink3,
            fontSize: type.footnote,
            lineHeight: lineHeight.footnote,
            fontWeight: "600",
            opacity: retrying ? DISABLED_OPACITY.control : 1,
          }}
        >
          {retrying ? "Retrying..." : "Retry"}
        </Text>
      </Pressable>
    </View>
  );
}

/** A Chat's computer: its icon and name, with an offline mark when it isn't answering. */
export function ComputerTag({ name, offline, chip = false, large = false }: { name: string; offline: boolean; chip?: boolean; large?: boolean }) {
  const s = useS();
  const { colors } = useTheme();
  return (
    <View style={[{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 }, chip && s.chip]}>
      <Icon icon={offline ? CloudOffIcon : isDesktopComputer(name) ? ComputerIcon : LaptopIcon} tone={offline ? "orange" : "ink3"} size={large ? 14 : 13} />
      <Text numberOfLines={1} style={[large ? s.inboxText : s.detail, { flexShrink: 1 }, offline && { color: colors.orangeInk }]}>
        {offline ? `${name}, offline` : name}
      </Text>
    </View>
  );
}
