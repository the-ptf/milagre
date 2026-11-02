// Capture on the audio thread. The main thread receives ~100 ms buffers instead of encoding a complete recording.
/* global AudioWorkletProcessor, sampleRate, registerProcessor */
class DictationCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(Math.round(sampleRate / 10));
    this.length = 0;
    this.finished = false;
    this.port.addEventListener("message", ({ data }) => {
      if (data !== "finish") return;
      this.finished = true;
      this.flush();
      this.port.postMessage("finished", []);
    });
    this.port.start();
  }

  flush() {
    if (!this.length) return;
    const samples = this.samples.slice(0, this.length);
    this.port.postMessage(samples, [samples.buffer]);
    this.length = 0;
  }

  process(inputs) {
    if (this.finished) return true;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let mono = 0;
      for (const channel of channels) mono += channel[i] / channels.length;
      this.samples[this.length++] = mono;
      if (this.length === this.samples.length) this.flush();
    }
    return true;
  }
}

registerProcessor("dictation-capture", DictationCapture);
