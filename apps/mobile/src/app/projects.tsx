import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Redirect, Stack, router, useLocalSearchParams } from "expo-router";
import { useSession } from "../session";
import { ProjectNavigation } from "../project-navigation";
import { ErrorNotice, useStyles } from "../ui";
import { LoadingLogo } from "../loading-logo";

export default function ProjectsScreen() {
  const styles = useStyles();
  const session = useSession();
  const { resume } = useLocalSearchParams<{ resume?: string }>();
  const attempted = useRef(false);
  const [restoring, setRestoring] = useState(resume === "1" && !!session.lastLocation && session.lastLocation.hostId === session.client?.url);
  const [error, setError] = useState("");
  useEffect(() => {
    if (attempted.current || !session.client) return;
    attempted.current = true;
    const target = session.lastLocation;
    if (resume !== "1" || !target || target.hostId !== session.client.url) return;
    let cancelled = false;
    void session
      .open(target.projectPath)
      .then((copy) => {
        if (cancelled || !copy) return;
        const chat = copy.project.state.sessions[target.chatId];
        if (chat && !chat.archived)
          router.replace({ pathname: "/chat", params: { id: String(chat.id), projectPath: copy.project.path, hostId: target.hostId } });
      })
      .catch(() => {
        if (!cancelled) setError("Could not reopen your last Chat. Choose a project below to continue.");
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session.client]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!session.client) return <Redirect href="/" />;
  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      {restoring ? (
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel="Reopening your Chat..."
          style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: 12 }}
        >
          <LoadingLogo size={64} />
          <Text style={styles.muted}>Reopening your Chat...</Text>
        </View>
      ) : (
        <>
          {error ? (
            <View style={{ paddingHorizontal: 16, paddingTop: 60 }}>
              <ErrorNotice message={error} />
            </View>
          ) : null}
          <ProjectNavigation onNavigate={(href, secondary) => (secondary ? router.push(href) : router.replace(href))} />
        </>
      )}
    </View>
  );
}
