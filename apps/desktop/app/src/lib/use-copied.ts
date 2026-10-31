import { useCallback, useEffect, useRef, useState } from "react";

/** Copy raw text, with brief feedback only after a successful clipboard write. */
export function useCopied(text: string) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      if (!mounted.current) return;
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; leave the button ready to retry.
    }
  }, [text]);
  return { copied, copy };
}
