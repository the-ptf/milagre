import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { createAgentRunsStore, onlyTextChanged } from "../lib/agent-runs-store";
import { stateEvents } from "../lib/state-events";
import { bridgeFor, bridgeForKey } from "../lib/computer-bridge";
import { useComputers } from "../lib/computers";
import type { AgentRuns, QueuedRunEvent, SentAnswer } from "../lib/agent-runs";

/**
 * Agent runs live in a store, so a tool step re-renders only what shows it. An event that carries a Project's state
 * holds the store until the render with that state commits: `heldFor` is a render of this hook's owner, batched with
 * the state update (and with any other update the event made), and the store is released from its layout effect,
 * before that render paints. A run therefore never ends, starts or changes a frame before the transcript shows it.
 */
export function useAgentRuns(onState: (projectPath: string, state: CoordinatorState | LinkState) => void, modelFor: (chatId: string) => string = () => "") {
  const [store] = useState(createAgentRunsStore);
  const onStateRef = useRef(onState);
  const modelForRef = useRef(modelFor);
  onStateRef.current = onState;
  modelForRef.current = modelFor;

  const [heldFor, setHeldFor] = useState(0);
  const holds = useRef(0);
  const hold = useCallback(() => {
    store.hold();
    holds.current += 1;
    setHeldFor(holds.current);
  }, [store]);
  useLayoutEffect(() => {
    if (heldFor === holds.current) store.release();
  }, [heldFor, store]);

  const [events] = useState(() =>
    createCoalescer<QueuedRunEvent>((batch) => {
      const previous = store.latest();
      store.set(applyRunEvents(previous, batch), onlyTextChanged(previous, batch));
    }),
  );
  const taken = useRef(new Map<string, number>());
  const generation = useRef(new Map<string, number>());
  const take = useCallback(
    (computerId: string, snapshot: { runs: AgentRuns; seq: number }) => {
      events.flush();
      generation.current.set(computerId, (generation.current.get(computerId) ?? 0) + 1);
      taken.current.set(computerId, snapshot.seq);
      store.set(replaceComputerEntries(store.latest(), computerId, snapshot.runs));
    },
    [events, store],
  );

  useEffect(() => {
    let recovered = false;
    const unsubscribe = stateEvents.onAgentEvent(({ chatId, event, state, seq }) => {
      if (state) hold();
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
  }, [events, hold, take]);

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
    let next = store.latest();
    for (const id of away.split("\n").filter(Boolean)) {
      if (!Object.keys(next).some((key) => computerOfKey(key) === id)) continue;
      next = dropComputerRuns(next, id);
      taken.current.delete(id);
      generation.current.set(id, (generation.current.get(id) ?? 0) + 1);
    }
    if (next !== store.latest()) store.set(next);
  }, [away, events, store]);
  useEffect(() => {
    const ids = new Set(known.split("\n").filter(Boolean));
    events.flush();
    let next = store.latest();
    for (const key of Object.keys(next)) {
      const id = computerOfKey(key);
      if (id !== LOCAL_COMPUTER && !ids.has(id)) {
        next = dropComputerRuns(next, id);
        taken.current.delete(id);
        generation.current.set(id, (generation.current.get(id) ?? 0) + 1);
      }
    }
    if (next !== store.latest()) store.set(next);
  }, [events, known, store]);

  const send = useCallback((request: ChatSendRequest) => bridgeForKey(request.projectPath).sendMessage(request), []);

  const interrupt = useCallback((chatId: string) => bridgeForKey(chatId).interruptAgent(chatId), []);

  const answer = useCallback(
    async (chatId: string, requestId: string, sent: SentAnswer, deliver: () => Promise<boolean>) => {
      events.flush();
      store.set(markAnswered(store.latest(), chatId, requestId, sent));
      try {
        const accepted = await deliver();
        if (!accepted) {
          events.flush();
          store.set(clearAnswered(store.latest(), chatId, requestId));
        }
        return accepted;
      } catch (error) {
        events.flush();
        store.set(clearAnswered(store.latest(), chatId, requestId));
        throw error;
      }
    },
    [events, store],
  );

  const respond = useCallback(
    (chatId: string, requestId: string, decision: PermissionDecision) =>
      answer(chatId, requestId, decision, () => bridgeForKey(chatId).respondToPermission(chatId, requestId, decision)),
    [answer],
  );

  const answerQuestion = useCallback(
    (chatId: string, requestId: string, answers: QuestionAnswers | null, images?: QuestionImages, suggestionId?: string) => {
      const request = store.latest()[chatId]?.questions.find((item) => item.requestId === requestId);
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
    [answer, store],
  );

  const dismissSuggestion = useCallback((chatId: string, id: string) => bridgeForKey(chatId).dismissSuggestion(chatId, id), []);

  return { store, send, interrupt, respond, answerQuestion, dismissSuggestion };
}
