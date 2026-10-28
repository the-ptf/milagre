// Keeps the Mac from idle-sleeping for as long as Milagre runs, so paired computers and the phone can still reach it
// once the screen locks. One `prevent-app-suspension` blocker holds while the setting is on; the display can still
// sleep, and closing the lid still sleeps the Mac. Turning the setting off releases at once, and quitting for good.
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
