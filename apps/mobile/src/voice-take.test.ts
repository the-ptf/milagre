import assert from "node:assert/strict";
import test from "node:test";
import { createMicrophone, createTakeLock, VoiceTake, type AudioPort, type RecorderLike } from "./voice-take.ts";

type Gate = { promise: Promise<void>; open: () => void };
const gate = (): Gate => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

type FakeRecorder = RecorderLike & { name: string; released: boolean; listeners: number; stopped: boolean };

/** A phone whose audio calls can be held open one by one, logging every call it gets. */
function fakePhone() {
  const log: string[] = [];
  const holds = new Map<string, Gate>();
  const recorders: FakeRecorder[] = [];
  const deleted: string[] = [];
  let audioActive = 0;
  const failing = new Set<string>();
  const call = async (name: string) => {
    log.push(name);
    await holds.get(name)?.promise;
    if (failing.has(name)) throw new Error(`${name} failed`);
  };
  const port: AudioPort = {
    configure: () => call("configure"),
    async activate() {
      await call("activate");
      audioActive = 1;
    },
    async deactivate() {
      await call("deactivate");
      audioActive = 0;
    },
    createRecorder() {
      const name = `recorder${recorders.length + 1}`;
      log.push(`create ${name}`);
      const recorder: FakeRecorder = {
        name,
        released: false,
        listeners: 0,
        stopped: false,
        uri: `file://${name}.m4a`,
        isRecording: false,
        addListener() {
          recorder.listeners++;
          return { remove: () => void recorder.listeners-- };
        },
        async prepareToRecordAsync() {
          await call(`prepare ${name}`);
        },
        record() {
          (recorder as { isRecording: boolean }).isRecording = true;
          log.push(`record ${name}`);
        },
        getStatus: () => ({ metering: -30 }),
        async stop() {
          recorder.stopped = true;
          (recorder as { isRecording: boolean }).isRecording = false;
        },
        release() {
          recorder.released = true;
          log.push(`release ${name}`);
        },
      };
      recorders.push(recorder);
      return recorder;
    },
    deleteFile: (path) => void deleted.push(path),
  };
  const lock = createTakeLock();
  return {
    log,
    recorders,
    deleted,
    lock,
    audioActive: () => audioActive,
    fail: (name: string) => void failing.add(name),
    hold: (name: string) => {
      const held = gate();
      holds.set(name, held);
      return held;
    },
    take: () => new VoiceTake(port, lock, 300),
  };
}

const nothingLeft = (phone: ReturnType<typeof fakePhone>) => {
  assert.equal(phone.audioActive(), 0, "the audio session is given back");
  for (const recorder of phone.recorders) {
    assert.equal(recorder.released, true, `${recorder.name} is released`);
    assert.equal(recorder.listeners, 0, `${recorder.name} has no listener`);
    assert.equal(recorder.isRecording, false, `${recorder.name} is not recording`);
  }
};

test("cancelling while the audio mode is being set leaves nothing allocated", async () => {
  const phone = fakePhone();
  const held = phone.hold("configure");
  const take = phone.take();
  const started = take.start(() => {});
  await tick();
  const gone = take.discard();
  held.open();
  assert.equal(await started, false);
  await gone;
  assert.equal(phone.recorders.length, 0, "no recorder was ever built");
  assert.ok(phone.log.includes("deactivate"), "the session that was claimed is given back");
  nothingLeft(phone);
});

test("cancelling while the audio session is being activated releases it and builds no recorder", async () => {
  const phone = fakePhone();
  const held = phone.hold("activate");
  const take = phone.take();
  const started = take.start(() => {});
  await tick();
  const gone = take.discard();
  await tick();
  assert.equal(phone.audioActive(), 0, "nothing is active yet");
  held.open();
  assert.equal(await started, false);
  await gone;
  assert.equal(phone.recorders.length, 0);
  assert.equal(phone.audioActive(), 0);
  assert.equal(phone.log.at(-1), "deactivate", "the activation that landed after the cancel is undone");
});

test("cancelling while the recorder prepares releases the recorder, its listener and its file", async () => {
  const phone = fakePhone();
  const held = phone.hold("prepare recorder1");
  const take = phone.take();
  const started = take.start(() => {});
  await tick();
  const gone = take.discard();
  held.open();
  assert.equal(await started, false);
  await gone;
  assert.equal(phone.recorders.length, 1);
  assert.deepEqual(phone.deleted, ["file://recorder1.m4a"]);
  assert.ok(!phone.log.includes("record recorder1"), "it never started recording");
  nothingLeft(phone);
});

test("cancelling before the take starts waiting, or before the audio session, builds nothing", async () => {
  const phone = fakePhone();
  const earlier = phone.take();
  assert.equal(await earlier.start(() => {}), true);
  const held = phone.hold("deactivate");
  const gone = earlier.discard();
  await tick();
  const next = phone.take();
  const started = next.start(() => {});
  const cancelled = next.discard();
  held.open();
  await gone;
  await cancelled;
  assert.equal(await started, false);
  assert.equal(phone.recorders.length, 1, "only the first take built a recorder");
  nothingLeft(phone);
});

test("a recorder that fails to prepare is released and the failure reaches the caller", async () => {
  const phone = fakePhone();
  phone.fail("prepare recorder1");
  const take = phone.take();
  await assert.rejects(
    take.start(() => {}),
    /prepare recorder1 failed/,
  );
  await take.discard();
  assert.deepEqual(phone.deleted, ["file://recorder1.m4a"]);
  nothingLeft(phone);
});

test("a take that is recording is stopped, released and its file deleted by discard", async () => {
  const phone = fakePhone();
  const take = phone.take();
  assert.equal(await take.start(() => {}), true);
  assert.equal(phone.audioActive(), 1);
  assert.ok(take.level() > 0);
  await take.discard();
  assert.equal(phone.recorders[0]!.stopped, true);
  assert.deepEqual(phone.deleted, ["file://recorder1.m4a"]);
  nothingLeft(phone);
});

test("handing the microphone from take A to take B never gives audio back after B activated it", async () => {
  const phone = fakePhone();
  const microphone = createMicrophone();
  const a = phone.take();
  const ownerA = Symbol("A");
  const ownerB = Symbol("B");
  await microphone.claim(ownerA, () => a.discard());
  assert.equal(await a.start(() => {}), true);
  const slow = phone.hold("deactivate");
  const b = phone.take();
  const handoff = microphone.claim(ownerB, () => Promise.resolve());
  const started = (async () => {
    await handoff;
    return b.start(() => {});
  })();
  await tick();
  assert.ok(!phone.log.includes("create recorder2"), "B waits while A's audio session is still being released");
  slow.open();
  assert.equal(await started, true);
  const activates = phone.log.reduce<number[]>((all, entry, index) => (entry === "activate" ? [...all, index] : all), []);
  const deactivates = phone.log.reduce<number[]>((all, entry, index) => (entry === "deactivate" ? [...all, index] : all), []);
  assert.equal(activates.length, 2);
  assert.equal(deactivates.length, 1);
  assert.ok(deactivates[0]! < activates[1]!, "A's release came before B's activation");
  assert.equal(phone.audioActive(), 1, "B's session is the one left active");
  await b.discard();
  nothingLeft(phone);
});

test("the next take waits for a cancelled take even when nobody awaits the cancel", async () => {
  const phone = fakePhone();
  const a = phone.take();
  await a.start(() => {});
  const slow = phone.hold("deactivate");
  void a.discard();
  const b = phone.take();
  const started = b.start(() => {});
  await tick();
  assert.equal(phone.recorders.length, 1, "B has not touched the session yet");
  slow.open();
  assert.equal(await started, true);
  assert.deepEqual(
    phone.log.filter((entry) => entry === "activate" || entry === "deactivate"),
    ["activate", "deactivate", "activate"],
  );
  assert.equal(phone.audioActive(), 1);
  await b.discard();
});

test("a take cancelled mid-start by the next one is released before the next one activates", async () => {
  const phone = fakePhone();
  const microphone = createMicrophone();
  const a = phone.take();
  const held = phone.hold("activate");
  const ownerA = Symbol("A");
  await microphone.claim(ownerA, () => a.discard());
  const startedA = a.start(() => {});
  await tick();
  phone.hold("activate").open();
  const b = phone.take();
  const handoff = microphone.claim(Symbol("B"), () => Promise.resolve());
  held.open();
  await handoff;
  assert.equal(await startedA, false);
  assert.equal(phone.audioActive(), 0, "A's activation was undone before B may begin");
  assert.equal(await b.start(() => {}), true);
  assert.equal(phone.audioActive(), 1);
  assert.equal(phone.log.filter((entry) => entry === "deactivate").length, 1);
  await b.discard();
  nothingLeft(phone);
});

test("finish gives the audio session back, so a later discard only deletes the file and never deactivates a newer take", async () => {
  const phone = fakePhone();
  const a = phone.take();
  await a.start(() => {});
  const uri = await a.finish();
  assert.equal(uri, "file://recorder1.m4a");
  assert.equal(phone.audioActive(), 0);
  assert.deepEqual(phone.deleted, [], "the file is kept for the transcriber");
  const b = phone.take();
  await b.start(() => {});
  assert.equal(phone.audioActive(), 1);
  await a.discard(uri);
  assert.equal(phone.audioActive(), 1, "A's discard did not deactivate B's session");
  assert.deepEqual(phone.deleted, ["file://recorder1.m4a"]);
  await b.discard();
  assert.equal(phone.audioActive(), 0);
});

test("the microphone's claim resolves only after the previous holder is gone, and not for a holder's own second claim", async () => {
  const microphone = createMicrophone();
  const slow = gate();
  let cancelled = 0;
  const first = Symbol("first");
  await microphone.claim(first, async () => {
    cancelled++;
    await slow.promise;
  });
  let resolved = false;
  const second = microphone.claim(Symbol("second"), () => Promise.resolve()).then(() => (resolved = true));
  await tick();
  assert.equal(cancelled, 1);
  assert.equal(resolved, false);
  slow.open();
  await second;
  assert.equal(resolved, true);
  // Releasing a holder that is no longer current changes nothing.
  microphone.release(first);
  let third = 0;
  await microphone.claim(Symbol("third"), async () => void third++);
  assert.equal(third, 0, "the second holder has no cancel pending on its own claim");
});
