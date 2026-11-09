import { useState } from "react";

/**
 * A refresh button's spin. It starts on the click itself, so a slow read (another computer's, a Link's) still answers
 * at once, keeps going while `loading` or while the read the click started runs, then finishes its turn instead of
 * snapping back. The element that spins takes `refresh-spin animate-spin` while `spinning` (refresh-spin swaps the turn
 * for SpinnerRing's stepped fade under reduced motion), and `onAnimationIteration` and `onAnimationEnd`.
 */
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
    // An animation that ends instead of looping (reduced motion without refresh-spin) still lets the spin go.
    onAnimationEnd: () => {
      if (!busy) setSpinning(false);
    },
  };
}
