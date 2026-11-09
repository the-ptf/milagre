import { Platform } from "react-native";
import * as Haptics from "expo-haptics";

export const tap = () => {
  if (Platform.OS === "ios") void Haptics.selectionAsync().catch(() => {});
};
