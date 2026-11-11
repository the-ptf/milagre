const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { createIntroMotionDecision } = require("./intro-motion.cjs");

function fixture({ platform = "darwin", compositing = "enabled", software = false, disabled = false, hang = false } = {}) {
  const app = new EventEmitter();
  let reads = 0;
  app.commandLine = { hasSwitch: (name) => disabled && name === "disable-gpu" };
  app.getGPUInfo = async (kind) => {
    assert.equal(kind, "basic", "never run Windows DxDiag through a complete GPU query");
    reads++;
    return hang ? new Promise(() => {}) : { auxAttributes: { softwareRendering: software } };
  };
  app.getGPUFeatureStatus = () => ({ gpu_compositing: compositing });
  return { app, decide: createIntroMotionDecision({ app, platform, timeoutMs: 10 }), reads: () => reads };
}

test("returning users do not wait for or query GPU information", async () => {
  const { decide, reads } = fixture({ platform: "linux", hang: true });
  assert.equal(await Promise.race([decide(true), Promise.resolve("waited")]), false, "return before even one asynchronous wait");
  assert.equal(reads(), 0);
});

test("--disable-gpu selects static Dawn without waiting for GPU initialization", async () => {
  const { decide, reads } = fixture({ disabled: true });
  assert.equal(await decide(false), true);
  assert.equal(reads(), 0);
});

for (const platform of ["darwin", "win32", "linux"]) {
  test(`${platform} caps missing GPU initialization and a stalled basic query`, async () => {
    const missing = fixture({ platform });
    assert.equal(await missing.decide(false), platform === "linux");
    assert.equal(missing.reads(), 0);
    const stalled = fixture({ platform, hang: true });
    stalled.app.emit("gpu-info-update");
    assert.equal(await stalled.decide(false), platform === "linux");
    assert.equal(stalled.reads(), 1);
  });
}

for (const compositing of ["disabled_software", "unavailable_software", "disabled_off"]) {
  test(`${compositing} selects static Dawn after GPU initialization`, async () => {
    const { app, decide, reads } = fixture({ compositing });
    const result = decide(false);
    assert.equal(reads(), 0, "do not read the pre-initialization defaults");
    app.emit("gpu-info-update");
    assert.equal(await result, true);
  });
}

test("GPU initialization observed before the lazy decision preserves animated Dawn", async () => {
  const { app, decide } = fixture();
  app.emit("gpu-info-update");
  assert.equal(await decide(false), false);
});

test("softwareRendering selects static Dawn even with enabled compositing", async () => {
  const { app, decide } = fixture({ software: true });
  app.emit("gpu-info-update");
  assert.equal(await decide(false), true);
});
