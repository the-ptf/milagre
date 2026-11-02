type AlertButton = { text: string; style?: "default" | "cancel" | "destructive"; onPress?: () => void };
/** React Native's Alert.alert, passed in so the dialog can be tested. */
export type ShowAlert = (
  title: string,
  message: string | undefined,
  buttons: AlertButton[],
  options?: { cancelable?: boolean; onDismiss?: () => void },
) => void;

/** A question shown in the confirmation sheet; `choose` runs once, with the button picked or null when dismissed. */
type Confirmation = { title: string; message?: string; buttons: AlertButton[]; choose: (index: number | null) => void };

let current: Confirmation | null = null;
let present: (() => void) | null = null;

/** The app's root wires this to open the sheet route; a route can't carry callbacks, so the question waits here. */
export function setConfirmPresenter(open: () => void) {
  present = open;
}
export function currentConfirmation() {
  return current;
}

/**
 * Alert.alert's shape, answered in a bottom sheet. A dismissed sheet runs the cancel button, as a dismissed alert would.
 * A newer question replaces one still waiting, which counts as dismissed.
 */
export const confirmSheet: ShowAlert = (title, message, buttons, options) => {
  current?.choose(null);
  let done = false;
  const entry: Confirmation = {
    title,
    message,
    buttons,
    choose(index) {
      if (done) return;
      done = true;
      if (current === entry) current = null;
      const button = index === null ? buttons.find((item) => item.style === "cancel") : buttons[index];
      if (button) button.onPress?.();
      else if (index === null) options?.onDismiss?.();
    },
  };
  current = entry;
  present?.();
};

/** Asks with a destructive confirm and a Cancel; resolves true when confirmed. */
export function confirm(title: string, message: string | undefined, action: string) {
  return new Promise<boolean>((resolve) =>
    confirmSheet(title, message, [
      { text: action, style: "destructive", onPress: () => resolve(true) },
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
    ]),
  );
}
