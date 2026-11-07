/**
 * What's open on top of the app: a native dialog shown with showModal (the command palette, the image viewer)
 * or a panel marked aria-modal (the commit dialog, the handoff brief). Approval and question cards and the
 * chip popovers use role="dialog" too, but they are not modal: the app's shortcuts keep working over them.
 * The full-page design editor also owns focus so a Chat shortcut cannot discard its drafts.
 */
const MODAL_SELECTOR = '[aria-modal="true"], [data-focus-scope="design-editor"]';

/** The open modal, if any. */
export function openModal(root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>("dialog[open]") ?? root.querySelector<HTMLElement>(MODAL_SELECTOR);
}

export function isModalOpen(root: ParentNode = document): boolean {
  return openModal(root) !== null;
}

/**
 * Whether a modal is open that the app's own shortcuts (⌘K, ⌘N, …) must not act behind. The Settings modal doesn't
 * count: over it ⌘K opens the palette on top, and any other app shortcut closes Settings and runs in the Chat.
 */
export function appShortcutsBlocked(root: ParentNode = document): boolean {
  for (const dialog of root.querySelectorAll<HTMLElement>("dialog[open]")) if (!dialog.hasAttribute("data-settings-modal")) return true;
  return root.querySelector(MODAL_SELECTOR) !== null;
}
