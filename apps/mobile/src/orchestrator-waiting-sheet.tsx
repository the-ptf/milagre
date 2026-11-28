import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import {
  Alert02Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  BubbleChatQuestionIcon,
  Cancel01Icon,
  Folder01Icon,
  ShieldAlertIcon,
} from "@hugeicons/core-free-icons";
import type { OrchestratorTask } from "@milagre/shared/orchestrator";
import type { QuestionRequest } from "@milagre/shared/model";
import { asksInComposer } from "@milagre/shared/question-composer";
import { allComputers } from "./all-computers";
import { prepareAnswerImages } from "./attachments";
import { ComposerQuestion } from "./composer-question";
import { lineHeight, radius, space, type } from "./design-tokens";
import { Icon } from "./icons";
import { openTaskChat, taskChatKey, taskHost } from "./orchestrator-actions";
import { columnItems, projectName, type BoardItem } from "./orchestrator-board";
import type { OrchestratorStore } from "./orchestrator-store";
import { Approval } from "./questions";
import { useSession, type Session } from "./session";
import { useTheme } from "./theme";
import { CircleButton, ErrorNotice, IconButton, PillButton, SheetHeader, useSheetBottomInset } from "./ui";
import { useOrchestrator } from "./use-orchestrator";
import { useOrchestratorBoard } from "./use-orchestrator-board";
import { routableProjects, useOrchestratorProjects } from "./use-orchestrator-lists";

const CAUGHT_UP_MS = 1100;
const NO_TASKS: OrchestratorTask[] = [];

type Projects = readonly { path: string; name?: string }[];
type Act = (run: () => Promise<unknown>) => void;

const sentId = (item: BoardItem) => `${item.task.id}:${item.ask ? item.ask.request.requestId : item.kind}`;

function kindIcon(item: BoardItem) {
  if (item.kind === "needs-project") return Folder01Icon;
  if (item.ask?.kind === "approval") return ShieldAlertIcon;
  if (item.ask?.kind === "question") return BubbleChatQuestionIcon;
  return Alert02Icon;
}

function projectQuestion(item: BoardItem, projects: Projects): QuestionRequest {
  return {
    requestId: `project:${item.task.id}`,
    questions: [
      {
        id: "project",
        header: "Project",
        question: "Which Project is this for?",
        options: projects.map((project) => ({ label: projectName(project.path, projects) })),
        multiSelect: false,
        allowOther: false,
        secret: false,
      },
    ],
  };
}

function taskClient(task: OrchestratorTask, session: Session) {
  const here = session.client?.url;
  const at = taskHost(task, here, allComputers.views());
  if (!at) throw new Error(`Pair ${task.computer ?? "that computer"} with this phone to answer it.`);
  const client = at === here ? session.client : allComputers.clientFor(at);
  if (!client) throw new Error("Reconnect to answer it.");
  return client;
}

function Body({ item, projects, store, busy, act }: { item: BoardItem; projects: Projects; store: OrchestratorStore; busy: boolean; act: Act }) {
  const { colors } = useTheme();
  const session = useSession();
  const { task, ask } = item;
  const chatId = taskChatKey(task);
  const field = session.client ? { client: session.client, projectPath: task.projectPath ?? "", provider: task.provider ?? undefined } : null;
  if (item.kind === "needs-project" && field)
    return (
      <ComposerQuestion
        request={projectQuestion(item, projects)}
        busy={busy}
        initialAnswers={{}}
        bare
        field={field}
        submit={(answers) => {
          const project = projects.find((entry) => projectName(entry.path, projects) === answers?.project?.[0]);
          act(() => (project ? store.act("orchestrator:task:project", [task.id, project.path]) : store.act("orchestrator:task:dismiss", [task.id])));
        }}
      />
    );
  if (item.kind === "failed")
    return (
      <View style={{ gap: space.md }}>
        <Text style={{ color: colors.redInk, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>{item.detail}</Text>
        <View style={{ flexDirection: "row", gap: space.md }}>
          <PillButton
            title="Re-route"
            size="small"
            variant="secondary"
            disabled={busy}
            onPress={() => act(() => store.act("orchestrator:task:reroute", [task.id, {}]))}
          />
          <PillButton
            title="Dismiss"
            size="small"
            variant="plain"
            disabled={busy}
            onPress={() => act(() => store.act("orchestrator:task:dismiss", [task.id]))}
          />
        </View>
      </View>
    );
  if (chatId && field && ask?.kind === "question" && asksInComposer(ask.request))
    return (
      <ComposerQuestion
        key={ask.request.requestId}
        request={ask.request}
        busy={busy}
        initialAnswers={{}}
        bare
        field={field}
        submit={(answers, summary, images) =>
          act(async () => {
            const client = taskClient(task, session);
            const uploaded = answers ? await prepareAnswerImages(client, task.projectPath ?? "", images) : undefined;
            return client.call("agent:answer-question", [
              { chatId, requestId: ask.request.requestId, answers, summary, ...(uploaded ? { images: uploaded } : {}) },
            ]);
          })
        }
      />
    );
  if (chatId && ask?.kind === "approval")
    return (
      <Approval
        approval={ask.request}
        busy={busy}
        respond={(decision) => act(() => taskClient(task, session).call("agent:respond-permission", [{ chatId, requestId: ask.request.requestId, decision }]))}
      />
    );
  return <Text style={{ color: colors.ink2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>{item.detail}</Text>;
}

/** Every Orchestrator task that needs the user, one at a time, answered with the Chat composer's own question card. */
export function OrchestratorWaitingSheet() {
  const { colors } = useTheme();
  const session = useSession();
  const bottom = useSheetBottomInset();
  const { snapshot, store } = useOrchestrator(session.client);
  const listed = useOrchestratorProjects(session.client);
  const { items } = useOrchestratorBoard(snapshot?.settings.enabled ? snapshot.tasks : NO_TASKS);
  const [sent, setSent] = useState<ReadonlySet<string>>(() => new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const shown = columnItems(items, "needs").filter((item) => !sent.has(sentId(item)));
  const at = Math.max(
    0,
    shown.findIndex((entry) => entry.task.id === focus),
  );
  const item = shown[at];
  const ready = Boolean(snapshot);
  useEffect(() => {
    if (item || !ready) return;
    const timer = setTimeout(() => router.back(), CAUGHT_UP_MS);
    return () => clearTimeout(timer);
  }, [item, ready]);
  const move = (by: number) => {
    setFocus(shown[(at + by + shown.length) % shown.length]?.task.id ?? null);
    setError("");
  };
  const act: Act = (run) => {
    if (pending.current || !item) return;
    const id = sentId(item);
    const rest = shown.filter((entry) => entry !== item);
    const next = rest[Math.min(at, rest.length - 1)]?.task.id ?? null;
    pending.current = true;
    setBusy(true);
    setError("");
    void (async () => {
      try {
        if ((await run()) === false) throw new Error("This is no longer waiting.");
        setSent((previous) => new Set(previous).add(id));
        setFocus(next);
      } catch (failure) {
        setError((failure as Error).message || "Couldn't send your answer.");
      } finally {
        pending.current = false;
        setBusy(false);
      }
    })();
  };
  const projects = routableProjects(listed, session.recent);
  const title = !item ? (snapshot?.settings.name ?? "Orchestrator") : shown.length === 1 ? "Needs you" : `${shown.length} waiting`;
  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: bottom }}>
      <SheetHeader title={title} leading={<CircleButton label="Close" icon={Cancel01Icon} onPress={() => router.back()} />} />
      {item && store ? (
        <View style={{ paddingHorizontal: space.gutter, paddingTop: space.md, gap: space.lg }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Icon icon={kindIcon(item)} tone={item.kind === "failed" ? "red" : "orange"} size={16} />
            <Text numberOfLines={1} style={{ flex: 1, color: colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "600" }}>
              {item.task.title}
            </Text>
            {shown.length > 1 && (
              <>
                <Text style={{ color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontVariant: ["tabular-nums"] }}>
                  {at + 1} of {shown.length}
                </Text>
                <IconButton label="Previous" icon={ArrowLeft01Icon} size={32} onPress={() => move(-1)} />
                <IconButton label="Next" icon={ArrowRight01Icon} size={32} onPress={() => move(1)} />
              </>
            )}
          </View>
          <Body key={sentId(item)} item={item} projects={projects} store={store} busy={busy} act={act} />
          {error ? <ErrorNotice message={error} /> : null}
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md }}>
            <Text numberOfLines={1} style={{ flex: 1, color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
              {item.task.projectPath ? projectName(item.task.projectPath, projects) : "No Project yet"}
            </Text>
            {item.task.sessionId !== null && (
              <PillButton
                title="Open task Chat"
                size="small"
                variant="plain"
                icon={ArrowUpRight01Icon}
                onPress={() => void openTaskChat(item.task, session, { fromSheet: true }).catch((failure: Error) => setError(failure.message))}
              />
            )}
          </View>
        </View>
      ) : (
        <View style={{ alignItems: "center", padding: space.xxl, borderRadius: radius.card }}>
          <Text style={{ color: colors.ink, fontSize: type.body, lineHeight: lineHeight.body, fontWeight: "600" }}>{ready ? "All caught up" : "Loading…"}</Text>
        </View>
      )}
    </ScrollView>
  );
}
