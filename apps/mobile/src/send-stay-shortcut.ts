import { useCallback, useEffect, useRef } from "react";
import { useFocusEffect } from "expo-router";

type Target = { focused: () => boolean; sendStay: () => void };
const targets = new Set<Target>();

export function sendStayShortcut() {
  [...targets].find((target) => target.focused())?.sendStay();
}

export function useSendStayShortcut(sendStay: (() => void) | undefined, focused: () => boolean) {
  const latest = useRef({ sendStay, focused });
  useEffect(() => {
    latest.current = { sendStay, focused };
  });
  useFocusEffect(
    useCallback(() => {
      const target = { focused: () => Boolean(latest.current.sendStay) && latest.current.focused(), sendStay: () => latest.current.sendStay?.() };
      targets.add(target);
      return () => {
        targets.delete(target);
      };
    }, []),
  );
}
