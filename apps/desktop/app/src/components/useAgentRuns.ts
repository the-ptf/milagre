import { useCallback, useEffect, useRef, useState } from "react";
import { LOCAL_COMPUTER, computerOfKey } from "@milagre/shared/chat-scopes";
import type { ChatSendRequest, CoordinatorState, LinkState, PermissionDecision, QuestionAnswers, QuestionImages } from "../model";
import {
  applyRunEvents,
  clearAnswered,
  createCoalescer,
  dropComputerRuns,
  eventIsNew,
  isUrgentRunEvent,
  markAnswered,
  projectOfKey,
  replaceComputerEntries,
} from "../lib/agent-runs";
import { answerSummary } from "../lib/question-answers";
import { createRunTextStore, onlyTextChanged } from "../lib/run-text";
import { stateEvents } from "../lib/state-events";
import { bridgeFor, bridgeForKey } from "../lib/computer-bridge";
import { useComputers } from "../lib/computers";
import type { AgentRuns, QueuedRunEvent, SentAnswer } from "../lib/agent-runs";

export function useAgentRuns(onState: (projectPath: string, state: CoordinatorState | LinkState) => void, modelFor: (chatId: string) => string = () => "") {
  const [runs, setRuns] = useState<AgentRuns>({});
  const runsRef = useRef(runs);
  const onStateRef = useRef(onState);
  const modelForRef = useRef(modelFor);
  onStateRef.current = onState;
  modelForRef.current = modelFor;

  const [text] = useState(() => createRunTextStore((chatKey) => runsRef.current[chatKey]?.text));
  const setAll = useCallback(
    (next: AgentRuns) => {
      const previous = runsRef.current;
      runsRef.current = next;
      setRuns(next);
      text.notify([...Object.keys(previous), ...Object.keys(next)].filter((key) => previous[key]?.text !== next[key]?.text));
    },
    [text],
  );
  const [events] = useState(() =>
    createCoalescer<QueuedRunEvent>((batch) => {
      const previous = runsRef.current;
      const next = applyRunEvents(previous, batch);
      if (next === previous) return;
      if (!onlyTextChanged(previous, batch)) return setAll(next);
      runsRef.current = next;
      text.notify(batch.map(({ chatId }) => chatId));
    }),
  );
  const taken = useRef(new Map<string, number>());
  const generation = useRef(new Map<string, number>());
  const take = useCallback(
    (computerId: string, snapshot: { runs: AgentRuns; seq: number }) => {
      events.flush();
      generation.current.set(computerId, (generation.current.get(computerId) ?? 0) + 1);
      taken.current.set(computerId, snapshot.seq);
      setAll(replaceComputerEntries(runsRef.current, computerId, snapshot.runs));
    },
    [events, setAll],
  );

  useEffect(() => {
    let recovered = false;
    const unsubscribe = stateEvents.onAgentEvent(({ chatId, event, state, seq }) => {
      if (eventIsNew(taken.current, chatId, seq))
        events.push({ chatId, event, model: event.type === "turn-started" ? modelForRef.current(chatId) : "" }, Boolean(state) || isUrgentRunEvent(event));
      else if (state) events.flush();
      if (state) onStateRef.current(projectOfKey(chatId), state);
    });
    const recover = window.milagre.onRuntimeSnapshot?.((snapshot) => {
      recovered = true;
      take(LOCAL_COMPUTER, snapshot.runs);
    });
    const recoverRemote = window.milagre.onComputerEvent?.((event) => {
      if (event.channel === "runtime:snapshot" && event.payload?.runs) take(event.computerId, event.payload.runs);
    });
    void window.milagre
      .getRuns()
      .then((snapshot) => {
        if (!recovered) take(LOCAL_COMPUTER, snapshot);
      })
      .catch(() => {});
    return () => {
      recovered = true;
      events.dispose();
      unsubscribe();
      recover?.();
      recoverRemote?.();
    };
  }, [events, take]);

  const { computers } = useComputers();
  const online = computers
    .filter((computer) => computer.state === "online")
    .map((computer) => computer.id)
    .join("\n");
  const known = computers.map((computer) => computer.id).join("\n");
  const away = computers
    .filter((computer) => computer.state !== "online" && computer.state !== "connecting" && computer.state !== "reconnecting")
    .map((computer) => computer.id)
    .join("\n");
  useEffect(() => {
    for (const id of online.split("\n").filter(Boolean)) {
      const asked = generation.current.get(id) ?? 0;
      void bridgeFor(id)
        .getRuns()
        .then((snapshot) => {
          if ((generation.current.get(id) ?? 0) === asked) take(id, snapshot);
        })
        .catch(() => {});
    }
  }, [online, take]);
  useEffect(() => {
    if (!away) return;
    events.flush();
    let next = runsRef.current;
    for (const id of away.split("\n").filter(Boolean)) {
      if (!Object.keys(next).some((key) => computerOfKey(key) === id)) continue;
      next = dropComputerRuns(next, id);
      taken.current.delete(id);
      generation.current.set(id, (generation.current.get(id) ?? 0) + 1);
    }
    if (next !== runsRef.current) setAll(next);
  }, [away, events, setAll]);
  useEffect(() => {
    const ids = new Set(known.split("\n").filter(Boolean));
    events.flush();
    let next = runsRef.current;
    for (const key of Object.keys(next)) {
      const id = computerOfKey(key);
      if (id !== LOCAL_COMPUTER && !ids.has(id)) {
        next = dropComputerRuns(next, id);
        taken.current.delete(id);
        generation.current.set(id, (generation.current.get(id) ?? 0) + 1);
      }
    }
    if (next !== runsRef.current) setAll(next);
  }, [events, known, setAll]);

  const send = useCallback((request: ChatSendRequest) => bridgeForKey(request.projectPath).sendMessage(request), []);

  const interrupt = useCallback((chatId: string) => bridgeForKey(chatId).interruptAgent(chatId), []);

  const answer = useCallback(
    async (chatId: string, requestId: string, sent: SentAnswer, deliver: () => Promise<boolean>) => {
      events.flush();
      setAll(markAnswered(runsRef.current, chatId, requestId, sent));
      try {
        const accepted = await deliver();
        if (!accepted) {
          events.flush();
          setAll(clearAnswered(runsRef.current, chatId, requestId));
        }
        return accepted;
      } catch (error) {
        events.flush();
        setAll(clearAnswered(runsRef.current, chatId, requestId));
        throw error;
      }
    },
    [events, setAll],
  );

  const respond = useCallback(
    (chatId: string, requestId: string, decision: PermissionDecision) =>
      answer(chatId, requestId, decision, () => bridgeForKey(chatId).respondToPermission(chatId, requestId, decision)),
    [answer],
  );

  const answerQuestion = useCallback(
    (chatId: string, requestId: string, answers: QuestionAnswers | null, images?: QuestionImages, suggestionId?: string) => {
      const request = runsRef.current[chatId]?.questions.find((item) => item.requestId === requestId);
      const summary = answers && request ? answerSummary(request.questions, answers, images) : "";
      const attached = answers && images ? images : undefined;
      return answer(chatId, requestId, answers ? "answered" : "dismissed", () =>
        suggestionId
          ? bridgeForKey(chatId).answerQuestion(chatId, requestId, answers, summary, attached, suggestionId)
          : attached
            ? bridgeForKey(chatId).answerQuestion(chatId, requestId, answers, summary, attached)
            : bridgeForKey(chatId).answerQuestion(chatId, requestId, answers, summary),
      );
    },
    [answer],
  );

  const dismissSuggestion = useCallback((chatId: string, id: string) => bridgeForKey(chatId).dismissSuggestion(chatId, id), []);

  return { runs, text, send, interrupt, respond, answerQuestion, dismissSuggestion };
}
