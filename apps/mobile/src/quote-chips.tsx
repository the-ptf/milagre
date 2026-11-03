import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Cancel01Icon, LeftToRightBlockQuoteIcon } from "@hugeicons/core-free-icons";
import type { ComposerQuote } from "@milagre/shared/prompt-parts";
import { lineHeight, radius, space, type } from "./design-tokens";
import { Icon } from "./icons";
import { IconButton } from "./primitives/icon-button";
import { useTheme } from "./theme";

/** The passages quoted into the next message, one row each in the order they were added, over the prompt (as desktop). */
export function QuoteChips({ quotes, onRemove, disabled = false }: { quotes: readonly ComposerQuote[]; onRemove: (id: string) => void; disabled?: boolean }) {
  const { colors } = useTheme();
  if (!quotes.length) return null;
  return (
    <View accessibilityLabel="Quotes" style={{ gap: space.xs, padding: space.xs }}>
      {quotes.map((quote) => (
        <View
          key={quote.id}
          accessible
          accessibilityLabel={`Quote${quote.source ? ` from ${quote.source}` : ""}: ${quote.text}`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.md,
            paddingLeft: space.lg,
            borderRadius: radius.card,
            borderCurve: "continuous",
            backgroundColor: colors.field,
          }}
        >
          <Icon icon={LeftToRightBlockQuoteIcon} tone="ink3" size={16} />
          <View style={{ flex: 1, paddingVertical: space.md }}>
            <Text numberOfLines={2} style={{ color: colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
              {quote.text.replace(/\s+/g, " ")}
            </Text>
            {!!quote.source && <Text style={{ color: colors.ink3, fontSize: type.caption2, lineHeight: lineHeight.caption2 }}>{quote.source}</Text>}
          </View>
          <IconButton label="Remove quote" icon={Cancel01Icon} size={32} tone="ink3" disabled={disabled} onPress={() => onRemove(quote.id)} />
        </View>
      ))}
    </View>
  );
}

// A quote this long may run past three lines in a bubble: it opens on a tap.
const LONG_QUOTE = 120;

/** A quote at the head of a sent message: a bar and quieter text, three lines until tapped open. */
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
