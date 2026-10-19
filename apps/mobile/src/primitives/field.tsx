import React from "react";
import { Text, TextInput, View, type TextInputInstance, type TextInputProps } from "react-native";
import { useTheme } from "../theme";
import { useStyles } from "./styles";

export function Field({ label, hideLabel = false, ...props }: TextInputProps & { label: string; hideLabel?: boolean; ref?: React.Ref<TextInputInstance> }) {
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <View style={{ gap: 8 }}>
      {!hideLabel && <Text style={styles.label}>{label}</Text>}
      <TextInput
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={colors.ink3}
        selectionColor={colors.accent}
        {...props}
        style={[styles.input, props.style]}
      />
    </View>
  );
}
