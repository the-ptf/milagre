export function requestSideQuestion(chatId: string) {
  window.dispatchEvent(new CustomEvent("milagre:side-question", { detail: chatId }));
}
