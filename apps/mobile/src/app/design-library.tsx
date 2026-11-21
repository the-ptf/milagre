import { useLocalSearchParams } from "expo-router";
import { DesignLibraryScreen } from "../design-library-page";

export default function DesignLibraryRoute() {
  const { hostId, path, name, library, id } = useLocalSearchParams<{ hostId?: string; path?: string; name?: string; library?: string; id?: string }>();
  return <DesignLibraryScreen key={`${hostId}:${path}`} hostId={hostId} path={path} name={name} page={library} id={id} />;
}
