import { useMemo } from "react";
import { Text } from "react-native";
import { highlightFile, MAX_SYNTAX_CHARACTERS } from "@milagre/shared/file-syntax";
import { fonts, useTheme } from "./theme";
import { useStyles } from "./ui";

export function FileCode({ text, name }: { text: string; name: string }) {
  const { colors, codeSize } = useTheme();
  const styles = useStyles();
  const tokens = useMemo(() => highlightFile(text, name), [text, name]);
  return (
    <>
      <Text selectable style={{ color: colors.ink, fontSize: codeSize + 1, lineHeight: Math.round((codeSize + 1) * 1.5), fontFamily: fonts.mono }}>
        {tokens.map((token, index) => (
          <Text key={index} style={{ color: colors.syntax[token.kind] }}>
            {token.text}
          </Text>
        ))}
      </Text>
      {text.length > MAX_SYNTAX_CHARACTERS && <Text style={styles.caption}>Large file shown without syntax colors.</Text>}
    </>
  );
}
