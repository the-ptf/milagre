// Fixture smoke environment only. Hidden WebKit suspends requestAnimationFrame.
// Delegate every query except the two exact reduced-motion media query forms.
void (() => {
  const original = window.matchMedia.bind(window);
  window.matchMedia = (query) => {
    const result = original(query);
    if (query !== "(prefers-reduced-motion)" && query !== "(prefers-reduced-motion: reduce)") return result;
    Object.defineProperty(result, "matches", { value: true });
    return result;
  };
})();
