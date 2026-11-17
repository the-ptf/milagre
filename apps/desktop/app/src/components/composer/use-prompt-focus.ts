import { useCallback, type RefObject } from "react";

export function usePromptFocus(root: RefObject<HTMLDivElement | null>) {
  return useCallback(
    (atEnd = false) => {
      requestAnimationFrame(() => {
        const editor = root.current?.querySelector<HTMLElement>("[data-prompt-editor]");
        editor?.focus();
        if (atEnd && editor) {
          const range = document.createRange();
          range.selectNodeContents(editor);
          range.collapse(false);
          window.getSelection()?.removeAllRanges();
          window.getSelection()?.addRange(range);
        }
      });
    },
    [root],
  );
}
