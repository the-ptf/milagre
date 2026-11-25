const EVENT = "milagre:github-issue-picker";
const WAIT_MS = 5_000;
let requestedAt = 0;

/** Asks the new Chat header to open its GitHub issue picker, now or as soon as one mounts with the chip. */
export function requestGithubIssuePicker() {
  requestedAt = Date.now();
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Calls `open` while a request is pending; `open` answers whether it opened the picker, which settles the request. */
export function onGithubIssuePickerRequest(open: () => boolean) {
  const handle = () => {
    if (requestedAt && Date.now() - requestedAt < WAIT_MS && open()) requestedAt = 0;
  };
  handle();
  window.addEventListener(EVENT, handle);
  return () => window.removeEventListener(EVENT, handle);
}
