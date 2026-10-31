import { Stack } from "expo-router";
import { Text, View } from "react-native";
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
        <Text style={styles.text}>Automatic detection is experimental and supports different languages in the same recording. It downloads a 190 MB speech model once and transcribes on this device.</Text>
        <View style={styles.card} accessibilityRole="radiogroup">
          {DICTATION_LANGUAGES.map((item) => (
            <ChoiceRow
              key={item.code}
              title={item.name}
              selected={language === item.code}
              onPress={() => setLanguage(item.code)}
            />
          ))}
        </View>
      </PageScroll>
    </>
  );
}
