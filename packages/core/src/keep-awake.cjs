class KeepAwake {
  constructor({ powerSaveBlocker, enabled = true }) {
    this.blocker = powerSaveBlocker;
    this.enabled = enabled;
    this.quitting = false;
    this.blockerId = null;
    this.sync();
  }

  get isHolding() {
    return this.blockerId !== null;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.sync();
  }

  quit() {
    this.quitting = true;
    this.sync();
  }

  sync() {
    const want = this.enabled && !this.quitting;
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
