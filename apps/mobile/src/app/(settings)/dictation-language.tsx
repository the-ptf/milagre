import { Stack } from "expo-router";
import { Platform, View } from "react-native";
import { DICTATION_LANGUAGES } from "@milagre/shared/dictation";
import { useDictationLanguage } from "../../chat-display-setting";
import { ChoiceRow } from "../../primitives/choice-row";
import { PageScroll, useStyles } from "../../ui";

export default function DictationLanguageScreen() {
  const styles = useStyles();
  const [language, setLanguage] = useDictationLanguage();
  return (
    <>
      <Stack.Screen options={{ title: "Dictation language" }} />
      <PageScroll>
        <View style={styles.card} accessibilityRole="radiogroup">
          {DICTATION_LANGUAGES.map((item) => (
            <ChoiceRow
              key={item.code}
              title={item.code === "auto" && Platform.OS === "ios" ? "Phone language" : item.name}
              selected={language === item.code}
              onPress={() => setLanguage(item.code)}
            />
          ))}
        </View>
      </PageScroll>
    </>
  );
}
