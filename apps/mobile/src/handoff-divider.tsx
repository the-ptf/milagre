import { Pressable, Text, View } from "react-native";
import { ArrowDataTransferHorizontalIcon } from "@hugeicons/core-free-icons";
import type { HandoffContext } from "@milagre/shared/model";
import { Icon, ProviderLogo, SpinnerRing } from "./icons";
import { handoffSides } from "./handoff-sides";
import { useTheme } from "./theme";

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
  return (
    <Pressable
      accessibilityRole={brief ? "button" : undefined}
      accessibilityLabel={sides.restored ? `Context restored to ${sides.to}` : `Context handoff from ${sides.from} to ${sides.to}`}
      accessibilityHint={brief ? "Opens the handoff brief" : undefined}
      disabled={!brief}
      onPress={() => brief && onOpen(brief)}
      style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
      <View style={{ flexShrink: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: 5 }}>
        {context.status === "preparing" ? <SpinnerRing size={12} /> : <Icon icon={ArrowDataTransferHorizontalIcon} tone="ink3" size={13} />}
        <Text style={{ color: colors.ink3, fontSize: 12 }}>{sides.restored ? "Context restored" : "Context handoff"}</Text>
        {!sides.restored && (
          <>
            <ProviderLogo provider={context.from.provider} size={13} />
            <Text style={{ color: colors.ink3, fontSize: 12 }}>{sides.from} →</Text>
          </>
        )}
        <ProviderLogo provider={context.to.provider} size={13} />
        <Text style={{ color: colors.ink2, fontSize: 12, fontWeight: "500" }}>{sides.to}</Text>
        {context.status === "failed" && <Text style={{ color: colors.orangeInk, fontSize: 12 }}>· Handoff failed</Text>}
      </View>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
    </Pressable>
  );
}
