import { useCallback, useMemo, useState } from "react";
import type { ChatMessage, WorktreeBinding } from "@milagre/shared/model";
import { chatPullRequests, pullRequestRefs, withPreview } from "@milagre/shared/chats";
import type { Client } from "./client";
import { pullRequestPresentation, rowPullRequests } from "@milagre/shared/pr-blockers";
import { usePrDetail } from "./pr-store";
import { openThreads } from "@milagre/shared/pull-request-review";
import { type PrChoice } from "./pr-chat";
import { useChatPullRequests } from "./use-chat-pull-requests";
import { useChatPage } from "./chat-pages";

import type { Session } from "./session";

const NO_MEMBERS: WorktreeBinding[] = [];
const NO_REFS: string[] = [];
export function useChatTranscriptData({
  session,
  connected,
  projectPath,
  params,
  targetMatches,
  mentionState,
  pending,
  pendingCanonicalId,
  scrollKey,
}: {
  session: Session;
  connected: Client | null;
  projectPath: string | undefined;
  params: { id?: string };
  targetMatches: boolean;
  mentionState: Parameters<typeof useChatPage>[3];
  pending: { preview: Parameters<typeof withPreview>[1] } | null | undefined;
  pendingCanonicalId: number | null;
  scrollKey: string;
}) {
  const allMessages = session.snapshot?.project.state.messages;
  const lean = !!session.snapshot?.project.state.messagesInChats;
  const page = useChatPage(lean && targetMatches ? connected : null, projectPath, params.id ? Number(params.id) : null, mentionState, session.reconnects);
  const canonicalPage = useChatPage(
    lean && targetMatches && pendingCanonicalId !== null ? connected : null,
    projectPath,
    pendingCanonicalId,
    mentionState,
    session.reconnects,
  );
  const media = useCallback((path: string) => connected!.image(projectPath!, path), [connected, projectPath]);
  const savedMessages = useMemo(
    () => (lean ? page.messages : params.id && allMessages ? allMessages.filter((m) => m.session_id === Number(params.id)) : []),
    [lean, page.messages, allMessages, params.id],
  );
  const loadedMessages = useMemo(
    () =>
      pending
        ? pendingCanonicalId !== null
          ? lean
            ? canonicalPage.messages
            : (allMessages || []).filter((message) => message.session_id === pendingCanonicalId)
          : withPreview(savedMessages, pending.preview)
        : savedMessages,
    [pending, pendingCanonicalId, lean, canonicalPage.messages, allMessages, savedMessages],
  );
  const historyPage = pendingCanonicalId !== null ? canonicalPage : page;
  const [transcript, setTranscript] = useState({ key: scrollKey, messages: loadedMessages });
  const messages = lean && historyPage.loading && !loadedMessages.length && transcript.key === scrollKey ? transcript.messages : loadedMessages;
  if (transcript.key !== scrollKey || transcript.messages !== messages) setTranscript({ key: scrollKey, messages });
  return { lean, media, historyPage, messages };
}

export function useChatPrs({
  session,
  chatsHomeOpen,
  worktreeOf,
  params,
  messages,
}: {
  session: Session;
  chatsHomeOpen: boolean;
  worktreeOf: { path: string } | null | undefined;
  params: { id?: string };
  messages: ChatMessage[];
}) {
  const prPath = session.snapshot?.project.link || chatsHomeOpen ? undefined : worktreeOf?.path;
  const openChat = params.id ? session.snapshot?.project.state.sessions[Number(params.id)] : undefined;
  const savedPrRefs = openChat ? (openChat.summary?.pullRequests ?? session.snapshot?.project.pullRequestRefs?.[openChat.id]) : undefined;
  const prRefs = useMemo(() => (openChat ? (savedPrRefs ?? pullRequestRefs(messages)) : []), [openChat, savedPrRefs, messages]);
  const linkView = session.snapshot?.project.link;
  const linkMembers = (linkView && params.id ? linkView.state.sessions[params.id]?.worktrees : undefined) ?? NO_MEMBERS;
  const prStatus = useChatPullRequests(
    session.client,
    prPath ? [{ path: prPath, refs: prRefs }] : linkMembers.map((member) => ({ path: member.worktreePath, refs: NO_REFS })),
  );
  const chatPrs = prPath ? chatPullRequests(prRefs, prStatus[prPath]?.found ?? {}, prStatus[prPath]?.branch) : [];
  const linkPrs = linkMembers.flatMap((member) => {
    const branch = prStatus[member.worktreePath]?.branch;
    return branch
      ? [
          {
            pr: branch,
            cwd: member.worktreePath,
            project: linkView?.projects.find((entry) => entry.id === member.projectId)?.name,
            projectPath: member.projectPath,
          },
        ]
      : [];
  });
  const rowPrs = rowPullRequests(prPath ? chatPrs : linkPrs.map((entry) => entry.pr));
  const pr = rowPrs[0] ?? null;
  const placeOf = (entry: (typeof rowPrs)[number]) => linkPrs.find((place) => place.pr === entry);
  const prCwd = pr ? (prPath ?? placeOf(pr)?.cwd) : undefined;
  const prChoicesJson = JSON.stringify(
    rowPrs.map((entry) => {
      const place = prPath ? undefined : placeOf(entry);
      const { number, title, state } = entry;
      const { tone, icon } = pullRequestPresentation(entry);
      return {
        number,
        title,
        state,
        look: { tone, icon },
        ...(place ? { cwd: place.cwd, projectPath: place.projectPath, ...(place.project ? { project: place.project } : {}) } : {}),
      };
    }),
  );
  const prChoices = useMemo(() => JSON.parse(prChoicesJson) as PrChoice[], [prChoicesJson]);
  const prDetail = usePrDetail(session.client, prCwd, pr?.number ?? Number.NaN, pr?.state === "OPEN");
  const prOpenThreads = pr && prDetail.pr?.state === "OPEN" && prDetail.pr.number === pr.number ? openThreads(prDetail.pr).length : 0;
  return { prPath, chatPrs, rowPrs, pr, placeOf, prCwd, prChoices, prOpenThreads };
}
