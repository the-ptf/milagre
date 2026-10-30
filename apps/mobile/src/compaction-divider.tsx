import { Text } from "react-native";
import { ArrowShrink01Icon } from "@hugeicons/core-free-icons";
import type { CompactionContext } from "@milagre/shared/model";
import { compactionLabel, compactionText } from "@milagre/shared/compaction";
import { lineHeight, type } from "./design-tokens";
import { SpinnerRing } from "./icons";
import { TranscriptDivider } from "./primitives/transcript-divider";
import { fonts, useTheme } from "./theme";

/** A manual or automatic compaction, as on desktop: it spins while the agent compacts. */
export function CompactionDivider({ context }: { context: CompactionContext }) {
  const { colors } = useTheme();
  const label = compactionLabel(context);
  return (
    <TranscriptDivider
      label={compactionText(context)}
      icon={ArrowShrink01Icon}
      leading={context.status === "preparing" ? <SpinnerRing size={12} /> : undefined}
    >
      <Text style={{ color: context.status === "failed" ? colors.orangeInk : colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1 }}>
        {label.title}
      </Text>
      {label.before && (
        <Text
          style={{
            color: label.after ? colors.ink3 : colors.ink2,
            fontSize: type.caption2,
            lineHeight: lineHeight.caption2,
            fontFamily: fonts.mono,
            fontVariant: ["tabular-nums"],
          }}
        >
          {label.before}
          {label.after ? " → " : ""}
          {label.after && <Text style={{ color: colors.ink2, fontWeight: "500" }}>{label.after}</Text>}
        </Text>
      )}
    </TranscriptDivider>
  );
}
