const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { isTurnEnd } = require("@milagre/shared/agent-runs");
const { NEGOTIATION_ROUNDS } = require("@milagre/shared/limits");
const { clip } = require("./linked-summary.cjs");

// Delegations and Negotiations across Links (ADR-0002). A Delegation is a message from a Chat on one side
// of a Link to a Chat on the other, carried out by that side's own agent; the reply of the turn that took
// it comes back as the Delegation report. A Negotiation is a run of Delegations between two Chats: the
// receiving side answers in its report, which starts the requesting side's next move (another round or
// `conclude_negotiation`), until it concludes, the user stops it, or it reaches NEGOTIATION_ROUNDS.
//
// Delivery follows the receiving Chat: a message steers a turn that is working, waits while the Chat waits
// on the user (that pauses a Negotiation too), and starts a turn when the Chat is idle. A delivered message
// belongs to the turn the agent took it in, by turn id. A steer can miss the end of its turn, so a steered
// message's turn is settled a moment after it ends: a turn the agent starts by itself to run it (`continues`)
// takes it over. Records live in the global store; ones still open when Milagre starts again are cancelled,
// with a notice, as their turns are gone. The exception is a message waiting in its Chat's queue (a provider that
// can't steer, see chat-host.cjs): the queue outlives a restart, so its Delegation (and Negotiation) stays open and is
// followed again when the message starts its turn (`adopt`), or reported cancelled if it is removed (`unqueued`).

const OPEN = new Set(["queued", "running"]);
const OUTCOMES = { "turn-completed": "done", "turn-cancelled": "cancelled", "turn-failed": "failed" };
const KEEP = 200;
const RECENT_TURNS = 10;
const STEER_GRACE_MS = 1500;
const REMOVED = "it was removed from the Chat's queue before its turn started";

function delegationPrompt(delegation) {
  return [
    `Delegation from ${delegation.from_label}, a Chat in a linked Worktree (not the user):`,
    delegation.message,
    delegation.negotiation_id
      ? `This is round ${delegation.round} of a Negotiation (up to ${NEGOTIATION_ROUNDS}). Work out your side, then give your position in your final reply: it goes back as the Delegation report and starts their next move. Call conclude_negotiation(summary) once you both agree.`
      : "Carry it out in this Worktree. Your final reply goes back to that Chat as the Delegation report, so end with what you did.",
  ].join("\n\n");
}

function reportPrompt(delegation, reply) {
  return [
    `Delegation report from ${delegation.to_label} (Negotiation round ${delegation.round} of ${NEGOTIATION_ROUNDS}):`,
    reply || "(no reply)",
    `For another round, call delegate with chat ${delegation.to_chat}. Once you agree, call conclude_negotiation(summary). Ending this turn without either ends the Negotiation.`,
  ].join("\n\n");
}

function reportBody(outcome, reply) {
  if (outcome === "done") return reply || "The receiving agent finished without a reply.";
  const ended = outcome === "cancelled" ? "was stopped" : "failed";
  return reply ? `${reply}\n\nThe turn that handled this Delegation ${ended}.` : `The turn that handled this Delegation ${ended}.`;
}

/** The global store's Delegations, Negotiations and "always allow" grants, as one JSON file written atomically. */
function jsonFileStore(file) {
  let queue = Promise.resolve();
  let counter = 0;
  return {
    async load() {
      try {
        const data = JSON.parse(await fs.readFile(file, "utf8"));
        return {
          delegations: Array.isArray(data?.delegations) ? data.delegations : [],
          negotiations: Array.isArray(data?.negotiations) ? data.negotiations : [],
          grants: Array.isArray(data?.grants) ? data.grants : [],
        };
      } catch (error) {
        if (error.code === "ENOENT" || error instanceof SyntaxError) return { delegations: [], negotiations: [], grants: [] };
        throw error;
      }
    },
    save(data) {
      const text = JSON.stringify(data, null, 2);
      queue = queue
        .catch(() => {})
        .then(async () => {
          await fs.mkdir(path.dirname(file), { recursive: true });
          const temporary = `${file}.${process.pid}.${++counter}.tmp`;
          await fs.writeFile(temporary, text);
          await fs.rename(temporary, file);
        });
      return queue;
    },
  };
}

class Delegations {
  /**
   * Ports, all supplied by the runtime:
   *   target(fromChat, worktreePath) -> { link_id, link_ids, projectPath, projectName, branch } | null, when the Chat can see that
   *     Worktree; link_ids are every Link that reaches it, link_id the one it routes along
   *   chat(chatKey) -> { label, worktreePath, archived } | null; openChat(projectPath, worktreePath) -> a new Chat's key
   *   status(chatKey) -> "idle" | "working" | "waiting"
   *   deliver(chatKey, { body, prompt, context }) -> { started }, once the message is saved; `started` resolves with
   *     { turnId, steered, cancelled? } (turnId null when no turn started), or null
   *   reply(chatKey, delegationId) -> what the Chat replied after that Delegation's message
   *   note(chatKey, { body, context }) posts a line that starts no turn
   *   permissionMode(chatKey); approve(chatKey, request) -> "allow" | "allow-for-chat" | "deny" | "cancelled"
   *   changed(snapshot) tells the windows
   */
  constructor({ store, ports, id = randomUUID, now = () => new Date() }) {
    Object.assign(this, { store, ports, id, now });
    this.data = { delegations: [], negotiations: [], grants: [] };
    // Items waiting for their Chat to stop waiting on the user. One array per Chat, only ever edited in place.
    this.queues = new Map();
    // Items delivered to a Chat, until the turn that took them ends: { item, turnId, steered }. turnId is
    // undefined until the turn starts, and null for "the next turn". One array per Chat, edited in place.
    this.delivered = new Map();
    // Steered items whose turn just ended, for STEER_GRACE_MS: { entry, from, outcome, timer }.
    this.settling = new Map();
    this.currentTurn = new Map();
    this.endedTurns = new Map();
    this.pumping = new Set();
    this.ready = store.load().then((data) => {
      // `waiting`: its message still waits in the receiving Chat's queue, which a restart keeps.
      const delegations = data.delegations.filter((item) => OPEN.has(item.status) && !item.waiting);
      const negotiations = data.negotiations.filter((item) => item.status === "running" && !item.waiting);
      for (const delegation of delegations) delegation.status = "cancelled";
      for (const negotiation of negotiations) negotiation.status = "stopped";
      this.data = data;
      if (delegations.length || negotiations.length) void this.noteInterrupted(delegations, negotiations);
    });
  }

  snapshot() {
    return {
      delegations: this.data.delegations
        .filter((item) => OPEN.has(item.status))
        .map(({ id, link_id, from_chat, to_chat, from_label, to_label, status, negotiation_id, round, message, waiting }) => ({
          id,
          link_id,
          from_chat,
          to_chat,
          from_label,
          to_label,
          status: waiting ? "queued" : status,
          negotiation_id,
          round,
          message: clip(message, 120),
        })),
      negotiations: this.data.negotiations
        .filter((item) => item.status === "running")
        .map(({ id, link_id, chats, labels, round }) => ({ id, link_id, chats, labels, round })),
    };
  }

  /** Lines for the linked summary: open work between the two Worktrees. */
  openBetween(worktreeA, worktreeB) {
    const between = (a, b) => (a === worktreeA && b === worktreeB) || (a === worktreeB && b === worktreeA);
    return [
      ...this.data.negotiations
        .filter((item) => item.status === "running" && between(...item.worktrees))
        .map((item) => `Negotiation between ${item.labels[0]} and ${item.labels[1]}, round ${item.round} of ${NEGOTIATION_ROUNDS}`),
      ...this.data.delegations
        .filter((item) => OPEN.has(item.status) && between(item.from_worktree, item.to_worktree))
        .map((item) => `Delegation ${item.waiting ? "queued" : item.status} from ${item.from_label} to ${item.to_label}: "${clip(item.message, 120)}"`),
    ];
  }

  persist() {
    // Closed records beyond the latest KEEP are dropped; open ones always stay.
    const trim = (items, open) => items.filter((item, index) => open(item) || index >= items.length - KEEP);
    this.data.delegations = trim(this.data.delegations, (item) => OPEN.has(item.status));
    this.data.negotiations = trim(this.data.negotiations, (item) => item.status === "running");
    this.ports.changed(this.snapshot());
    return this.store.save(this.data).catch((error) => console.warn("Milagre couldn't save Delegations:", error.message));
  }

  /** The `delegate` tool. Resolves to what the requesting agent is told; refusals throw. */
  async delegate(fromChat, { worktree, chat, message, negotiation = false }) {
    await this.ready;
    const current = this.data.negotiations.find((item) => item.status === "running" && item.chats.includes(fromChat) && item.chats.includes(chat));
    if (current) return this.nextRound(fromChat, current, message);
    if (negotiation && this.holding(fromChat, ({ item }) => item.kind === "delegation"))
      throw new Error(
        "Only the requesting side can open a Negotiation, and this turn is handling a Delegation. Give your answer in your final reply; it goes back as the Delegation report.",
      );
    if (this.holding(fromChat, ({ item }) => item.kind === "delegation" && !item.negotiationId)) {
      throw new Error(
        negotiation
          ? "Only the requesting side can open a Negotiation, and this turn is handling a Delegation. Give your answer in your final reply; it goes back as the Delegation report."
          : "This turn is handling a Delegation, so it can't make one. Finish the request; your final reply goes back as the Delegation report.",
      );
    }
    const target = await this.ports.target(fromChat, worktree);
    if (!target) throw new Error("That Worktree isn't linked to this Chat. Use linked_overview to see the ones that are.");
    let toLabel = `${target.projectName} / ${target.branch} / a new Chat`;
    if (chat !== "new") {
      const info = await this.ports.chat(chat);
      if (!info || info.worktreePath !== worktree)
        throw new Error('That Chat isn\'t in the Worktree you named. Pick a Chat ref from linked_overview, or "new".');
      if (info.archived) throw new Error('That Chat is archived and can\'t receive a Delegation. Pick another one, or "new".');
      toLabel = info.label;
    }
    const from = await this.ports.chat(fromChat);
    const linkIds = [target.link_id, ...(target.link_ids ?? []).filter((id) => id !== target.link_id)];
    const decision = await this.approval(fromChat, linkIds, { target: toLabel, message, negotiation });
    if (decision === "deny") throw new Error("The user denied this Delegation. Don't send it again unless they ask.");
    if (decision === "cancelled") throw new Error("The approval card closed before the user answered, so nothing was sent.");
    const toChat = chat === "new" ? await this.ports.openChat(target.projectPath, worktree) : chat;
    const record = negotiation
      ? {
          id: this.id(),
          link_id: target.link_id,
          chats: [fromChat, toChat],
          labels: [from.label, toLabel],
          worktrees: [from.worktreePath, worktree],
          round: 0,
          status: "running",
          awaiting: toChat,
          move: false,
        }
      : null;
    if (record) this.data.negotiations.push(record);
    const delegation = this.record({
      link_id: target.link_id,
      from_chat: fromChat,
      from_label: from.label,
      from_worktree: from.worktreePath,
      to_chat: toChat,
      to_label: toLabel,
      to_worktree: worktree,
      message,
      ...(record ? { negotiation_id: record.id, round: 1 } : {}),
    });
    await this.enqueue(toChat, this.delegationItem(delegation));
    return record
      ? `Negotiation opened with ${toLabel} (up to ${NEGOTIATION_ROUNDS} rounds). Their Delegation report starts your next move; end your turn now.`
      : `Delegation sent to ${toLabel} (Chat ${toChat}). Its agent carries it out; the Delegation report appears in this Chat when it finishes, so don't wait for it.`;
  }

  // Only the side whose move it is (the requesting side, once a report came back) sends the next round.
  async nextRound(fromChat, negotiation, message) {
    const mine = negotiation.chats.indexOf(fromChat);
    if (negotiation.awaiting !== fromChat || !negotiation.move) {
      throw new Error(
        negotiation.awaiting === fromChat
          ? "Give your answer in your final reply: it goes back as your Delegation report in this Negotiation."
          : `It's ${negotiation.labels[1 - mine]}'s turn in this Negotiation. End your turn; their report starts your next move.`,
      );
    }
    if (negotiation.round >= NEGOTIATION_ROUNDS) {
      await this.end(negotiation, "capped");
      throw new Error(`The Negotiation reached ${NEGOTIATION_ROUNDS} rounds and stopped; both Chats ask the user to step in.`);
    }
    const other = negotiation.chats[1 - mine];
    Object.assign(negotiation, { awaiting: other, move: false });
    const delegation = this.record({
      link_id: negotiation.link_id,
      from_chat: fromChat,
      from_label: negotiation.labels[mine],
      from_worktree: negotiation.worktrees[mine],
      to_chat: other,
      to_label: negotiation.labels[1 - mine],
      to_worktree: negotiation.worktrees[1 - mine],
      message,
      negotiation_id: negotiation.id,
      round: negotiation.round + 1,
    });
    await this.enqueue(other, this.delegationItem(delegation));
    return `Round ${delegation.round} sent to ${delegation.to_label}. Their report starts your next move; end your turn now.`;
  }

  /** The `conclude_negotiation` tool: a turn that took one of the Negotiation's rounds or reports may conclude it. */
  async conclude(fromChat, summary) {
    await this.ready;
    const negotiation = this.data.negotiations.find(
      (item) => item.status === "running" && this.holding(fromChat, ({ item: held }) => held.negotiationId === item.id),
    );
    if (!negotiation) throw new Error("This turn doesn't belong to a running Negotiation.");
    await this.end(negotiation, "concluded", { summary, by: fromChat });
    return "Negotiation concluded. The agreement is posted in both Chats.";
  }

  // Whether this Chat's current (or next) turn holds a delivered item that matches.
  holding(chatKey, match) {
    return [...this.entries(chatKey), ...(this.settling.get(chatKey) ?? []).map(({ entry }) => entry)].some(match);
  }

  entries(chatKey) {
    if (!this.delivered.has(chatKey)) this.delivered.set(chatKey, []);
    return this.delivered.get(chatKey);
  }

  /**
   * `linkIds`: every Link that reaches the destination, the routed one first. A grant on any of them covers it, so
   * Always allow set on a newer, wider Link still holds where an older one is the route. The card's grant goes on the
   * routed Link.
   */
  async approval(fromChat, linkIds, delegation) {
    const grant = `${fromChat}\0${linkIds[0]}`;
    if (this.ports.permissionMode(fromChat) !== "ask" || linkIds.some((id) => this.data.grants.includes(`${fromChat}\0${id}`))) return "allow";
    const decision = await this.ports.approve(fromChat, {
      requestId: this.id(),
      kind: "delegation",
      tool: "Delegation",
      title: delegation.negotiation ? `Open a Negotiation with ${delegation.target}?` : `Send a Delegation to ${delegation.target}?`,
      allowForChat: true,
      delegation,
    });
    if (decision === "allow-for-chat") {
      this.data.grants.push(grant);
      await this.persist();
    }
    return decision === "allow-for-chat" ? "allow" : decision;
  }

  /**
   * "Always allow for this Link in this chat", set before the agent asks: the sidebar's Link popover offers it for
   * the Chat that was dropped. The same grant the approval card saves.
   */
  async grant(chatKey, linkId) {
    await this.ready;
    if (typeof chatKey !== "string" || typeof linkId !== "string" || !chatKey || !linkId) throw new Error("Choose a Chat and a Link.");
    const grant = `${chatKey}\0${linkId}`;
    if (this.data.grants.includes(grant)) return;
    this.data.grants.push(grant);
    await this.persist();
  }

  record(fields) {
    const delegation = { id: this.id(), ...fields, status: "queued", created_at: this.now().toISOString() };
    this.data.delegations.push(delegation);
    return delegation;
  }

  delegationItem(delegation) {
    return {
      kind: "delegation",
      delegationId: delegation.id,
      negotiationId: delegation.negotiation_id,
      body: delegation.message,
      prompt: delegationPrompt(delegation),
      context: {
        kind: "delegation",
        delegationId: delegation.id,
        from: delegation.from_chat,
        fromLabel: delegation.from_label,
        ...(delegation.negotiation_id ? { negotiation: { id: delegation.negotiation_id, round: delegation.round } } : {}),
      },
    };
  }

  queue(chatKey) {
    if (!this.queues.has(chatKey)) this.queues.set(chatKey, []);
    return this.queues.get(chatKey);
  }

  dropQueued(match) {
    for (const queue of this.queues.values()) {
      for (let index = queue.length - 1; index >= 0; index--) if (match(queue[index])) queue.splice(index, 1);
    }
  }

  async enqueue(chatKey, item) {
    this.queue(chatKey).push(item);
    await this.persist();
    await this.pump(chatKey);
  }

  // Delivers a Chat's waiting items in order, unless it waits on the user.
  async pump(chatKey) {
    if (this.pumping.has(chatKey)) return;
    this.pumping.add(chatKey);
    try {
      const queue = this.queue(chatKey);
      while (queue.length && this.ports.status(chatKey) !== "waiting") await this.start(chatKey, queue.shift());
    } finally {
      this.pumping.delete(chatKey);
    }
  }

  async start(chatKey, item) {
    const delegation = item.kind === "delegation" ? this.data.delegations.find((entry) => entry.id === item.delegationId) : null;
    const negotiation = item.negotiationId ? this.data.negotiations.find((entry) => entry.id === item.negotiationId) : null;
    if ((delegation && delegation.status !== "queued") || (negotiation && negotiation.status !== "running")) return;
    if (delegation) {
      delegation.status = "running";
      if (negotiation) negotiation.round = delegation.round;
      await this.persist();
    }
    let started;
    let queued;
    try {
      ({ started, queued } = await this.ports.deliver(chatKey, item));
    } catch (error) {
      await this.undelivered(item, "failed", error.message);
      return;
    }
    // A message for a turn its provider can't steer waits in the Chat's queue, which outlives a restart.
    if (queued) await this.markWaiting(item, true);
    void this.follow(chatKey, item, started);
  }

  // The turn that takes it may start long after (a new Worktree's setup runs first, or it waits in the Chat's queue).
  follow(chatKey, item, started) {
    const entry = { item, turnId: undefined, steered: false };
    this.entries(chatKey).push(entry);
    return Promise.resolve(started)
      .then(
        (result) => this.attach(chatKey, entry, result),
        () => this.attach(chatKey, entry, null),
      )
      .catch((error) => console.warn("Milagre couldn't follow a Delegation:", error.message));
  }

  /** Marks the item's Delegation and Negotiation as waiting in the receiving Chat's queue, or no longer. */
  async markWaiting(item, waiting) {
    const records = [
      item.kind === "delegation" ? this.data.delegations.find((entry) => entry.id === item.delegationId) : null,
      item.negotiationId ? this.data.negotiations.find((entry) => entry.id === item.negotiationId) : null,
    ].filter((record) => record && Boolean(record.waiting) !== waiting);
    if (!records.length) return;
    for (const record of records) {
      if (waiting) record.waiting = true;
      else delete record.waiting;
    }
    await this.persist();
  }

  /** The item of a message that waited in `chatKey`'s queue across a restart, found from the message's context; null when none. */
  waitingItem(chatKey, context) {
    if (context?.kind === "delegation") {
      const delegation = this.data.delegations.find(
        (entry) => entry.id === context.delegationId && entry.waiting && entry.status === "running" && entry.to_chat === chatKey,
      );
      return delegation ? this.delegationItem(delegation) : null;
    }
    if (context?.kind === "delegation-report" && context.negotiation) {
      const negotiation = this.data.negotiations.find(
        (entry) => entry.id === context.negotiation.id && entry.waiting && entry.status === "running" && entry.awaiting === chatKey,
      );
      return negotiation ? { kind: "report", negotiationId: negotiation.id } : null;
    }
    return null;
  }

  /**
   * A message that waited in its Chat's queue while Milagre restarted starts its turn (`started` as from deliver): it is
   * followed from here as one delivered this run, so its report still reaches the delegating Chat. Resolves whether it
   * belonged to an open Delegation or Negotiation.
   */
  async adopt(chatKey, context, started) {
    await this.ready;
    const item = this.waitingItem(chatKey, context);
    if (!item) return false;
    await this.follow(chatKey, item, started);
    return true;
  }

  /** Such a message was removed from its Chat's queue unsent: its Delegation is cancelled, with a notice. */
  async unqueued(chatKey, context) {
    await this.ready;
    const item = this.waitingItem(chatKey, context);
    if (!item) return false;
    await this.markWaiting(item, false);
    await this.undelivered(item, "cancelled", REMOVED);
    return true;
  }

  async attach(chatKey, entry, result) {
    await this.markWaiting(entry.item, false);
    if (!result?.turnId) {
      this.remove(chatKey, entry);
      await this.undelivered(
        entry.item,
        result?.cancelled ? "cancelled" : "failed",
        result?.removed ? REMOVED : result?.cancelled ? "it was stopped before its turn started" : "its turn didn't start",
      );
      return;
    }
    entry.steered = Boolean(result.steered);
    const ended = this.endedTurns.get(chatKey)?.find((turn) => turn.turnId === result.turnId);
    if (!ended) entry.turnId = result.turnId;
    // A steer into a turn that already ended runs in the next one; a turn started for it that already ended handled it.
    else if (entry.steered) entry.turnId = null;
    else {
      this.remove(chatKey, entry);
      await this.handle(chatKey, [entry], ended.outcome);
    }
  }

  remove(chatKey, entry) {
    const entries = this.entries(chatKey);
    if (entries.includes(entry)) entries.splice(entries.indexOf(entry), 1);
  }

  async undelivered(item, status, problem) {
    const delegation = item.kind === "delegation" ? this.data.delegations.find((entry) => entry.id === item.delegationId) : null;
    const negotiation = item.negotiationId ? this.data.negotiations.find((entry) => entry.id === item.negotiationId) : null;
    if (delegation) {
      delegation.status = status;
      await this.persist();
      await this.ports.note(delegation.from_chat, {
        body: `Couldn't deliver the Delegation to ${delegation.to_label}: ${problem}.`,
        context: { kind: "delegation-report", delegationId: delegation.id, from: delegation.to_chat, fromLabel: delegation.to_label, status },
      });
    }
    if (negotiation) await this.end(negotiation, "stopped", { reason: "a message couldn't be delivered" });
  }

  /** Every agent event of every Chat, after the Chat's state took it in. */
  async observe(chatKey, event) {
    await this.ready;
    if (event.type === "turn-started") {
      this.currentTurn.set(chatKey, event.turnId);
      const settling = this.settling.get(chatKey) ?? [];
      for (const held of settling.filter((item) => event.continues && item.from === event.continues)) {
        clearTimeout(held.timer);
        settling.splice(settling.indexOf(held), 1);
        this.entries(chatKey).push(Object.assign(held.entry, { turnId: event.turnId }));
      }
      for (const entry of this.entries(chatKey)) if (entry.turnId === null) entry.turnId = event.turnId;
    } else if (isTurnEnd(event)) {
      await this.turnEnded(chatKey, OUTCOMES[event.type]);
    } else if (event.type === "permission-resolved" || event.type === "question-resolved") {
      await this.pump(chatKey);
    }
  }

  async turnEnded(chatKey, outcome) {
    const turnId = this.currentTurn.get(chatKey);
    this.currentTurn.delete(chatKey);
    this.endedTurns.set(chatKey, [...(this.endedTurns.get(chatKey) ?? []), { turnId, outcome }].slice(-RECENT_TURNS));
    const entries = this.entries(chatKey);
    const handled = turnId ? entries.filter((entry) => entry.turnId === turnId) : [];
    for (const entry of handled) entries.splice(entries.indexOf(entry), 1);
    for (const entry of handled.filter((item) => item.steered)) {
      const held = { entry, from: turnId, outcome };
      held.timer = setTimeout(() => {
        const settling = this.settling.get(chatKey);
        settling.splice(settling.indexOf(held), 1);
        void this.handle(chatKey, [entry], outcome)
          .then(() => this.pump(chatKey))
          .catch((error) => console.warn("Milagre couldn't follow a Delegation:", error.message));
      }, STEER_GRACE_MS);
      held.timer.unref?.();
      this.settling.set(chatKey, [...(this.settling.get(chatKey) ?? []), held]);
    }
    await this.handle(
      chatKey,
      handled.filter((item) => !item.steered),
      outcome,
    );
    await this.pump(chatKey);
  }

  // The turn that took these items ended: Delegations report, and a requesting side that let its move go ends its Negotiation.
  async handle(chatKey, entries, outcome) {
    for (const { item } of entries) {
      if (item.kind === "delegation")
        await this.finish(
          this.data.delegations.find((entry) => entry.id === item.delegationId),
          outcome,
        );
      const negotiation = item.kind === "report" ? this.data.negotiations.find((entry) => entry.id === item.negotiationId) : null;
      if (negotiation?.status === "running" && negotiation.awaiting === chatKey && negotiation.move) {
        await this.end(negotiation, "stopped", {
          reason: `${negotiation.labels[negotiation.chats.indexOf(chatKey)]} ended a turn without another round or a conclusion`,
        });
      }
    }
  }

  async finish(delegation, outcome) {
    if (delegation?.status !== "running") return;
    delegation.status = outcome;
    const reply = await this.ports.reply(delegation.to_chat, delegation.id);
    const negotiation = delegation.negotiation_id ? this.data.negotiations.find((entry) => entry.id === delegation.negotiation_id) : null;
    const context = { kind: "delegation-report", delegationId: delegation.id, from: delegation.to_chat, fromLabel: delegation.to_label, status: outcome };
    if (negotiation?.status === "running" && outcome === "done") {
      Object.assign(negotiation, { awaiting: delegation.from_chat, move: true });
      await this.enqueue(delegation.from_chat, {
        kind: "report",
        negotiationId: negotiation.id,
        body: reply || "The receiving agent finished without a reply.",
        prompt: reportPrompt(delegation, reply),
        context: { ...context, negotiation: { id: negotiation.id, round: delegation.round } },
      });
      return;
    }
    if (negotiation?.status === "running")
      await this.end(negotiation, "stopped", { reason: `round ${delegation.round} ${outcome === "cancelled" ? "was stopped" : "failed"}` });
    await this.persist();
    await this.ports.note(delegation.from_chat, { body: reportBody(outcome, reply), context });
  }

  /** Ends a running Negotiation, drops its waiting messages and tells both Chats. */
  async end(negotiation, status, { summary, by, reason } = {}) {
    if (negotiation.status !== "running") return;
    Object.assign(negotiation, { status, ...(summary ? { summary } : {}) });
    this.dropQueued((item) => item.negotiationId === negotiation.id);
    for (const delegation of this.data.delegations)
      if (delegation.negotiation_id === negotiation.id && delegation.status === "queued") delegation.status = "cancelled";
    await this.persist();
    await this.tellBoth(negotiation, status, { summary, by, reason });
  }

  tellBoth(negotiation, status, { summary, by, reason }) {
    return Promise.all(
      negotiation.chats.map((chatKey, index) => {
        const other = negotiation.labels[1 - index];
        const body =
          status === "concluded"
            ? summary
            : status === "capped"
              ? `The Negotiation with ${other} reached ${NEGOTIATION_ROUNDS} rounds without an agreement and stopped. Step in to settle it.`
              : `The Negotiation with ${other} stopped: ${reason ?? "stopped by the user"}.`;
        return this.ports.note(chatKey, {
          body,
          context: {
            kind: status === "concluded" ? "negotiation-agreement" : "linked-notice",
            negotiationId: negotiation.id,
            with: other,
            ...(by ? { by } : {}),
          },
        });
      }),
    );
  }

  async noteInterrupted(delegations, negotiations) {
    await this.persist();
    const notes = delegations.map((delegation) =>
      this.ports.note(delegation.from_chat, {
        body: `Milagre restarted before ${delegation.to_label} finished this Delegation, so it was cancelled: "${clip(delegation.message, 120)}"`,
        context: { kind: "delegation-report", delegationId: delegation.id, from: delegation.to_chat, fromLabel: delegation.to_label, status: "cancelled" },
      }),
    );
    const results = await Promise.allSettled([
      ...notes,
      ...negotiations.map((negotiation) => this.tellBoth(negotiation, "stopped", { reason: "Milagre restarted" })),
    ]);
    for (const result of results) if (result.status === "rejected") console.warn("Milagre couldn't post a Delegation notice:", result.reason?.message);
  }

  /** Stop pressed in a Chat or on the canvas: its running Negotiations stop. */
  async stop({ chatKey, negotiationId }) {
    await this.ready;
    for (const negotiation of this.data.negotiations.filter(
      (item) => item.status === "running" && (item.id === negotiationId || item.chats.includes(chatKey)),
    )) {
      await this.end(negotiation, "stopped", { reason: "stopped by the user" });
    }
  }

  /**
   * A removed Link: running turns finish. What travelled along it moves to another Link that still joins
   * the two Chats; otherwise its Negotiations stop and its queued Delegations are cancelled, with a notice.
   */
  async linkRemoved(linkId) {
    await this.ready;
    const relink = async (record, fromChat, toWorktree) => {
      const still = await this.ports.target(fromChat, toWorktree);
      if (still) record.link_id = still.link_id;
      return Boolean(still);
    };
    for (const negotiation of this.data.negotiations.filter((item) => item.link_id === linkId && item.status === "running")) {
      if (!(await relink(negotiation, negotiation.chats[0], negotiation.worktrees[1])))
        await this.end(negotiation, "stopped", { reason: "its Link was removed" });
    }
    const cancelled = [];
    for (const delegation of this.data.delegations.filter((item) => item.link_id === linkId && item.status === "queued")) {
      if (!(await relink(delegation, delegation.from_chat, delegation.to_worktree))) cancelled.push(delegation);
    }
    this.dropQueued((item) => cancelled.some((delegation) => delegation.id === item.delegationId));
    for (const delegation of cancelled) delegation.status = "cancelled";
    await this.persist();
    await Promise.all(
      cancelled.flatMap((delegation) => {
        const body = `The Link between ${delegation.from_label} and ${delegation.to_label} was removed, so this Delegation was cancelled before delivery: "${clip(delegation.message, 120)}"`;
        const context = { kind: "linked-notice", delegationId: delegation.id };
        return [this.ports.note(delegation.from_chat, { body, context }), this.ports.note(delegation.to_chat, { body, context })];
      }),
    );
  }
}

module.exports = { Delegations, jsonFileStore };
