const { providerName } = require("@milagre/shared/providers");
const { randomUUID } = require("node:crypto");
const { ADVISOR_PROVIDERS, createInput, promptInput } = require("./advisor-tools.cjs");
const ACTIVE = new Set(["initializing", "running", "waiting"]);

function advisorRow(record) {
  const { id, title, prompt, status, provider, model, startedAt, updatedAt, endedAt, latestActivity, transcript, retryable } = record;
  return {
    id,
    title,
    prompt,
    status,
    provider,
    model,
    mode: record.mode ?? "analysis",
    startedAt,
    updatedAt,
    endedAt,
    latestActivity,
    transcript,
    retryable,
    source: "milagre-advisor",
  };
}
// A retried turn asks the original question again, with the last saved output, and the follow-up that stopped when it
// wasn't the first turn. Advisors saved before `question` existed retry their last prompt.
function retryPrompt(record) {
  const question = record.question ?? record.prompt;
  const request = record.request ?? question;
  return [
    ...(record.mode === "execution"
      ? [
          "This is a retry of interrupted execution. Inspect existing files and running processes before repeating any action; earlier attempts may have completed side effects.",
        ]
      : []),
    question,
    ...(record.output ? [`Previous saved output:\n${record.output}`] : []),
    ...(request !== question ? [`Follow-up that was interrupted:\n${request}`] : []),
  ].join("\n\n");
}

function createAdvisors({
  store,
  contextFor,
  providersFor,
  launch,
  publish = async () => {},
  completed = async () => {},
  captureOutput = async (_record, output) => output,
  now = Date.now,
}) {
  const sessions = new Map();
  const queues = new Map();
  const known = new Set();
  const epochs = new Map();
  const executionEpochs = new Map();
  const executionRevoked = new Set();
  const stops = new Map();
  let closed = false;
  const ticket = (chatId, id) => ({ epoch: epochs.get(chatId) ?? 0, executionEpoch: executionEpochs.get(chatId) ?? 0, stop: stops.get(id) ?? 0 });
  const admitted = (chatId, id, stamp, mode) =>
    !closed &&
    stamp.epoch === (epochs.get(chatId) ?? 0) &&
    stamp.stop === (stops.get(id) ?? 0) &&
    (mode !== "execution" || stamp.executionEpoch === (executionEpochs.get(chatId) ?? 0));
  function assertLaunch(chatId, id, stamp, mode) {
    if (!admitted(chatId, id, stamp, mode)) throw new Error("This advisor launch was stopped.");
  }
  function serial(chatId, work) {
    const run = (queues.get(chatId) ?? Promise.resolve()).catch(() => {}).then(work);
    queues.set(chatId, run);
    const forget = () => {
      if (queues.get(chatId) === run) queues.delete(chatId);
    };
    run.then(forget, forget);
    return run;
  }
  function checkExecution(chatId, mode, value) {
    if (mode === "execution" && (executionRevoked.has(chatId) || value.permissionMode !== "full"))
      throw new Error("Execution advisors require this Chat's Full permissions.");
  }
  async function context(chatId, record) {
    if (closed) throw new Error("The advisor host is shutting down.");
    const value = await contextFor(chatId);
    if (!value || value.archived || !value.cwd) throw new Error("This Chat is archived or its Worktree is unavailable.");
    if (record && record.scopeIdentity !== value.scopeIdentity) throw new Error("This Chat's Worktree scope changed. Start a new advisor.");
    checkExecution(chatId, record?.mode, value);
    return value;
  }
  async function own(chatId, id) {
    const found = (await store.read(chatId)).find((r) => r.id === id);
    if (!found) throw new Error("That advisor does not belong to this Chat.");
    return found;
  }
  async function save(chatId, id, change) {
    const records = await store.update(chatId, (rows) => rows.map((r) => (r.id === id ? change(r) : r)));
    return records.find((r) => r.id === id);
  }
  async function show(record) {
    await publish(record.chatId, advisorRow(record));
  }
  function closeEntry(entry, interrupt = false) {
    const session = entry?.session;
    if (!session) return entry?.closing?.promise ?? Promise.resolve();
    if (entry.closing?.session === session) return entry.closing.promise;
    const promise = Promise.resolve()
      .then(async () => {
        if (interrupt) await session.interrupt().catch(() => {});
        await session.close();
      })
      .finally(() => {
        if (entry.session === session) entry.session = null;
      });
    entry.closing = { session, promise };
    return promise;
  }
  async function capability(chatId, input, ctx, pinned) {
    // By default the advisor runs on a provider the Chat itself isn't on.
    const provider = input.provider ?? ADVISOR_PROVIDERS.find((candidate) => candidate !== ctx.parentProvider);
    const capabilities = await providersFor(chatId, pinned);
    const selected = capabilities[provider];
    if (!selected?.available || !selected.models?.length)
      throw new Error(`${providerName(provider)} is unavailable. Check its installation and Account in Settings.`);
    if (pinned && (selected.accountId ?? null) !== (pinned.accountId ?? null))
      throw new Error("The advisor Account is unavailable. Restore it or start a new advisor.");
    const model = input.model ? selected.models.find((m) => m.id === input.model) : (selected.models.find((m) => m.recommended) ?? selected.models[0]);
    if (!model) throw new Error("That model is unavailable. Use advisor_providers to choose a reported model.");
    if (input.effort && !model.efforts?.includes(input.effort)) throw new Error("That effort is unsupported for this model. Use advisor_providers.");
    const identity = {
      provider,
      model: model.id,
      accountId: selected.accountId ?? null,
      ...((input.effort ?? model.defaultEffort) ? { effort: input.effort ?? model.defaultEffort } : {}),
    };
    return { identity, selected };
  }
  async function slot(chatId, mode) {
    const active = (await store.read(chatId)).filter((r) => ACTIVE.has(r.status) || r.queuedPrompts.length);
    if (mode === "execution" && active.some((r) => r.mode === "execution"))
      throw new Error("An execution advisor is already active in this Chat. Stop it or wait for it to finish.");
    if (active.length >= 2) throw new Error("Two advisors are already active in this Chat. Stop one or wait for it to finish.");
  }
  function prepare(record, stamp, existing) {
    const entry = existing ?? { alive: true, session: null, events: Promise.resolve() };
    entry.busy = true;
    entry.output = "";
    entry.images = new Set();
    entry.chatId = record.chatId;
    entry.mode = record.mode ?? "analysis";
    entry.generation = Symbol();
    entry.ticket = stamp;
    sessions.set(record.id, entry);
    return entry;
  }
  function start(record, ctx, selected, entry) {
    const generation = entry.generation;
    const stamp = entry.ticket;
    const current = () => entry.alive && entry.generation === generation && admitted(record.chatId, record.id, stamp, record.mode);
    const emit = (event) => {
      if (!current()) return;
      entry.events = entry.events
        .then(async () => {
          if (!current()) return;
          if (record.mode === "execution" && event.type === "permission-request") {
            entry.session?.respondToPermission(event.requestId, "deny");
            return;
          }
          if (record.mode === "execution" && event.type === "question-request") {
            entry.session?.answerQuestion(event.requestId, null);
            return;
          }
          if (event.type === "session-started") {
            await save(record.chatId, record.id, (r) => ({ ...r, nativeId: event.nativeId }));
            return;
          }
          if (event.type === "text-delta") entry.output = (entry.output + event.text).slice(0, 40_000);
          if (record.mode === "execution" && event.step?.kind === "image" && event.step.file && entry.images.size < 16) entry.images.add(event.step.file);
          if (record.mode === "execution" && event.type === "step-completed" && event.file && entry.images.size < 16) entry.images.add(event.file);
          const terminal = ["turn-completed", "turn-failed", "turn-cancelled"].includes(event.type);
          let captured = entry.output || event.message || "";
          if (terminal) {
            try {
              captured = await captureOutput(record, captured, [...entry.images]);
            } catch (error) {
              console.warn("Advisor screenshots could not be saved:", error.message);
            }
            // Execution owns processes, so release them before its completed row releases the slot and Stop control.
            if (record.mode === "execution") await closeEntry(entry);
          }
          if (!current()) return;
          let next = await save(record.chatId, record.id, (r) => {
            const timestamp = now();
            if (terminal) {
              const status = event.type === "turn-completed" ? "completed" : event.type === "turn-failed" ? "failed" : "cancelled";
              const output =
                (typeof captured === "string" ? captured : captured.output) ||
                (status === "completed" ? "The advisor returned no text." : "The advisor was stopped.");
              const completionId = `${r.id}:${r.turnNumber}`;
              const result = {
                id: completionId,
                advisorId: r.id,
                title: r.title,
                provider: r.provider,
                mode: r.mode ?? "analysis",
                outcome: status,
                output,
                ...(captured.images?.length ? { images: captured.images } : {}),
                delivery: "pending",
              };
              return {
                ...r,
                status,
                output,
                completionId,
                delivery: "pending",
                updatedAt: timestamp,
                endedAt: timestamp,
                retryable: status !== "completed",
                transcript: [...r.transcript.filter((item) => item.id !== `stream:${r.turnNumber}`), { id: completionId, kind: "message", text: output }].slice(
                  -100,
                ),
                completions: [...(r.completions ?? []), result],
              };
            }
            const transcript =
              event.type === "text-delta"
                ? [
                    ...r.transcript.filter((item) => item.id !== `stream:${r.turnNumber}`),
                    { id: `stream:${r.turnNumber}`, kind: "message", text: entry.output },
                  ].slice(-100)
                : r.transcript;
            return {
              ...r,
              transcript:
                record.mode === "execution" && event.type === "step-started" && event.step
                  ? [...transcript, { id: event.step.id, kind: "tool", text: event.step.title, tool: event.step.kind }].slice(-100)
                  : transcript,
              status: "running",
              updatedAt: timestamp,
              latestActivity: event.type === "step-started" ? (event.step?.title ?? event.title) : r.latestActivity,
            };
          });
          if (!current()) return;
          // eslint-disable-next-line promise/no-callback-in-promise -- this is a host port, not a Node callback
          await show(next);
          if (!terminal) return;
          entry.busy = false;
          // eslint-disable-next-line promise/no-callback-in-promise -- this is a host port, not a Node callback
          await completed(record.chatId, next.completions.at(-1));
          await serial(record.chatId, async () => {
            if (!current()) return;
            next = await own(record.chatId, record.id);
            if (!next.queuedPrompts.length) return;
            let latest;
            try {
              latest = await context(record.chatId, next);
            } catch (error) {
              if (!current()) return;
              const note = `Queued follow-ups cancelled. ${error.message}`;
              next = await save(record.chatId, record.id, (r) =>
                current()
                  ? {
                      ...r,
                      status: "failed",
                      retryable: false,
                      queuedPrompts: [],
                      latestActivity: note,
                      updatedAt: now(),
                      transcript: [...r.transcript, { id: `scope-change:${r.turnNumber}`, kind: "message", text: note }].slice(-100),
                    }
                  : r,
              );
              if (!current()) return;
              entry.alive = false;
              // eslint-disable-next-line promise/no-callback-in-promise -- publishes durable state through the host port
              await show(next);
              await closeEntry(entry).catch(() => {});
              return;
            }
            if (!current()) return;
            const nextPrompt = next.queuedPrompts[0];
            next = await save(record.chatId, record.id, (r) => ({
              ...r,
              status: "initializing",
              prompt: nextPrompt,
              request: nextPrompt,
              queuedPrompts: r.queuedPrompts.slice(1),
              turnNumber: r.turnNumber + 1,
              updatedAt: now(),
              endedAt: undefined,
            }));
            // eslint-disable-next-line promise/no-callback-in-promise -- prepares a cancellable generation before publication, not a callback
            prepare(next, stamp, entry);
            // eslint-disable-next-line promise/no-callback-in-promise -- this is a host port, not a Node callback
            await show(next);
            // eslint-disable-next-line promise/no-callback-in-promise -- this is a host port, not a Node callback
            start(next, latest, selected, entry);
          });
        })
        .catch(async (error) => {
          entry.alive = false;
          await closeEntry(entry).catch(() => {});
          // Keep the last durable state for recovery. A failed save must never trigger parent delivery.
          console.warn("Advisor activity could not be saved:", error.message);
        });
    };
    entry.starting = Promise.resolve()
      .then(async () => {
        if (!current()) return;
        const latest = record.mode === "execution" ? await context(record.chatId, record) : ctx;
        if (!current()) return;
        entry.cwd = latest.cwd;
        if (!entry.session) entry.session = await launch({ record, context: latest, provider: selected, emit: (event) => entry.emit(event) });
        // Reused sessions need the current generation callback for follow-ups.
        entry.emit = emit;
        if (!current()) {
          await closeEntry(entry);
          return;
        }
        if (record.mode === "execution") await context(record.chatId, record);
        if (!current()) {
          await closeEntry(entry);
          return;
        }
        const request = {
          prompt: record.prompt,
          model: record.model,
          effort: record.launchIdentity.effort,
          permissionMode: record.mode === "execution" ? "full" : "ask",
          images: [],
        };
        await entry.session.startTurn(request);
      })
      .catch((error) => {
        emit({ type: "turn-failed", message: error.message });
      });
    // The transport's stable callback forwards to each turn's generation.
    entry.emit = emit;
  }
  const manager = {
    async providers(chatId) {
      await context(chatId);
      const all = await providersFor(chatId);
      return Object.fromEntries(
        ADVISOR_PROVIDERS.map((provider) => [
          provider,
          { available: all[provider]?.available === true, problem: all[provider]?.problem, models: all[provider]?.models ?? [] },
        ]),
      );
    },
    async create(chatId, value) {
      const input = createInput.parse(value);
      const stamp = ticket(chatId);
      return serial(chatId, async () => {
        known.add(chatId);
        const ctx = await context(chatId);
        checkExecution(chatId, input.mode, ctx);
        const { identity, selected } = await capability(chatId, input, ctx);
        await slot(chatId, input.mode);
        assertLaunch(chatId, undefined, stamp, input.mode);
        await context(chatId, { scopeIdentity: ctx.scopeIdentity, mode: input.mode });
        assertLaunch(chatId, undefined, stamp, input.mode);
        const timestamp = now();
        const record = {
          id: `advisor:${randomUUID()}`,
          chatId,
          scopeIdentity: ctx.scopeIdentity,
          launchIdentity: identity,
          provider: identity.provider,
          model: identity.model,
          mode: input.mode ?? "analysis",
          title: input.title,
          // The analysis-only rules are in the advisor's system prompt (events.cjs advisorInstructions).
          prompt: input.prompt,
          // What Retry asks again: the question the advisor was started with, and the request of the turn that stopped.
          question: input.prompt,
          request: input.prompt,
          status: "initializing",
          source: "milagre-advisor",
          startedAt: timestamp,
          updatedAt: timestamp,
          turnNumber: 1,
          queuedPrompts: [],
          output: "",
          transcript: [{ id: "prompt:1", kind: "message", text: input.prompt }],
          completions: [],
        };
        await store.update(chatId, (rows) => [...rows, record]);
        const entry = prepare(record, stamp);
        await show(record);
        start(record, ctx, selected, entry);
        return advisorRow(record);
      });
    },
    async read(chatId, id) {
      return structuredClone(await own(chatId, id));
    },
    async followup(chatId, id, value) {
      const prompt = promptInput.parse(value);
      const stamp = ticket(chatId, id);
      return serial(chatId, async () => {
        let record = await own(chatId, id);
        const ctx = await context(chatId, record);
        assertLaunch(chatId, id, stamp, record.mode);
        if (record.retryable) throw new Error("This advisor was interrupted. Use Retry before sending a follow-up.");
        const entry = sessions.get(id);
        if (ACTIVE.has(record.status)) {
          if (record.queuedPrompts.length >= 4) throw new Error("Four follow-ups are already queued. Wait for one to finish.");
          await save(chatId, id, (r) => ({ ...r, queuedPrompts: [...r.queuedPrompts, prompt] }));
        } else {
          await slot(chatId, record.mode);
          const { selected } = await capability(chatId, record.launchIdentity, ctx, record.launchIdentity);
          assertLaunch(chatId, id, stamp, record.mode);
          record = await save(chatId, id, (r) => {
            assertLaunch(chatId, id, stamp, r.mode);
            return {
              ...r,
              prompt,
              request: prompt,
              status: "initializing",
              turnNumber: r.turnNumber + 1,
              updatedAt: now(),
              endedAt: undefined,
            };
          });
          const pending = prepare(record, stamp, entry?.alive ? entry : undefined);
          await show(record);
          start(record, ctx, selected, pending);
        }
        return { accepted: true, advisorId: id };
      });
    },
    async stop(chatId, id) {
      let record = await own(chatId, id);
      stops.set(id, (stops.get(id) ?? 0) + 1);
      const entry = sessions.get(id);
      if (entry) {
        entry.alive = false;
        entry.generation = Symbol();
      }
      const closing = closeEntry(entry, true);
      // Record cleanup can wait on disk; native cancellation must begin before that wait.
      closing.catch(() => {});
      if (ACTIVE.has(record.status) || record.queuedPrompts.length) {
        record = await save(chatId, id, (r) => ({ ...r, status: "cancelled", retryable: true, queuedPrompts: [], endedAt: now(), updatedAt: now() }));
        await show(record);
      }
      await closing;
      return advisorRow(record);
    },
    retry(chatId, id) {
      const stamp = ticket(chatId, id);
      return serial(chatId, async () => {
        let record = await own(chatId, id);
        const ctx = await context(chatId, record);
        if (!record.retryable || ACTIVE.has(record.status)) throw new Error("Only interrupted or failed advisors can be retried.");
        const { selected } = await capability(chatId, record.launchIdentity, ctx, record.launchIdentity);
        await slot(chatId, record.mode);
        assertLaunch(chatId, id, stamp, record.mode);
        record = await save(chatId, id, (r) => {
          assertLaunch(chatId, id, stamp, r.mode);
          return {
            ...r,
            status: "initializing",
            retryable: false,
            turnNumber: r.turnNumber + 1,
            updatedAt: now(),
            endedAt: undefined,
            prompt: retryPrompt(r),
          };
        });
        const entry = prepare(record, stamp);
        await show(record);
        start(record, ctx, selected, entry);
        return advisorRow(record);
      });
    },
    async stopChat(chatId) {
      epochs.set(chatId, (epochs.get(chatId) ?? 0) + 1);
      const closing = [];
      for (const entry of sessions.values()) {
        if (entry.chatId !== chatId) continue;
        entry.alive = false;
        entry.generation = Symbol();
        closing.push(closeEntry(entry, true));
      }
      const stopped = Promise.all(closing);
      stopped.catch(() => {});
      await serial(chatId, async () => {
        for (const record of await store.read(chatId)) await manager.stop(chatId, record.id);
      });
      await stopped;
    },
    async stopExecution(chatId) {
      // Fence pending admission too, before waiting on the Chat's serialized work.
      executionRevoked.add(chatId);
      executionEpochs.set(chatId, (executionEpochs.get(chatId) ?? 0) + 1);
      const closing = [];
      for (const entry of sessions.values()) {
        if (entry.chatId !== chatId || entry.mode !== "execution") continue;
        entry.alive = false;
        entry.generation = Symbol();
        closing.push(closeEntry(entry, true));
      }
      // Admission can be waiting on a slow provider. It must not delay stopping a live Full process.
      void serial(chatId, async () => {
        for (const record of await store.read(chatId)) if (record.mode === "execution") await manager.stop(chatId, record.id);
      }).catch((error) => console.warn("Execution advisor state could not be saved:", error.message));
      await Promise.all(closing);
    },
    resumeExecution(chatId) {
      executionRevoked.delete(chatId);
    },
    processes() {
      const roots = new Map();
      for (const entry of sessions.values()) {
        if (!entry.alive || entry.mode !== "execution" || !entry.session?.pid) continue;
        const chatId = entry.chatId;
        if (!chatId) continue;
        roots.set(chatId, [...(roots.get(chatId) ?? []), { pid: entry.session.pid, cwd: entry.cwd }]);
      }
      return roots;
    },
    async reconcile(chatId) {
      const records = await serial(chatId, async () => {
        known.add(chatId);
        const records = await store.update(chatId, (rows) =>
          rows.map((r) =>
            sessions.get(r.id)?.alive
              ? r
              : {
                  ...r,
                  ...(ACTIVE.has(r.status)
                    ? { status: "cancelled", retryable: true, queuedPrompts: [], endedAt: now(), latestActivity: "Interrupted when the host stopped" }
                    : {}),
                  ...(r.delivery === "sending" ? { delivery: "uncertain" } : {}),
                  completions: (r.completions ?? []).map((c) => (c.delivery === "sending" ? { ...c, delivery: "uncertain" } : c)),
                },
          ),
        );
        for (const record of records) await show(record);
        return records;
      });
      // Delivery can start a parent turn, which may revoke execution through this same queue.
      for (const record of records) for (const result of record.completions ?? []) if (result.delivery === "pending") await completed(chatId, result);
    },
    async close() {
      if (closed) return;
      // Fence every generation before awaiting any teardown.
      closed = true;
      for (const entry of sessions.values()) entry.alive = false;
      for (const chatId of known) await manager.stopChat(chatId);
      await Promise.all(
        [...sessions.values()].map(async (entry) => {
          await entry.starting;
          await entry.events;
          await closeEntry(entry);
        }),
      );
      await store.flush();
    },
  };
  return manager;
}
module.exports = { createAdvisors, advisorRow };
