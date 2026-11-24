import { useLocalSearchParams } from "expo-router";
import { ArtifactSheet } from "../artifact";
import { DesignsSheet } from "../designs-sheet";
import { LibrarySheet } from "../library-sheet";

export default function ArtifactScreen() {
  const { hostId, chatId, projectPath, id, version, chosen, kind, library, tab, comment, requestId } = useLocalSearchParams<{
    hostId?: string;
    chatId?: string;
    projectPath?: string;
    id?: string;
    version?: string;
    chosen?: string;
    kind?: string;
    library?: string;
    tab?: string;
    comment?: string;
    requestId?: string;
  }>();
  if (library)
    return (
      <LibrarySheet
        key={`${hostId}:${chatId ?? projectPath}:library:${library}`}
        hostId={hostId}
        chatId={chatId}
        projectPath={projectPath}
        page={library}
        id={id}
      />
    );
  if (kind === "html")
    return (
      <ArtifactSheet key={`${hostId}:${chatId}:${id}`} hostId={hostId} chatId={chatId} id={id} kind={kind} tab={tab} comment={comment} requestId={requestId} />
    );
  return (
    <DesignsSheet
      key={`${hostId}:${chatId}:${id}`}
      hostId={hostId}
      chatId={chatId}
      id={id}
      version={version}
      chosen={chosen}
      comment={comment}
      requestId={requestId}
    />
  );
}
