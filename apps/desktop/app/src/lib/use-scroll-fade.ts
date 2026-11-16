import { type RefObject, useEffect } from "react";

export function useScrollFade(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = element;
      element.toggleAttribute("data-fade-top", scrollTop > 1);
      element.toggleAttribute("data-fade-bottom", scrollTop + clientHeight < scrollHeight - 1);
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const child of Array.from(element.children)) observer.observe(child);
    const mutations = new MutationObserver(() => {
      for (const child of Array.from(element.children)) observer.observe(child);
      update();
    });
    mutations.observe(element, { childList: true, subtree: true });
    return () => {
      element.removeEventListener("scroll", update);
      observer.disconnect();
      mutations.disconnect();
    };
  }, [ref]);
}
