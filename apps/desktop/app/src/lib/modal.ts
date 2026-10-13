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
