let current = "";
/** A message can run to thousands of words, so the Select text sheet reads it here instead of from route params. */
export function setSelectableText(text: string) {
  current = text;
}
export function selectableText() {
  return current;
}
