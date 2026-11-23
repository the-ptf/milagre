import { Platform, Text, View } from "react-native";
import { router } from "expo-router";
import { DICTATION_FIX_MODELS, DICTATION_LANGUAGES, whisperModelFor, type DictationFixModel } from "@milagre/shared/dictation";
import { DICTATION_ACTION_OPTIONS } from "@milagre/shared/voice-dictation";
import {
  useDictationEnabled,
  useDictationSymbols,
  useDictationAction,
  useDictationFixModel,
  useDictationFixUp,
  useDictationLanguage,
  useDictationModel,
} from "./chat-display-setting";
import { ChoiceCards, DictationPreview } from "./chat-display-choices";
import { ListRow, Toggle, showActions, useStyles } from "./ui";
import { radius, space } from "./design-tokens";

export function VoiceSection() {
  const styles = useStyles();
  const [dictation] = useDictationLanguage();
  const speechModel = whisperModelFor("phone", useDictationModel()[0]);
  const [dictationAction, setDictationAction] = useDictationAction();
  const [enabled, setEnabled] = useDictationEnabled();
  const [symbols, setSymbols] = useDictationSymbols();
  const [fixUp, setFixUp] = useDictationFixUp();
  const [fixModel, setFixModel] = useDictationFixModel();
  return (
    <View style={{ gap: space.md }}>
      <View style={styles.card}>
        <Toggle title="Enable dictation" selected={enabled} onPress={() => setEnabled(!enabled)} />
        <Text style={styles.caption}>Show the microphone and enable dictation on this device.</Text>
      </View>
      <Text style={styles.section}>When dictation finishes</Text>
      <ChoiceCards
        compact
        label="When dictation finishes"
        value={dictationAction}
        onChange={setDictationAction}
        options={DICTATION_ACTION_OPTIONS.map((option) => ({
          value: option.value,
          title: option.label,
          description: option.description,
          preview: <DictationPreview sent={option.value === "send"} />,
        }))}
      />
      <View style={[styles.card, { paddingVertical: 0, marginTop: 8, borderRadius: radius.card }]}>
        <ListRow
          inlineSubtitle
          title="Dictation language"
          subtitle={DICTATION_LANGUAGES.find((item) => item.code === dictation)?.name}
          onPress={() => router.push("/dictation-language")}
        />
        <View style={styles.separator} />
        <ListRow
          inlineSubtitle
          title="Speech model"
          subtitle={`${speechModel.name} · ${Math.round(speechModel.size / 1e6)} MB`}
          onPress={() => router.push("/dictation-model")}
        />
      </View>
      {Platform.OS === "ios" && Platform.isPad && (
        <View style={styles.card}>
          <ListRow
            title="Keyboard shortcut"
            subtitle="On iPad, press to start and again to stop. Change the keys in Keybindings."
            onPress={() => router.push("/keybindings")}
          />
        </View>
      )}
      <View style={[styles.card, { gap: 4, marginTop: 8 }]}>
        <Toggle title="Spoken symbols" selected={symbols} onPress={() => setSymbols(!symbols)} />
        <Text style={styles.caption}>{'Say "backtick npm test backtick" for inline code or "insert newline" for a line break.'}</Text>
        <Toggle title="Fix names with AI" selected={fixUp} onPress={() => setFixUp(!fixUp)} />
      </View>
      {fixUp && (
        <View style={[styles.card, { paddingVertical: 0, borderRadius: radius.card }]}>
          <ListRow
            inlineSubtitle
            title="Fix-up model"
            subtitle={DICTATION_FIX_MODELS.find((model) => model.value === fixModel)?.label}
            onPress={() => pickFixModel(fixModel, setFixModel)}
          />
        </View>
      )}
      <Text style={[styles.caption, { paddingHorizontal: space.xs }]}>
        After you stop, your computer corrects misheard file, code and provider names using the Chat. The words show at once and update a few seconds later,
        unless you edit them first. Automatic uses the smallest model of the Chat&apos;s agent.
      </Text>
    </View>
  );
}

function pickFixModel(current: DictationFixModel, onPick: (model: DictationFixModel) => void) {
  showActions({
    title: "Fix-up model",
    actions: DICTATION_FIX_MODELS.map((model) => ({ id: model.value, title: model.value === current ? `${model.label} ✓` : model.label })),
    onSelect: (value) => onPick(value as DictationFixModel),
  });
}
