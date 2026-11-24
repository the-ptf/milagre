import { router } from "expo-router";

/** Opens the Design library page of the Project at `path` on the computer `hostId`, on the phone or the iPad. */
export function openDesignLibrary(hostId: string, path: string, name: string) {
  router.push({ pathname: "/design-library", params: { hostId, path, name } });
}
