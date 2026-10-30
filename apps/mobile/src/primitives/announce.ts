import { useEffect } from "react";
import { AccessibilityInfo } from "react-native";

/**
 * Reads `message` aloud on VoiceOver and TalkBack. `accessibilityLiveRegion` alone only speaks on Android, so use this
 * instead of a live region (not with one, or TalkBack reads it twice).
 */
export function announce(message: string | null | undefined) {
  if (message) AccessibilityInfo.announceForAccessibility(message);
}

/** Announces `message` whenever it changes to a new non-empty value: a toast, a status line, a progress label. */
export function useAnnounce(message: string | null | undefined) {
  useEffect(() => announce(message), [message]);
}
