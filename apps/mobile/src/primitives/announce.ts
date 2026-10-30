import { useEffect, useRef } from "react";
import { AccessibilityInfo } from "react-native";

/**
 * Reads `message` aloud on VoiceOver and TalkBack. `accessibilityLiveRegion` alone only speaks on Android, so use this
 * instead of a live region (not with one, or TalkBack reads it twice).
 */
export function announce(message: string | null | undefined) {
  if (message) AccessibilityInfo.announceForAccessibility(message);
}

/**
 * Announces `message` when it changes to a new non-empty value: a status line, a progress label. The value it mounts
 * with is not read (a remount while scrolling says nothing); pass `onMount` for something that appears to say it (an
 * error, a toast).
 */
export function useAnnounce(message: string | null | undefined, { onMount = false }: { onMount?: boolean } = {}) {
  const last = useRef(onMount ? undefined : message);
  useEffect(() => {
    if (message === last.current) return;
    last.current = message;
    announce(message);
  }, [message]);
}
