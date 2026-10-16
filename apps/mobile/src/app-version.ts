import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Updates from "expo-updates";

/**
 * The line under Settings that says what is running: the app version, its native build number, the runtime hash an
 * update must match, and, while a downloaded update runs, that update's commit (`update:testflight` sets
 * EXPO_PUBLIC_GIT_COMMIT; an update published without it shows its id). Parts the build doesn't know are left out.
 */
export function appVersionLine(): string {
  const build = Platform.OS === "ios" ? Constants.platform?.ios?.buildNumber : Constants.platform?.android?.versionCode;
  const update = Updates.isEnabled && !Updates.isEmbeddedLaunch ? process.env.EXPO_PUBLIC_GIT_COMMIT?.trim() || Updates.updateId?.slice(0, 8) : undefined;
  return [Constants.expoConfig?.version, build, Updates.runtimeVersion?.slice(0, 8), update]
    .filter((part) => part !== undefined && part !== null && `${part}` !== "")
    .join(" · ");
}
