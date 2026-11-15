import { Alert, Platform } from "react-native";

/** A question with a text answer; `answer` runs once, with the text saved or null when cancelled or dismissed. */
type TextPrompt = { title: string; message?: string; value: string; action: string; plain: boolean; answer: (text: string | null) => void };

let current: TextPrompt | null = null;
let present: (() => void) | null = null;

/** The app's root wires this to open the prompt sheet; a route can't carry callbacks, so the question waits here. */
export function setPromptPresenter(open: () => void) {
  present = open;
}
export function currentPrompt() {
  return current;
}

/**
 * Asks for a line of text: iOS's own text alert, a bottom sheet on Android, where Alert.prompt does nothing. Resolves
 * with the text as typed, or null when cancelled. A newer question replaces one still waiting, which counts as
 * cancelled. `plain`: no capitals or autocorrect, for a key typed exactly.
 */
export function promptText(
  title: string,
  { message, value = "", action = "Save", plain = false }: { message?: string; value?: string; action?: string; plain?: boolean } = {},
) {
  return new Promise<string | null>((resolve) => {
    if (Platform.OS === "ios") {
      Alert.prompt(
        title,
        message,
        [
          { text: "Cancel", style: "cancel", onPress: () => resolve(null) },
          { text: action, onPress: (text?: string) => resolve(text ?? "") },
        ],
        "plain-text",
        value,
      );
      return;
    }
    current?.answer(null);
    let done = false;
    const entry: TextPrompt = {
      title,
      message,
      value,
      action,
      plain,
      answer(text) {
        if (done) return;
        done = true;
        if (current === entry) current = null;
        resolve(text);
      },
    };
    current = entry;
    present?.();
  });
}
