import { Platform } from "react-native";
import type { SentFrom } from "@milagre/shared/model";

/** What this device's messages say they came from, so the Chat's agent doesn't ask for this computer's folders or apps. */
export const SENT_FROM: SentFrom = Platform.OS === "ios" && Platform.isPad ? "tablet" : "phone";
