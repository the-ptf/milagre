import { Platform } from "react-native";
import type { SentFrom } from "@milagre/shared/model";

export const SENT_FROM: SentFrom = Platform.OS === "ios" && Platform.isPad ? "tablet" : "phone";
