/**
 * Pins the CSS animations under `root` to the document timeline's origin, so every looping indicator steps on one
 * shared 40 ms beat. Chromium draws a frame whenever any stepped animation changes; loops that started at different
 * moments change on different frames, and each adds its own. Pausing (a hidden window, a folded activity) shifts an
 * animation's start, so callers pin again when it resumes.
 */
export function lockToBeat(root: Element | null) {
  if (!root) return;
  for (const animation of root.getAnimations({ subtree: true })) {
    if (animation instanceof CSSAnimation && animation.playState === "running") animation.startTime = 0;
  }
}

/** Pins every `[data-beat]` indicator on the page again, after a pause moved their starts. */
export function lockAllToBeat() {
  for (const element of document.querySelectorAll("[data-beat]")) lockToBeat(element);
}
