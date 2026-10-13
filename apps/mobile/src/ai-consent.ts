import { Alert, AppState, Linking } from "react-native";
import * as SecureStore from "expo-secure-store";
import { createAiConsent, requiresAiConsent, AI_CONSENT_TITLE, AI_CONSENT_DESCRIPTION, AI_CONSENT_DETAIL, PRIVACY_URL } from "@milagre/shared/ai-consent";

const KEY = "milagre.ai-sharing-consent";
export const aiConsent = createAiConsent({
  read: () => SecureStore.getItemAsync(KEY),
  write: (value) =>
    value === null
      ? SecureStore.deleteItemAsync(KEY)
      : SecureStore.setItemAsync(KEY, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  ask: () =>
    new Promise<boolean>((resolve) => {
      if (AppState.currentState !== "active") {
        resolve(false);
        return;
      }
      Alert.alert(
        AI_CONSENT_TITLE,
        `${AI_CONSENT_DESCRIPTION}\n\n${AI_CONSENT_DETAIL}`,
        [
          {
            text: "Privacy policy",
            onPress: () => {
              resolve(false);
              void Linking.openURL(PRIVACY_URL).catch(() => Alert.alert("Could not open privacy policy", `Visit ${PRIVACY_URL} in your browser.`));
            },
          },
          { text: "Not now", style: "cancel", onPress: () => resolve(false) },
          { text: "Allow sharing", onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      );
    }),
});

export async function beforeAiCall(method: string, args: unknown[]) {
  if (requiresAiConsent(method, args)) {
    // Live Activity replies may run in a headless task. They must never present UI.
    await aiConsent.require(method !== "live-activity:answer" && AppState.currentState === "active");
  }
}
