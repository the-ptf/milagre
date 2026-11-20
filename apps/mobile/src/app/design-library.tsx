import { useLocalSearchParams } from "expo-router";
import { DesignLibraryScreen } from "../design-library-page";

export default function DesignLibraryRoute() {
  const { hostId, path, name } = useLocalSearchParams<{ hostId?: string; path?: string; name?: string }>();
  return <DesignLibraryScreen key={`${hostId}:${path}`} hostId={hostId} path={path} name={name} />;
}
