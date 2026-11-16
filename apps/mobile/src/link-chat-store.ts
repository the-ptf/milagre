import type { LinkChat, LinkChoice } from "./chat-links";

type LinkQuestion = { source: LinkChat; target: LinkChat; choose: (choice: LinkChoice | null) => void };

let current: LinkQuestion | null = null;
let present: (() => void) | null = null;

export function setLinkPresenter(open: () => void) {
  present = open;
}
export function currentLinkQuestion() {
  return current;
}

export function askLinkChoice(source: LinkChat, target: LinkChat) {
  current?.choose(null);
  return new Promise<LinkChoice | null>((resolve) => {
    let done = false;
    const entry: LinkQuestion = {
      source,
      target,
      choose(choice) {
        if (done) return;
        done = true;
        if (current === entry) current = null;
        resolve(choice);
      },
    };
    current = entry;
    present?.();
  });
}
