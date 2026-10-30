import { useLocalSearchParams } from "expo-router";
import { ArtifactSheet } from "../artifact";
import { DesignsSheet } from "../designs-sheet";

export default function ArtifactScreen() {
  const { hostId, chatId, id, version, chosen, kind, tab, comment, requestId } = useLocalSearchParams<{
    hostId?: string;
    chatId?: string;
    id?: string;
    version?: string;
    chosen?: string;
    kind?: string;
    tab?: string;
    comment?: string;
    requestId?: string;
  }>();
  // A Chat's designs open on their canvas; its one HTML artifact keeps the page sheet.
  if (kind === "html")
    return (
      <ArtifactSheet key={`${hostId}:${chatId}:${id}`} hostId={hostId} chatId={chatId} id={id} kind={kind} tab={tab} comment={comment} requestId={requestId} />
    );
  return <DesignsSheet key={`${hostId}:${chatId}:${id}`} hostId={hostId} chatId={chatId} id={id} version={version} chosen={chosen} />;
}
