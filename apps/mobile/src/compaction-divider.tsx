import { Text, View } from "react-native";
import { ArrowShrink01Icon } from "@hugeicons/core-free-icons";
import type { CompactionContext } from "@milagre/shared/model";
import { compactionLabel, compactionText } from "@milagre/shared/compaction";
import { Icon, SpinnerRing } from "./icons";
import { fonts, useTheme } from "./theme";

/** A manual or automatic compaction, as on desktop: it spins while the agent compacts. */
export function CompactionDivider({ context }: { context: CompactionContext }) {
  const { colors } = useTheme();
  const label = compactionLabel(context);
  if (context.quiet && context.status !== "failed") return null;
  return (
    <View accessible accessibilityLabel={compactionText(context)} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
      <View style={{ flexShrink: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: 5 }}>
        {context.status === "preparing" ? <SpinnerRing size={12} /> : <Icon icon={ArrowShrink01Icon} tone="ink3" size={13} />}
        <Text style={{ color: context.status === "failed" ? colors.orangeInk : colors.ink3, fontSize: 12 }}>{label.title}</Text>
        {label.before && (
          <Text style={{ color: label.after ? colors.ink3 : colors.ink2, fontSize: 11.5, fontFamily: fonts.mono, fontVariant: ["tabular-nums"] }}>
            {label.before}
            {label.after ? " → " : ""}
            {label.after && <Text style={{ color: colors.ink2, fontWeight: "500" }}>{label.after}</Text>}
          </Text>
        )}
      </View>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
    </View>
  );
}
