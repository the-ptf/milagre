import { Linking, View } from "react-native";
import { DictationNotice } from "./dictation-notice";
import { DictationCapsule, MIC_SIZE, VoiceMicButton } from "./voice-mic-button";
import type { useVoiceDictation } from "./voice-dictation-hook";

export function ComposerMicrophone({
  dictation,
  fixing,
  startDictation,
  discardDictation,
  openMenu,
}: {
  dictation: ReturnType<typeof useVoiceDictation>;
  fixing: string | null;
  startDictation(): void;
  discardDictation(): void;
  openMenu(): void;
}) {
  const { error: dictationError, dismiss: dismissDictationError } = dictation;
  const dictating = dictation.phase !== "idle";
  return dictation.available ? (
    <View>
      {dictationError ? (
        <DictationNotice
          error={dictationError}
          micSize={MIC_SIZE}
          onDismiss={dismissDictationError}
          onOpenSettings={() => {
            dismissDictationError();
            void Linking.openSettings();
          }}
        />
      ) : null}
      {dictating ? (
        <DictationCapsule
          phase={dictation.phase}
          level={dictation.level}
          download={dictation.download}
          onDiscard={discardDictation}
          onStop={() => void dictation.stop()}
        />
      ) : (
        <VoiceMicButton onLongPress={openMenu} onPress={startDictation} processing={fixing} />
      )}
    </View>
  ) : null;
}
