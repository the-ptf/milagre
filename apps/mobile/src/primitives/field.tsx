import React, { useState, type ReactNode } from "react";
import { Text, TextInput, View, type StyleProp, type TextInputInstance, type TextInputProps, type ViewStyle } from "react-native";
import { lineHeight } from "../design-tokens";
import { useTheme } from "../theme";
import { useStyles } from "./styles";

/**
 * A labelled text field: field fill with a 1px lineStrong edge that turns accent while focused and redInk when
 * `invalid` (focus wins while typing). Put an `InlineError` under it to say why. `bare` drops the fill and edge, for an
 * input inside a row that already draws them. `leading` / `trailing` (a search icon, a suffix, a button) sit inside the
 * edge, so focus outlines the whole field and never the text alone.
 */
export function Field({
  label,
  hideLabel = false,
  invalid = false,
  bare = false,
  leading,
  trailing,
  containerStyle,
  onFocus,
  onBlur,
  ...props
}: TextInputProps & {
  label: string;
  hideLabel?: boolean;
  invalid?: boolean;
  bare?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  containerStyle?: StyleProp<ViewStyle>;
  ref?: React.Ref<TextInputInstance>;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const [focused, setFocused] = useState(false);
  const edge = bare
    ? { borderWidth: 0, backgroundColor: "transparent" }
    : { borderColor: focused ? colors.accent : invalid ? colors.redInk : colors.lineStrong };
  const adorned = leading != null || trailing != null;
  const input = (
    <TextInput
      accessibilityLabel={label}
      autoCapitalize="none"
      autoCorrect={false}
      placeholderTextColor={colors.ink3}
      selectionColor={colors.accent}
      {...props}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
      // ponytail: lineHeight only on multiline; a single-line iOS TextInput drawn with one sits off centre.
      style={[styles.input, props.multiline && { lineHeight: lineHeight.body }, adorned ? INNER : edge, props.style]}
    />
  );
  return (
    <View style={[{ gap: 8 }, containerStyle]}>
      {!hideLabel && <Text style={styles.label}>{label}</Text>}
      {adorned ? (
        <View style={[styles.input, { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 0 }, edge]}>
          {leading}
          {input}
          {trailing}
        </View>
      ) : (
        input
      )}
    </View>
  );
}

/** The text inside an adorned Field: its frame draws the fill and edge. */
const INNER = { flex: 1, borderWidth: 0, borderRadius: 0, backgroundColor: "transparent", paddingHorizontal: 0 } as const;
