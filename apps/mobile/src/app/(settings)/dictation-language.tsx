import { Stack } from "expo-router";
import { Platform, Text, View } from "react-native";
import { DICTATION_LANGUAGES, whisperModelFor } from "@milagre/shared/dictation";
import { useDictationLanguage, useDictationModel } from "../../chat-display-setting";
import { ChoiceRow } from "../../primitives/choice-row";
import { useStyles } from "../../ui";
import { SettingsScroll } from "../../settings-find";

export default function DictationLanguageScreen() {
  const styles = useStyles();
  const [language, setLanguage] = useDictationLanguage();
  const model = whisperModelFor("phone", useDictationModel()[0]);
  // Android always runs Whisper, so an English-only model decides the language; iOS hands a picked language to Apple.
  const englishOnly = model.english && Platform.OS !== "ios";
  return (
    <>
      <Stack.Screen options={{ title: "Dictation language" }} />
      <SettingsScroll>
        {englishOnly ? (
          <Text style={styles.text}>{model.purpose} only understands English. Pick an any-language speech model to dictate in others.</Text>
        ) : null}
        <Text style={styles.text}>
          Automatic detection is experimental and supports different languages in the same recording. It uses the speech model picked in Settings and
          transcribes on this device.
        </Text>
        <View style={styles.card} accessibilityRole="radiogroup">
          {DICTATION_LANGUAGES.map((item) => (
            <ChoiceRow key={item.code} title={item.name} selected={language === item.code} onPress={() => setLanguage(item.code)} />
          ))}
        </View>
      </SettingsScroll>
    </>
  );
}
