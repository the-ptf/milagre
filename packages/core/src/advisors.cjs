const { providerName } = require("@milagre/shared/providers");
const { randomUUID } = require("node:crypto");
const { ADVISOR_PROVIDERS, createInput, promptInput } = require("./advisor-tools.cjs");
const { ANALYSIS_INSTRUCTIONS } = require("./agents/advisor-policy.cjs");
const ACTIVE = new Set(["initializing", "running", "waiting"]);

function advisorRow(record) {
  const { id, title, prompt, status, provider, model, startedAt, updatedAt, endedAt, latestActivity, transcript, retryable } = record;
  return { id, title, prompt, status, provider, model, startedAt, updatedAt, endedAt, latestActivity, transcript, retryable, source: "milagre-advisor" };
}
function createAdvisors({ store, contextFor, providersFor, launch, publish = async () => {}, completed = async () => {}, now = Date.now }) {
  const sessions = new Map();
  const queues = new Map();
  const known = new Set();
  const epochs = new Map();
  const stops = new Map();
  let closed = false;
  const ticket = (chatId, id) => ({ epoch: epochs.get(chatId) ?? 0, stop: stops.get(id) ?? 0 });
  const admitted = (chatId, id, stamp) => !closed && stamp.epoch === (epochs.get(chatId) ?? 0) && stamp.stop === (stops.get(id) ?? 0);
  function assertLaunch(chatId, id, stamp) {
    if (!admitted(chatId, id, stamp)) throw new Error("This advisor launch was stopped.");
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
  async function context(chatId, record) {
    if (closed) throw new Error("The advisor host is shutting down.");
    const value = await contextFor(chatId);
    if (!value || value.archived || !value.cwd) throw new Error("This Chat is archived or its Worktree is unavailable.");
    if (record && record.scopeIdentity !== value.scopeIdentity) throw new Error("This Chat's Worktree scope changed. Start a new advisor.");
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
  async function slot(chatId) {
    if ((await store.read(chatId)).filter((r) => ACTIVE.has(r.status) || r.queuedPrompts.length).length >= 2)
      throw new Error("Two advisors are already active in this Chat. Stop one or wait for it to finish.");
  }
  function prepare(record, stamp, existing) {
    const entry = existing ?? { alive: true, session: null, events: Promise.resolve() };
    entry.busy = true;
    entry.output = "";
    entry.generation = Symbol();
    entry.ticket = stamp;
    sessions.set(record.id, entry);
    return entry;
  }
  function start(record, ctx, selected, entry) {
    const generation = entry.generation;
    const stamp = entry.ticket;
    const current = () => entry.alive && entry.generation === generation && admitted(record.chatId, record.id, stamp);
    const emit = (event) => {
      if (!current()) return;
      entry.events = entry.events
        .then(async () => {
          if (!current()) return;
          if (event.type === "session-started") {
            await save(record.chatId, record.id, (r) => ({ ...r, nativeId: event.nativeId }));
            return;
          }
          if (event.type === "text-delta") entry.output = (entry.output + event.text).slice(0, 40_000);
          const terminal = ["turn-completed", "turn-failed", "turn-cancelled"].includes(event.type);
          let next = await save(record.chatId, record.id, (r) => {
            const timestamp = now();
            if (terminal) {
              const status = event.type === "turn-completed" ? "completed" : event.type === "turn-failed" ? "failed" : "cancelled";
              const output = entry.output || event.message || (status === "completed" ? "The advisor returned no text." : "The advisor was stopped.");
              const completionId = `${r.id}:${r.turnNumber}`;
              const result = { id: completionId, advisorId: r.id, title: r.title, provider: r.provider, outcome: status, output, delivery: "pending" };
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
              transcript,
              status: "running",
              updatedAt: timestamp,
              latestActivity: event.type === "step-started" ? event.title : r.latestActivity,
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
              await entry.session?.close().catch(() => {});
              return;
            }
            if (!current()) return;
            const nextPrompt = next.queuedPrompts[0];
            next = await save(record.chatId, record.id, (r) => ({
              ...r,
              status: "initializing",
              prompt: nextPrompt,
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
          await entry.session?.close().catch(() => {});
          // Keep the last durable state for recovery. A failed save must never trigger parent delivery.
          console.warn("Advisor activity could not be saved:", error.message);
        });
    };
    entry.starting = Promise.resolve()
      .then(async () => {
        if (!current()) return;
        if (!entry.session) entry.session = await launch({ record, context: ctx, provider: selected, emit: (event) => entry.emit(event) });
        // Reused sessions need the current generation callback for follow-ups.
        entry.emit = emit;
        if (!current()) {
          await entry.session.close();
          return;
        }
        const request = { prompt: record.prompt, model: record.model, effort: record.launchIdentity.effort, permissionMode: "ask", images: [] };
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
        const { identity, selected } = await capability(chatId, input, ctx);
        await slot(chatId);
        assertLaunch(chatId, undefined, stamp);
        await context(chatId, { scopeIdentity: ctx.scopeIdentity });
        assertLaunch(chatId, undefined, stamp);
        const timestamp = now();
        const record = {
          id: `advisor:${randomUUID()}`,
          chatId,
          scopeIdentity: ctx.scopeIdentity,
          launchIdentity: identity,
          provider: identity.provider,
          model: identity.model,
          title: input.title,
          prompt: `${input.prompt}\n\n${ANALYSIS_INSTRUCTIONS}`,
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
        assertLaunch(chatId, id, stamp);
        if (record.retryable) throw new Error("This advisor was interrupted. Use Retry before sending a follow-up.");
        const entry = sessions.get(id);
        if (ACTIVE.has(record.status)) {
          if (record.queuedPrompts.length >= 4) throw new Error("Four follow-ups are already queued. Wait for one to finish.");
          await save(chatId, id, (r) => ({ ...r, queuedPrompts: [...r.queuedPrompts, prompt] }));
        } else {
          await slot(chatId);
          const { selected } = await capability(chatId, record.launchIdentity, ctx, record.launchIdentity);
          assertLaunch(chatId, id, stamp);
          record = await save(chatId, id, (r) => {
            assertLaunch(chatId, id, stamp);
            return {
              ...r,
              prompt,
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
      if (ACTIVE.has(record.status) || record.queuedPrompts.length) {
        record = await save(chatId, id, (r) => ({ ...r, status: "cancelled", retryable: true, queuedPrompts: [], endedAt: now(), updatedAt: now() }));
        await show(record);
      }
      if (entry?.session) {
        await entry.session.interrupt().catch(() => {});
        await entry.session.close();
      }
      return advisorRow(record);
    },
    retry(chatId, id) {
      const stamp = ticket(chatId, id);
      return serial(chatId, async () => {
        let record = await own(chatId, id);
        const ctx = await context(chatId, record);
        if (!record.retryable || ACTIVE.has(record.status)) throw new Error("Only interrupted or failed advisors can be retried.");
        const { selected } = await capability(chatId, record.launchIdentity, ctx, record.launchIdentity);
        await slot(chatId);
        assertLaunch(chatId, id, stamp);
        record = await save(chatId, id, (r) => {
          assertLaunch(chatId, id, stamp);
          return {
            ...r,
            status: "initializing",
            retryable: false,
            turnNumber: r.turnNumber + 1,
            updatedAt: now(),
            endedAt: undefined,
            prompt: `${r.prompt}\n\nPrevious saved output:\n${r.output}\n\n${ANALYSIS_INSTRUCTIONS}`,
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
      await serial(chatId, async () => {
        for (const record of await store.read(chatId)) await manager.stop(chatId, record.id);
      });
    },
    reconcile(chatId) {
      return serial(chatId, async () => {
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
        for (const record of records) {
          await show(record);
          for (const result of record.completions ?? []) if (result.delivery === "pending") await completed(chatId, result);
        }
      });
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
          await entry.session?.close();
        }),
      );
      await store.flush();
    },
  };
  return manager;
}
module.exports = { createAdvisors, advisorRow };
