import { ipcErrorMessage } from "@milagre/shared/result";
export async function reportChatAction(action: Promise<unknown>, label: string, notice: (text: string) => void): Promise<void> {
  try {
    await action;
  } catch (error) {
    notice(`${label}: ${ipcErrorMessage(error)}`);
  }
}
