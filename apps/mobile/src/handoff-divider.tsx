import { Pressable, Text } from "react-native";
import { ArrowDataTransferHorizontalIcon } from "@hugeicons/core-free-icons";
import type { HandoffContext } from "@milagre/shared/model";
import { ProviderLogo, SpinnerRing } from "./icons";
import { handoffSides } from "./handoff-sides";
import { lineHeight, type } from "./design-tokens";
import { useTheme } from "./theme";
import { TranscriptDivider } from "./ui";

/** A provider switch inside the Chat, as on desktop. Tapping it opens the brief the new provider was sent. */
export function HandoffDivider({
  context,
  models,
  onOpen,
}: {
  context: HandoffContext;
  models: { id: string; name: string }[];
  onOpen: (brief: string) => void;
}) {
  const { colors } = useTheme();
  const sides = handoffSides(context, models);
  const brief = context.status === "done" ? context.brief : undefined;
  const label = sides.restored ? `Context restored to ${sides.to}` : `Context handoff from ${sides.from} to ${sides.to}`;
  const caption = { color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1 };
  return (
    <Pressable
      accessibilityRole={brief ? "button" : undefined}
      accessibilityLabel={label}
      accessibilityHint={brief ? "Opens the handoff brief" : undefined}
      disabled={!brief}
      onPress={() => brief && onOpen(brief)}
    >
      <TranscriptDivider label={label} icon={ArrowDataTransferHorizontalIcon} leading={context.status === "preparing" ? <SpinnerRing size={12} /> : undefined}>
        <Text style={caption}>{sides.restored ? "Context restored" : "Context handoff"}</Text>
        {!sides.restored && (
          <>
            <ProviderLogo provider={context.from.provider} size={12} />
            <Text style={caption}>{sides.from} →</Text>
          </>
        )}
        <ProviderLogo provider={context.to.provider} size={12} />
        <Text style={[caption, { color: colors.ink2, fontWeight: "500" }]}>{sides.to}</Text>
        {context.status === "failed" && <Text style={[caption, { color: colors.orangeInk }]}>· Handoff failed</Text>}
      </TranscriptDivider>
    </Pressable>
  );
}
