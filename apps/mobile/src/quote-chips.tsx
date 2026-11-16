import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Cancel01Icon, MessageSquareQuoteIcon } from "@hugeicons/core-free-icons";
import type { ComposerQuote } from "@milagre/shared/prompt-parts";
import { lineHeight, radius, space, type } from "./design-tokens";
import { Icon } from "./icons";
import { IconButton } from "./primitives/icon-button";
import { PageScroll } from "./primitives/page-scroll";
import { useTheme } from "./theme";

export function QuoteChips({ quotes, onRemove, disabled = false }: { quotes: readonly ComposerQuote[]; onRemove: (id: string) => void; disabled?: boolean }) {
  const { colors } = useTheme();
  if (!quotes.length) return null;
  return (
    <PageScroll horizontal accessibilityLabel="Quotes" contentContainerStyle={{ padding: 4, gap: 8 }}>
      {quotes.map((quote) => (
        <View
          key={quote.id}
          style={{
            flexDirection: "row",
            alignItems: "center",
            maxWidth: 220,
            paddingLeft: space.md,
            borderRadius: radius.card,
            borderCurve: "continuous",
            backgroundColor: colors.field,
          }}
        >
          <View
            accessible
            accessibilityLabel={`Quote${quote.source ? ` from ${quote.source}` : ""}: ${quote.text}`}
            style={{ flexDirection: "row", alignItems: "center", flexShrink: 1 }}
          >
            <Icon icon={MessageSquareQuoteIcon} tone="ink2" size={18} />
            <Text
              numberOfLines={1}
              style={{ flexShrink: 1, paddingLeft: 6, color: colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "500" }}
            >
              {`“${quote.text.replace(/\s+/g, " ").trim()}`}
            </Text>
          </View>
          <IconButton label="Remove quote" icon={Cancel01Icon} size={32} tone="ink3" disabled={disabled} onPress={() => onRemove(quote.id)} />
        </View>
      ))}
    </PageScroll>
  );
}

const LONG_QUOTE = 120;

export function SentQuote({ text, textPx }: { text: string; textPx: number }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_QUOTE || text.split("\n").length > 3;
  const size = Math.max(type.caption1, textPx - 2);
  const body = (
    <Text numberOfLines={open ? undefined : 3} style={{ color: colors.ink3, fontSize: size, lineHeight: Math.round(size * 1.4) }}>
      {text}
    </Text>
  );
  const style = { borderLeftWidth: 2, borderColor: colors.line, paddingLeft: space.md };
  if (!long) return <View style={style}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Quote: ${text}`}
      accessibilityHint={open ? "Shows less of the quote" : "Shows the whole quote"}
      accessibilityState={{ expanded: open }}
      onPress={() => setOpen((current) => !current)}
      style={style}
    >
      {body}
    </Pressable>
  );
}
