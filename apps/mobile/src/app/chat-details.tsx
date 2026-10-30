import { useCallback, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Redirect, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useSession } from "../session";
import { ArchiveProgress } from "../archive-progress";
import { runChatAction } from "../chat-actions";
import { useLinks } from "../use-links";
import { endNamer, linkedLabels } from "../chat-links";
import { Button, ErrorNotice, Field, PageScroll, useStyles } from "../ui";

export default function ChatDetails() {
  const styles = useStyles();
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = useSession();
  const chat = session.snapshot?.project.state.sessions[Number(id)];
  const [title, setTitle] = useState(chat?.title || chat?.generatedTitle || "");
  const [busy, setBusy] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState("");
  const focused = useRef<object | null>(null);
  const projectPath = session.snapshot?.project.path;
  const links = useLinks(session.client);
  useFocusEffect(
    useCallback(() => {
      focused.current = { client: session.client, projectPath, id };
      return () => {
        focused.current = null;
      };
    }, [session.client, projectPath, id]),
  );
  if (!session.client || !session.snapshot || !chat) return <Redirect href="/" />;
  const { project, runs } = session.snapshot;
  const running = !!runs.runs[`${project.path}#${id}`];
  // The Worktrees a Link joins to this Chat's, named as on the chat list's Link icon. A shared Link Chat has none.
  const worktreePath = links.available && !project.link ? project.state.worktrees[chat.worktree_id]?.path : undefined;
  const projectId = worktreePath ? links.projectIdOf(project.path) : undefined;
  const linked = linkedLabels(
    links.links,
    projectId && worktreePath ? { project_id: projectId, worktree_path: worktreePath } : undefined,
    endNamer(links.projects, (path, worktree) => {
      const copy = path === project.path ? session.snapshot : session.cachedProject(path);
      return Object.values(copy?.project.state.worktrees ?? {}).find((item) => item.path === worktree)?.name;
    }),
  );
  async function save(patch: { title: string }) {
    const focus = focused.current;
    const current = () => focus !== null && focused.current === focus && session.isSelected();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await session.client!.call("chat:patch", [project.path, Number(id), patch]);
      if (!current()) return;
      await session.refresh();
      if (current()) router.back();
    } catch (error) {
      if (current()) setError((error as Error).message);
    } finally {
      setBusy(false);
      setArchiving(false);
    }
  }
  async function deleteChat() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await runChatAction({
        action: "archive",
        chat: chat!,
        running,
        client: session.client!,
        projectPath: project.path,
        state: project.state,
        link: project.link,
        chatsHome: project.kind === "chats",
        refresh: session.refresh,
        expectActivity: session.expectActivity,
        notify: setError,
        onConfirm: () => {
          setArchiving(true);
          router.replace("/projects");
        },
      });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
      setArchiving(false);
    }
  }
  return (
    <PageScroll>
      <Text style={styles.title}>Manage Chat</Text>
      <Field label="Chat name" value={title} onChangeText={setTitle} placeholder="Give this Chat a name" />
      <Button title="Save name" disabled={busy || !title.trim()} onPress={() => void save({ title: title.trim() })} />
      {linked.length > 0 && (
        <View style={{ gap: 6 }}>
          <Text accessibilityRole="header" style={styles.label}>
            Linked
          </Text>
          {linked.map(({ link, label }) => (
            <Text key={link.id} style={styles.text}>
              {label}
            </Text>
          ))}
        </View>
      )}
      <Button title="Delete Chat" secondary disabled={busy} onPress={() => void deleteChat()} />
      {archiving && <ArchiveProgress />}
      {error ? <ErrorNotice message={error} /> : null}
    </PageScroll>
  );
}
