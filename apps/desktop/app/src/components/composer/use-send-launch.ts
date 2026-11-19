import { useLayoutEffect, useRef, type RefObject } from "react";

const SEND_LAUNCH_MS = 520;
const SEND_LAUNCH_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const EXIT_MS = 180;
const EXIT_EASE = "cubic-bezier(0.4, 0, 1, 1)";
const LAUNCH_TTL_MS = 2000;
const EXITS = [
  { selector: "[data-new-chat-heading]", lift: -8 },
  { selector: "[data-new-chat-glance]", lift: 8 },
];

type Launch = {
  at: number;
  text: DOMRect;
  composer: DOMRect;
  exits: { node: HTMLElement; rect: DOMRect; lift: number }[];
};

function reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function contentOrigin(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return { left: rect.left + parseFloat(style.paddingLeft || "0"), top: rect.top + parseFloat(style.paddingTop || "0") };
}

function playExit(host: HTMLElement, { node, rect, lift }: Launch["exits"][number]) {
  const frame = host.getBoundingClientRect();
  Object.assign(node.style, {
    position: "absolute",
    left: `${rect.left - frame.left}px`,
    top: `${rect.top - frame.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    pointerEvents: "none",
    zIndex: "5",
  });
  host.appendChild(node);
  node
    .animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: `translateY(${lift}px)` },
      ],
      { duration: EXIT_MS, easing: EXIT_EASE, fill: "forwards" },
    )
    .finished.finally(() => node.remove())
    .catch(() => {});
}

function lastUserBubble(root: HTMLElement) {
  const messages = root.querySelectorAll<HTMLElement>('[data-slot="message"][data-from="user"] [data-user-bubble]');
  return messages[messages.length - 1] ?? null;
}

function launchOffset(from: { left: number; top: number }, to: { left: number; top: number }) {
  return { x: Math.round(from.left - to.left), y: Math.round(from.top - to.top) };
}

export function useSendLaunch(root: RefObject<HTMLElement | null>, isNewChat: boolean) {
  const launch = useRef<Launch | null>(null);

  const capture = () => {
    const host = root.current;
    if (!host || !isNewChat || reducedMotion()) return;
    const editor = host.querySelector<HTMLElement>("[data-prompt-editor]");
    const composer = host.querySelector<HTMLElement>("[data-composer-wrap]");
    if (!editor || !composer) return;
    const origin = contentOrigin(editor);
    const exits = EXITS.flatMap(({ selector, lift }) => {
      const node = host.querySelector<HTMLElement>(selector);
      if (!node) return [];
      const clone = node.cloneNode(true) as HTMLElement;
      clone.removeAttribute(selector.slice(1, -1));
      clone.setAttribute("aria-hidden", "true");
      clone.inert = true;
      return [{ node: clone, rect: node.getBoundingClientRect(), lift }];
    });
    launch.current = { at: performance.now(), text: new DOMRect(origin.left, origin.top), composer: composer.getBoundingClientRect(), exits };
  };

  useLayoutEffect(() => {
    const from = launch.current;
    if (isNewChat || !from) return;
    launch.current = null;
    const host = root.current;
    if (!host || performance.now() - from.at > LAUNCH_TTL_MS) return;
    for (const exit of from.exits) playExit(host, exit);
    const composer = host.querySelector<HTMLElement>("[data-composer-wrap]");
    if (composer) {
      const drop = from.composer.top - composer.getBoundingClientRect().top;
      if (Math.abs(drop) > 1)
        composer.animate([{ transform: `translateY(${drop}px)` }, { transform: "none" }], { duration: SEND_LAUNCH_MS - 80, easing: SEND_LAUNCH_EASE });
    }
    const bubble = lastUserBubble(host);
    if (!bubble) return;
    const { x, y } = launchOffset(from.text, contentOrigin(bubble));
    const article = bubble.closest<HTMLElement>('[data-slot="message"]');
    article?.setAttribute("data-send-launch", "");
    const flight = bubble.animate(
      [
        { transform: `translate(${x}px, ${y}px)`, backgroundColor: "transparent" },
        { offset: 0.35, backgroundColor: "var(--field)" },
        { transform: "none", backgroundColor: "var(--field)" },
      ],
      { duration: SEND_LAUNCH_MS, easing: SEND_LAUNCH_EASE },
    );
    void flight.finished.catch(() => {}).finally(() => article?.removeAttribute("data-send-launch"));
  }, [isNewChat, root]);

  return capture;
}
