import { useEffect, useState } from "react";
import type { BackgroundTaskOutput } from "./model";

/** Read a command's output only while its detail is visible, with at most one request in flight. */
export function useTaskOutput(read: () => Promise<BackgroundTaskOutput>, active = true) {
  const [output, setOutput] = useState<BackgroundTaskOutput | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await read();
        if (cancelled) return;
        setOutput(next);
        setError("");
      } catch (failure) {
        if (cancelled) return;
        setError(failure instanceof Error ? failure.message : "Could not read the command output.");
      }
      if (!cancelled) timer = setTimeout(refresh, 1500);
    }
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [read, active]);
  return { output, error };
}
