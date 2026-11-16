import { useState } from "react";

export function useRefreshSpin(onRefresh: () => unknown, loading = false) {
  const [pending, setPending] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const busy = loading || pending > 0;
  if (busy && !spinning) setSpinning(true);
  return {
    busy,
    spinning,
    refresh: () => {
      setPending((count) => count + 1);
      void Promise.resolve()
        .then(onRefresh)
        .catch(() => {})
        .finally(() => setPending((count) => count - 1));
    },
    onAnimationIteration: () => {
      if (!busy) setSpinning(false);
    },
    onAnimationEnd: () => {
      if (!busy) setSpinning(false);
    },
  };
}
