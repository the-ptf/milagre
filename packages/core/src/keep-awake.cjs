const { isTerminal } = require("./agents/events.cjs");

// Keeps the Mac from suspending Milagre while an agent turn or a new worktree's setup runs, in any chat.
// One `prevent-app-suspension` blocker holds from the first to the last one's end; the display can still
// sleep. A setup that ends with a turn to follow hands its hold to that turn, so the blocker never drops
// between the two. A closed or crashed chat releases what it held, turning the setting off releases at
// once, and quitting releases for good.
class KeepAwake {
  constructor({ powerSaveBlocker, enabled = true }) {
    this.blocker = powerSaveBlocker;
    this.enabled = enabled;
    this.quitting = false;
    this.running = new Set();
    this.preparing = new Set();
    // Setups that ended with a turn to follow, until that turn starts or ends before starting.
    this.handingOff = new Set();
    this.blockerId = null;
    this.routinesActive = false;
  }

  get isHolding() {
    return this.blockerId !== null;
  }

  turnStarted(chatId) {
    this.handingOff.delete(chatId);
    this.running.add(chatId);
    this.sync();
  }

  turnEnded(chatId) {
    const running = this.running.delete(chatId);
    if (this.handingOff.delete(chatId) || running) this.sync();
  }

  setupStarted(chatId) {
    this.preparing.add(chatId);
    this.sync();
  }

  // `turnFollows` keeps the hold until the turn's turn-started or terminal event; a cancelled setup has no turn.
  setupEnded(chatId, { turnFollows = false } = {}) {
    if (!this.preparing.delete(chatId)) return;
    if (turnFollows) this.handingOff.add(chatId);
    this.sync();
  }

  // The turn a setup handed off to never got going (its start threw before any event).
  turnNotStarted(chatId) {
    if (this.handingOff.delete(chatId)) this.sync();
  }

  chatClosed(chatId) {
    this.preparing.delete(chatId);
    this.handingOff.delete(chatId);
    this.running.delete(chatId);
    this.sync();
  }

  // Follows the agents' event stream: a turn starts with turn-started and ends with a terminal event.
  observe(chatId, event) {
    if (event.type === "turn-started") this.turnStarted(chatId);
    else if (isTerminal(event)) this.turnEnded(chatId);
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.sync();
  }

  // Enabled Routines mean a heartbeat may fire at any time, so the daemon counts as busy while any exist.
  setRoutinesActive(active) {
    this.routinesActive = Boolean(active);
    this.sync();
  }

  quit() {
    this.quitting = true;
    this.running.clear();
    this.preparing.clear();
    this.handingOff.clear();
    this.sync();
  }

  sync() {
    const busy = this.routinesActive || this.running.size + this.preparing.size + this.handingOff.size > 0;
    const want = this.enabled && !this.quitting && busy;
    if (want && this.blockerId === null) {
      this.blockerId = this.blocker.start("prevent-app-suspension");
    } else if (!want && this.blockerId !== null) {
      const id = this.blockerId;
      this.blockerId = null;
      if (this.blocker.isStarted(id)) this.blocker.stop(id);
    }
  }
}

module.exports = { KeepAwake };
