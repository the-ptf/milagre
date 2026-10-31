import { Stack } from "expo-router";
import { ActionSheetIOS, Alert, Platform, Pressable, Text, View } from "react-native";
import { Cancel01Icon, MoreHorizontalIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { WHISPER_MODELS, type WhisperModel } from "@milagre/shared/dictation";
import { useDictationModel } from "../../chat-display-setting";
import { radius, type } from "../../design-tokens";
import { Icon } from "../../icons";
import { useTheme } from "../../theme";
import { useStyles } from "../../ui";
import { SettingsScroll } from "../../settings-find";
import { DownloadRing } from "../../voice-mic-button";
import { cancelWhisperModel, deleteWhisperModel, downloadWhisperModel, useWhisperModels, type WhisperModelState } from "../../voice-transcription-whisper";

const megabytes = (bytes: number) => Math.round(bytes / 1e6);

function detail(model: WhisperModel, state: WhisperModelState | undefined, selected: boolean) {
  if (state?.received != null) return `${model.name} · ${megabytes(state.received)} of ${megabytes(model.size)} MB`;
  if (state?.ready) return `${model.name} · ${megabytes(model.size)} MB · Downloaded`;
  return `${model.name} · ${megabytes(model.size)} MB${selected ? " · Downloads on your next take" : ""}`;
}

function Dots({ label, value }: { label: string; value: number }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Text style={{ color: colors.ink3, fontSize: type.caption1 }}>{label}</Text>
      <View style={{ flexDirection: "row", gap: 3 }}>
        {[1, 2, 3].map((dot) => (
          <View key={dot} style={{ width: 6, height: 6, borderRadius: radius.full, backgroundColor: dot <= value ? colors.ink2 : colors.lineStrong }} />
        ))}
      </View>
    </View>
  );
}

/** A downloaded model's … menu: its one action frees the space it takes. */
function confirmDelete(model: WhisperModel) {
  const title = `Delete download · ${megabytes(model.size)} MB`;
  const remove = () => void deleteWhisperModel(model.id);
  if (Platform.OS === "ios")
    ActionSheetIOS.showActionSheetWithOptions(
      { title: model.purpose, options: [title, "Cancel"], destructiveButtonIndex: 0, cancelButtonIndex: 1 },
      (index) => {
        if (index === 0) remove();
      },
    );
  else
    Alert.alert(model.purpose, undefined, [
      { text: "Cancel", style: "cancel" },
      { text: title, style: "destructive", onPress: remove },
    ]);
}

function ModelRow({ model, state, selected, onPick }: { model: WhisperModel; state: WhisperModelState | undefined; selected: boolean; onPick: () => void }) {
  const { colors } = useTheme();
  const downloading = state?.received != null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: 78, paddingLeft: 16, paddingRight: 8 }}>
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ checked: selected }}
        accessibilityLabel={`${model.purpose}, ${detail(model, state, selected)}`}
        onPress={onPick}
        style={({ pressed }) => ({ flex: 1, paddingVertical: 10, gap: 2, opacity: pressed ? 0.6 : 1 })}
      >
        <Text style={{ color: colors.ink, fontSize: type.body, fontWeight: selected ? "600" : "500" }}>{model.purpose}</Text>
        <Text style={{ color: colors.ink3, fontSize: type.footnote, fontVariant: ["tabular-nums"] }}>{detail(model, state, selected)}</Text>
        <View style={{ flexDirection: "row", gap: 16, marginTop: 4 }}>
          <Dots label="Accuracy" value={model.accuracy} />
          <Dots label="Speed" value={model.speed} />
        </View>
      </Pressable>
      {downloading ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Cancel the ${model.purpose} download`}
          onPress={() => cancelWhisperModel(model.id)}
          style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
        >
          <DownloadRing size={28} stroke={2.5} progress={(state.received ?? 0) / model.size}>
            <Icon icon={Cancel01Icon} size={14} tone="ink" />
          </DownloadRing>
        </Pressable>
      ) : state?.ready ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`More for ${model.purpose}`}
          onPress={() => confirmDelete(model)}
          style={({ pressed }) => ({ width: 44, height: 44, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}
        >
          <Icon icon={MoreHorizontalIcon} size={20} tone="ink2" />
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Download ${model.purpose}, ${megabytes(model.size)} MB`}
          onPress={() => void downloadWhisperModel(model.id).catch(() => {})}
          hitSlop={6}
          style={({ pressed }) => ({
            height: 32,
            paddingHorizontal: 14,
            borderRadius: radius.full,
            justifyContent: "center",
            backgroundColor: pressed ? colors.hover2 : colors.hover,
          })}
        >
          <Text style={{ color: colors.ink, fontSize: type.subheadline, fontWeight: "600" }}>Get</Text>
        </Pressable>
      )}
      <View style={{ width: 28, alignItems: "center" }}>{selected ? <Icon icon={Tick02Icon} tone="accentInk" size={20} /> : null}</View>
    </View>
  );
}

/** Settings › Chat › Dictation › Speech model: the Whisper models this phone can run. Picking one uses it and downloads it. */
export default function DictationModelScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const [selected, setSelected] = useDictationModel();
  const states = useWhisperModels();
  return (
    <>
      <Stack.Screen options={{ title: "Speech model" }} />
      <SettingsScroll>
        <Text style={styles.muted}>
          {Platform.OS === "ios"
            ? "Whisper transcribes on this iPhone when Dictation language is Detect automatically. A picked language uses Apple's built-in recognizer, no download."
            : "Whisper transcribes on this phone, so your voice never leaves it. Picking a model downloads it once."}
        </Text>
        <View style={[styles.card, { padding: 0, gap: 0, borderRadius: radius.card }]} accessibilityRole="radiogroup">
          {WHISPER_MODELS.phone.map((model, index) => (
            <View key={model.id}>
              {index > 0 ? <View style={[styles.separator, { marginLeft: 16 }]} /> : null}
              <ModelRow
                model={model}
                state={states[model.id]}
                selected={model.id === selected}
                onPick={() => {
                  setSelected(model.id);
                  void downloadWhisperModel(model.id).catch(() => {});
                }}
              />
            </View>
          ))}
        </View>
        <Text style={{ color: colors.ink3, fontSize: type.footnote, marginHorizontal: 16 }}>English-only models always listen for English.</Text>
      </SettingsScroll>
    </>
  );
}
