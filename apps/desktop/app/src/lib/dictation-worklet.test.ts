import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

test("the audio thread downmixes channels and flushes the last short buffer before its finish acknowledgement", () => {
  const messages: (Float32Array | string)[] = [];
  let listener: (event: { data: string }) => void = () => {};
  let Capture!: new () => { process(inputs: Float32Array[][]): boolean };
  class Processor {
    port = {
      start() {},
      addEventListener(_name: string, callback: typeof listener) {
        listener = callback;
      },
      postMessage(data: Float32Array | string) {
        messages.push(data);
      },
    };
  }
  vm.runInNewContext(readFileSync(new URL("./dictation-worklet.js", import.meta.url), "utf8"), {
    AudioWorkletProcessor: Processor,
    sampleRate: 16000,
    Float32Array,
    registerProcessor: (_name: string, value: typeof Capture) => {
      Capture = value;
    },
  });
  const capture = new Capture();
  capture.process([[new Float32Array(2000).fill(0.8), new Float32Array(2000).fill(0.2)]]);
  assert.equal(messages.length, 1);
  assert.equal((messages[0] as Float32Array).length, 1600);
  listener({ data: "finish" });
  assert.equal((messages[1] as Float32Array).length, 400);
  assert.ok(Math.abs((messages[1] as Float32Array)[0]! - 0.5) < 1e-6);
  assert.equal(messages[2], "finished");
  capture.process([[new Float32Array(1600).fill(1)]]);
  assert.equal(messages.length, 3, "capture remains stopped after its acknowledgement");
});
