# Computers PR 3a: Allow, and the Desktop's Computer Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Mac holds a new computer's first pairing until its owner clicks Allow in its window, and Electron main gains `computers.cjs`: the client that pairs with another Mac from its link, keeps one remote daemon runtime per paired computer over the LAN or the relay, and reports each computer's status. No screen adds a computer yet (that is PR 3b).

**Architecture:** On the daemon, `phone-channels.cjs` parks a desktop's first hello (sending `0x05 {"t":"pending"}` notices) and asks `phone.cjs`, which keeps the requests and broadcasts `devices:pending` to this Mac's own window; `devices:allow` / `devices:deny` answer them, and a prompt in the window calls those. On the desktop, `peer-client.cjs` speaks the paired-desktop protocol (hello `kind: "desktop"`, then `rpc` / `evt` / `part` from `@milagre/shared/peer-frames`) and presents the same interface as `@milagre/daemon/client`'s `connect`, so `daemon-runtime.cjs` runs over it unchanged except for a new `connect` option (reach a host, never start, flush, stop or restart it). `computers.cjs` ties pairing, the saved list (`computers.json`), the keychain-sealed keys (`computer-keys.json` via `safeStorage`) and the route supervisor, moved to `@milagre/shared` with `parsePairing`.

**Tech Stack:** Node 24 CommonJS daemon and Electron main (`node:test`, `node:assert/strict`), ESM `.mjs` + `.d.mts` in `@milagre/shared`, `tweetnacl` channels, `ws` on the daemon and Node's global `WebSocket` on the desktop, React 19 + Tailwind in the renderer, Electron 44 checks driven by Vite fixtures.

**Spec:** `docs/superpowers/specs/2026-10-08-computers-design.md` (step 3 of "Order of work", plus "Allowing a new computer"). Earlier plans: `docs/superpowers/plans/2026-10-08-computers-pr1-devices.md`, `docs/superpowers/plans/2026-10-08-computers-pr2-channel.md`.

## Scope and the split

Step 3 of the spec plus Allow is 16 tasks, past what one reviewer can hold. It splits in two PRs, each one shippable:

- **PR 3a (this plan):** Allow end to end on the paired Mac (daemon, prompt, notification), the shared move, `peer-client.cjs`, the computers store and keys, `daemon-runtime.cjs`'s `connect` option, `computers.cjs`, and an end-to-end test with a real daemon, a local relay and the real `computers.cjs`. Shipping it alone closes the hole the Allow decision is about (PR 2 lets anyone holding the token pair a full-control computer); with no screen to add a computer, nothing new is visible except the prompt.
- **PR 3b (listed at the end):** Electron main wiring and IPC, Settings › Experimental "Other computers", the footer popover, Add computer, Computer settings.

The prompt sits in 3a rather than 3b: it is the paired Mac's half of the Allow gate, its Electron check runs against the real daemon from Tasks 1-3, and a 3a that held hellos with no way to answer them could never pair a computer.

## Global Constraints

- If the worktree has no `node_modules`, run `npm install` before Task 1.
- Daemon and Electron main code is CommonJS `.cjs`; tests use `node:test` and `node:assert/strict`. Shared code is ESM `.mjs` with a `.d.mts` beside it and a `"./name": { types, default }` entry in `packages/shared/package.json` (the daemon and Electron main `require()` them, as they do `@milagre/shared/relay-crypto`).
- One unit file: `node --test <path>`. One workspace: `npm test -- --unit --workspace <shared|daemon|desktop|mobile>`. All unit tests: `npm test -- --unit`. One Electron check: `npm test -- --only <name>`.
- Allow, verbatim from the spec: "A new computer's first pairing waits for Allow on the Mac being paired. Phones pair as before." The prompt reads "studio wants to drive this Mac's chats" with Allow and Deny. "Deny refuses it with `reason: "denied"` and saves nothing. A request that gets no answer within the pairing window, or whose channel closes, is dropped. Known computers reconnect without asking." `devices:pending` goes to this Mac's own window only ("never to desktops: `devices:*` is denied").
- Error copy, verbatim from the spec's "Errors": "Removed on studio. Pair again with a new link.", "This link expired. Copy a new one on studio.", "Update Milagre on studio to connect.", "studio has too many devices connected. Remove one in its Settings › Devices."
- `computers.json` in userData: `[{ id, hostId, name, relay, lanRoutes, addedAt }]` plus `lastSeen` (for "Offline, seen 2h ago" across launches). "The pinned host key and the desktop's own keypair live in the keychain through `safeStorage`", and so does each computer's pairing token (every hello carries it).
- Transport: "LAN first, relay otherwise, re-checked on connect, every 60 s and on network change." A computer that stops answering is "Reconnecting…", then "Offline" after 30 s.
- Rollout: `computers.cjs` connects nothing until `setEnabled(true)`, which PR 3b calls from Settings › Experimental "Other computers" (default off). PR 3a wires nothing of it into `main.cjs`. The Allow prompt is not behind the flag: the computer asking has it on, this Mac may not.
- Desktop and mobile sync: the phone gets nothing new in PR 3a or 3b (the spec: "A merged multi-computer list on the phone is a follow-up"; the phone never pairs computers or shows Allow). Its only change is Task 5's move of `parsePairing` and the route supervisor into `@milagre/shared`, with no behavior change: JS only, the fingerprint must not change, and the phone ships it as an OTA after merge (Task 11).
- The relay caps frames at 1 MiB and rooms at 16 devices (`apps/relay/src/room.mjs:4-5`), closing a socket it turns away with 4404 (no Mac) or 4429 (room full) (`room.mjs:107-111`), and one the Mac closes with 1000 (`room.mjs:158-160`).
- Every task that changes a payload the window reads or a screen runs that screen's Electron check (PR 2 broke `test-settings-devices` by skipping it). Checks start their own Vite and Electron with their own ports and profiles; never kill Milagre by name.
- Commits: conventional messages, no Claude or Anthropic co-author trailer or footer, ever. The pre-commit hook runs `oxlint` and `oxfmt --check` on staged files: run `npx oxfmt <files>` before `git add`.

## Review Focus

- A held hello that waits minutes for Allow: the hello timer (15 s, `phone-channels.cjs:314-316`) would drop it, and an idle relay socket can time out. The Mac repeats its pending notice every 20 s and the desktop treats each as a sign of life. Pinned in Task 1 (the hello outlasts `helloMs` with notices) and Task 6 (the desktop waits).
- The owner clicks Allow after the computer gave up (its socket closed): nothing may be saved and no daemon connection opened, and the window hears the request is gone. Pinned in Task 2 (a dropped request can't be allowed) and Task 3 (end to end, `devices:allow` answers "no longer waiting" and `devices:list` stays as it was).
- A computer removed on the Mac it drives while this desktop is connected: its runtime must stop redialing the relay with hellos that are refused, and say "Removed on studio. Pair again with a new link." Pinned in Task 10.
- A Mac from before PR 1 takes the desktop's hello as a phone's and closes on the first `rpc`: this must read as "Update Milagre on studio to connect.", not a network failure. Pinned in Task 6.
- Pasting a link for a computer already added, or this Mac's own link: refused with words that say so, before any socket opens. Pinned in Task 9.

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `apps/daemon/src/phone-channels.cjs` | modify | Hold a computer's first hello until `allowComputer` answers; pending notices; refusals |
| `apps/daemon/src/relay-host.cjs` | modify | Pass `allowComputer` and `timing.pendingRepeatMs` through |
| `apps/daemon/src/relay-test-kit.cjs` | modify | `connectDesktop` reads pending notices; `startTestMac` (moved from `peer-e2e.test.cjs`) with `autoAllow` and `lan` |
| `apps/daemon/src/relay-host.test.cjs` | modify | Allow at the channel level |
| `apps/daemon/src/phone.cjs`, `phone.test.cjs` | modify | Pending requests: `allowComputer`, `allowDevice`, `denyDevice`, `pendingDevices`, `onPending` |
| `apps/daemon/src/server.cjs` | modify | `devices:pending` event; `devices:pending` / `devices:allow` / `devices:deny` methods |
| `apps/daemon/src/server-devices.test.cjs` | modify | The methods and the event |
| `apps/daemon/src/peer-e2e.test.cjs` | modify | Use `startTestMac`; Allow, Deny and a late Allow end to end |
| `apps/desktop/app/src/lib/pending-computers.ts`, `.test.ts` | create | Prompt copy |
| `apps/desktop/app/src/components/ComputerAllowPrompt.tsx` | create | The Allow / Deny dialog |
| `apps/desktop/app/src/App.tsx` | modify | Mount the prompt beside the app |
| `apps/desktop/app/src/electron.d.ts`, `apps/desktop/electron/preload.cjs` | modify | `PendingComputer`, `listPendingDevices`, `allowDevice`, `denyDevice`, `onDevicesPending` |
| `apps/desktop/electron/notifications.cjs`, `.test.cjs`, `main.cjs` | modify | "studio wants to drive this Mac's chats" notification; no "New computer paired" after Allow |
| `scripts/test-allow-computer.cjs` | create | Electron check of the prompt against a real daemon |
| `packages/shared/src/pairing-link.mjs`, `.d.mts`, `.test.mjs` | create | `parsePairing` and its helpers, moved from mobile; `allowLocalRelay` |
| `packages/shared/src/route-supervisor.mjs`, `.d.mts` | create | The route supervisor, moved from mobile, generic over its transport |
| `packages/shared/package.json` | modify | Export both |
| `apps/mobile/src/pairing.ts`, `routes.ts`, `client.ts` | modify | Re-export from `@milagre/shared` |
| `apps/desktop/electron/peer-client.cjs`, `.test.cjs` | create | One paired-desktop channel shaped like the daemon socket client |
| `apps/desktop/electron/computer-errors.cjs`, `.test.cjs` | create | Refusal and failure copy |
| `apps/desktop/electron/computers-store.cjs`, `.test.cjs` | create | `computers.json`; LAN routes from a `peer:routes` answer |
| `apps/desktop/electron/computer-keys.cjs`, `.test.cjs` | create | This Mac's key pair and each computer's key and token, sealed with `safeStorage` |
| `apps/desktop/electron/daemon-runtime.cjs`, `.test.cjs` | modify | `connect` option: a host reached, never started, flushed, stopped or restarted |
| `apps/desktop/electron/computers.cjs`, `.test.cjs` | create | Pairing, routes, one runtime per computer, status |
| `apps/desktop/electron/computers-e2e.test.cjs` | create | Real daemon + local relay + LAN + `computers.cjs` |

Not moved: `apps/mobile/src/relay-transport.ts`. The spec moves `createRelayTransport` to `packages/shared`, but it is the phone's HTTP-over-channel client (`req`/`res`/`live`, `relay-transport.ts:138-186` and `354-369`) and its socket, randomness and timers are already injected (`relay-transport.ts:35-37`). A desktop speaks `rpc`/`evt`/`part`; the only part the two share is the ~40-line handshake. Making the transport's protocol pluggable would rewrite the phone's most important file for no phone gain, and need a full phone re-test. `peer-client.cjs` instead mirrors its handshake and timing (15 s hello, 20 s ping, 45 s silence, 4404) with a comment pointing at it.

---

### Task 1: The hello waits for Allow

**Files:**
- Modify: `apps/daemon/src/phone-channels.cjs:1-19` (constants), `:43` (options), `:61-70` (`dropConn`), `:77-132` (`hello`), `:299-317` (the record)
- Modify: `apps/daemon/src/relay-host.cjs:12-20`, `:33-49`
- Modify: `apps/daemon/src/relay-test-kit.cjs:209-310` (`connectDesktop`)
- Test: `apps/daemon/src/relay-host.test.cjs`

**Interfaces:**
- Consumes: `hostAccept` (`@milagre/shared/relay-crypto`), `openPeerChannel` (PR 2).
- Produces: `createPhoneChannels({ ..., allowComputer, pendingRepeatMs })` and `startRelayHost({ ..., allowComputer, timing: { pendingRepeatMs } })`, where `allowComputer({ key: string, name: string | null, signal: AbortSignal, waiting: () => void }) => Promise<"allowed" | "denied" | "expired" | "busy" | "dropped">`. It calls `waiting()` once when it holds the request. Refusals: denied `{ t: "error", code: "unknown-phone", reason: "denied" }`, busy `{ ..., reason: "busy" }`, expired or no `allowComputer` `{ t: "error", code: "unknown-phone" }`. The pending notice is the raw frame `0x05` + `{"t":"pending"}`, sent outside the channel (not yet open), now and every `pendingRepeatMs` (20 s).
- Produces (test kit): `connectDesktop(...).hello({ ms })` waits through notices (each restarts its `ms`), and `desktop.notices` lists them.

- [ ] **Step 1: Teach the test kit's desktop to wait through pending notices**

In `apps/daemon/src/relay-test-kit.cjs`, inside `connectDesktop`, replace the `hello()` method with:

```js
    /** Resolves with the channel, or with { error } when the Mac refused the hello. Waits through pending notices (Allow). */
    async hello({ ms = 5000 } = {}) {
      await opened;
      const { message, ephemeral } = phoneHello({ phone: key, host: identity.box.publicKey, token, random, name, kind: "desktop" });
      const reply = await new Promise((resolve, reject) => {
        let timer;
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => reject(new Error("Timed out waiting for the hello's reply")), ms);
        };
        arm();
        onReply = (bytes) => {
          // A computer's first hello waits for Allow; the Mac says so, and again every few seconds.
          if (bytes[0] === 0x05) {
            desktop.notices.push(JSON.parse(new TextDecoder().decode(bytes.subarray(1))));
            arm();
            return;
          }
          clearTimeout(timer);
          onReply = null;
          resolve(bytes);
        };
        ws.send(message);
      });
      if (reply[0] === 0x04) return { error: JSON.parse(new TextDecoder().decode(reply.subarray(1))) };
      channel = phoneFinish({ ephemeral, phone: key, host: identity.box.publicKey, reply });
      for (const bytes of early.splice(0)) take(bytes);
      return { channel };
    },
```

and add `notices: [],` to the `desktop` object, after `error: null,`.

- [ ] **Step 2: Let the test Mac take an `allowComputer`, allowing by default**

In `apps/daemon/src/relay-host.test.cjs`, replace the first line of `startMac` and its `startRelayHost` call's `openPeer,` line:

```js
async function startMac(
  t,
  { relayUrl, bridgeUrl, canPair = () => false, token = TOKEN, timing, onStatus, openPeer, allowComputer = async () => "allowed", WebSocket } = {},
) {
```

```js
    openPeer,
    allowComputer,
```

- [ ] **Step 3: Write the failing tests**

Append to `apps/daemon/src/relay-host.test.cjs`:

```js
/** An owner who answers when the test says: each request is recorded, and `answer(verdict)` settles the latest. */
function owner() {
  const asked = [];
  return {
    asked,
    allowComputer: (request) =>
      new Promise((resolve) => {
        asked.push({ ...request, answer: resolve });
        request.waiting();
      }),
    answer: (verdict) => asked.at(-1).answer(verdict),
  };
}

test("a computer's first hello waits for Allow, and only then is saved and gets its daemon connection", async (t) => {
  const daemon = fakePeerDaemon();
  const you = owner();
  const { relay, mac } = await paired(t, { mac: { openPeer: daemon.openPeer, allowComputer: you.allowComputer } });
  const desktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity, name: "studio" });
  t.after(() => desktop.close());
  const hello = desktop.hello({ ms: 10_000 });
  await until(() => desktop.notices.length > 0, "the pending notice");
  assert.deepEqual(desktop.notices[0], { t: "pending" });
  assert.deepEqual(
    you.asked.map(({ key, name }) => [key, name]),
    [[b64url(desktop.key.publicKey), "studio"]],
  );
  assert.equal(mac.phones.count(), 0, "nothing saved before Allow");
  assert.equal(daemon.connections.length, 0, "no daemon connection before Allow");
  assert.deepEqual(mac.host.connectedKeys(), [], "a waiting computer isn't connected");
  you.answer("allowed");
  assert.ok((await hello).channel);
  assert.deepEqual(
    mac.phones.list().map((device) => [device.kind, device.name]),
    [["computer", "studio"]],
  );
  assert.deepEqual((await desktop.call("daemon:status")).result, { echo: [] });
});

test("Deny, a request past its window and a busy Mac turn the computer away with their reasons, saving nothing", async (t) => {
  for (const [verdict, error] of [
    ["denied", { t: "error", code: "unknown-phone", reason: "denied" }],
    ["expired", { t: "error", code: "unknown-phone" }],
    ["busy", { t: "error", code: "unknown-phone", reason: "busy" }],
  ]) {
    const daemon = fakePeerDaemon();
    const { relay, mac } = await paired(t, { mac: { openPeer: daemon.openPeer, allowComputer: async () => verdict } });
    const desktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity });
    t.after(() => desktop.close());
    assert.deepEqual(await desktop.hello(), { error }, verdict);
    assert.equal(mac.phones.count(), 0, verdict);
    assert.equal(daemon.connections.length, 0, verdict);
  }
});

test("a phone pairs as before and a known computer reconnects, neither asking", async (t) => {
  const asked = [];
  const daemon = fakePeerDaemon();
  const { relay, mac, connect } = await paired(t, {
    mac: {
      openPeer: daemon.openPeer,
      allowComputer: async (request) => {
        asked.push(request.key);
        return "allowed";
      },
    },
  });
  await connect();
  const desktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity });
  t.after(() => desktop.close());
  assert.ok((await desktop.hello()).channel);
  assert.equal(asked.length, 1, "the computer's first pairing asked");
  const again = connectDesktop({ relayUrl: relay.url, identity: mac.identity, key: desktop.key });
  t.after(() => again.close());
  assert.ok((await again.hello()).channel);
  assert.equal(asked.length, 1, "its reconnect did not");
});

test("a held hello outlasts the hello timeout, hearing a notice every few seconds", async (t) => {
  const daemon = fakePeerDaemon();
  const you = owner();
  const { relay, mac } = await paired(t, {
    mac: { openPeer: daemon.openPeer, allowComputer: you.allowComputer, timing: { helloMs: 200, pendingRepeatMs: 40 } },
  });
  const desktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity });
  t.after(() => desktop.close());
  const hello = desktop.hello({ ms: 10_000 });
  await sleep(600);
  assert.ok(desktop.notices.length >= 3, `notices: ${desktop.notices.length}`);
  you.answer("allowed");
  assert.ok((await hello).channel, "still open after three hello timeouts");
});

test("a computer that leaves while it waits drops its request", async (t) => {
  const you = owner();
  const { relay, mac } = await paired(t, { mac: { openPeer: fakePeerDaemon().openPeer, allowComputer: you.allowComputer } });
  const desktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity });
  void desktop.hello({ ms: 2000 }).catch(() => {});
  await until(() => you.asked.length === 1, "the request");
  desktop.close();
  await until(() => you.asked[0].signal.aborted, "the request dropped");
  assert.equal(mac.phones.count(), 0);
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `node --test apps/daemon/src/relay-host.test.cjs`
Expected: FAIL. The new tests time out waiting for "the pending notice" or get a channel at once; the older desktop tests still pass.

- [ ] **Step 5: Hold a computer's first hello in `phone-channels.cjs`**

Below `const ERROR_MARK = 0x04;` add:

```js
// Sent before a computer's first hello is answered: the Mac is waiting for its owner's Allow (phone.cjs).
const PENDING_MARK = 0x05;
// Repeated while the owner decides, so the desktop knows the Mac is still there and the relay doesn't drop an idle socket.
const PENDING_REPEAT_MS = 20_000;
```

and below `const encoder = new TextEncoder();`:

```js
const PENDING_NOTICE = new Uint8Array([PENDING_MARK, ...encoder.encode('{"t":"pending"}')]);
// What a refused computer hears for each answer that isn't Allow; "expired" and "dropped" add nothing to unknown-phone.
const NOT_ALLOWED = { denied: { reason: "denied" }, busy: { reason: "busy" } };
```

Add to the doc comment above `createPhoneChannels`, after its last sentence:

```js
 * A computer's first hello waits for `allowComputer({ key, name, signal, waiting })` (phone.cjs), which resolves
 * "allowed", "denied", "expired", "busy" or "dropped" and calls `waiting()` once it holds the request.
```

Replace the signature line with:

```js
function createPhoneChannels({
  identity,
  phones,
  token,
  bridgeUrl,
  canPair,
  retired = false,
  WebSocket,
  fetch: fetchBridge,
  random,
  helloMs,
  openPeer,
  allowComputer,
  pendingRepeatMs = PENDING_REPEAT_MS,
}) {
```

In `dropConn`, after `clearTimeout(record.helloTimer);` add:

```js
    // A computer still waiting for Allow: its request goes with its channel.
    record.abort?.abort();
```

Above `async function hello(`, add:

```js
  /**
   * Holds a computer's first hello until this Mac's owner answers. The channel stays open with no daemon connection;
   * the desktop hears PENDING_NOTICE (outside the channel, which isn't open yet) now and every pendingRepeatMs, and
   * anything it sends meanwhile drops it (onFrame only reads open channels). No `allowComputer`: no one can say yes.
   */
  async function waitForAllow(current, conn, record, accepted) {
    if (!allowComputer) return "expired";
    record.state = "pending";
    clearTimeout(record.helloTimer);
    const abort = new AbortController();
    record.abort = abort;
    const notice = () => sendFrame(current, DATA, conn, PENDING_NOTICE);
    try {
      return await allowComputer({
        key: accepted.phoneKey,
        name: accepted.name,
        signal: abort.signal,
        waiting() {
          notice();
          record.pendingTimer = setInterval(notice, pendingRepeatMs);
        },
      });
    } catch {
      return "dropped";
    } finally {
      clearInterval(record.pendingTimer);
      record.pendingTimer = null;
      record.abort = null;
    }
  }
```

In `hello()`, replace:

```js
    // Set before any wait, so a removal that lands meanwhile finds this channel.
    record.key = accepted.phoneKey;
    if (accepted.firstPairing) {
```

with:

```js
    // Set before any wait, so a removal that lands meanwhile finds this channel.
    record.key = accepted.phoneKey;
    // A computer's first pairing waits for its owner's Allow on this Mac; nothing is saved before it.
    if (accepted.firstPairing && kind === "computer") {
      const verdict = await waitForAllow(current, conn, record, accepted);
      if (current.conns.get(conn) !== record) return;
      if (verdict !== "allowed") return refuse(current, conn, "unknown-phone", NOT_ALLOWED[verdict]);
    }
    if (accepted.firstPairing) {
```

In `onFrame`, add to the new record, after `peer: null,`:

```js
        abort: null,
        pendingTimer: null,
```

- [ ] **Step 6: Pass `allowComputer` and `pendingRepeatMs` through the relay host**

In `apps/daemon/src/relay-host.cjs`, add `pendingRepeatMs: 20_000,` to `DEFAULT_TIMING` after `helloMs: 15_000,`, add `allowComputer,` to `startRelayHost`'s parameters after `openPeer,`, and replace its first two lines of body with:

```js
  const { pingMs, idleMs, helloMs, backoff, replacedMs, stableMs, jitter, pendingRepeatMs } = { ...DEFAULT_TIMING, ...timing };
  const channels = createPhoneChannels({
    identity,
    phones,
    token,
    bridgeUrl,
    canPair,
    retired,
    WebSocket,
    fetch: fetchBridge,
    random,
    helloMs,
    openPeer,
    allowComputer,
    pendingRepeatMs,
  });
```

The LAN host needs neither: it never pairs (`canPair: () => false`, `lan-host.cjs:58`).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test apps/daemon/src/relay-host.test.cjs apps/daemon/src/lan-host.test.cjs`
Expected: PASS (every test in both files).

- [ ] **Step 8: Commit**

```bash
npx oxfmt apps/daemon/src/phone-channels.cjs apps/daemon/src/relay-host.cjs apps/daemon/src/relay-test-kit.cjs apps/daemon/src/relay-host.test.cjs
git add apps/daemon/src/phone-channels.cjs apps/daemon/src/relay-host.cjs apps/daemon/src/relay-test-kit.cjs apps/daemon/src/relay-host.test.cjs
git commit -m "feat(daemon): a computer's first hello waits for Allow"
```

---

### Task 2: Phone access keeps the waiting requests

**Files:**
- Modify: `apps/daemon/src/phone.cjs:17-27` (constants), `:48-92` (options, `peer`), `:205-212` (`teardown`), `:370-379` (returned methods)
- Test: `apps/daemon/src/phone.test.cjs`

**Interfaces:**
- Consumes: Task 1's `allowComputer` contract.
- Produces: `createPhone({ ..., onPending })` with `onPending(requests)` on every change; the relay host gets `allowComputer` with `openPeer` (none on a confined phone). New methods: `pendingDevices(): Array<{ key, name, at }>` (oldest first), `allowDevice(key)` and `denyDevice(key)`, each returning `pendingDevices()` after the answer and throwing `"That computer is no longer waiting. Ask it to pair again."` for a key that isn't waiting. A request expires when the pairing window open at its hello closes; a second request from the same key replaces the first ("dropped"); past `MAX_PENDING_COMPUTERS = 4` the hello is "busy"; turning phone access off, a reset or a close drops them all.

- [ ] **Step 1: Write the failing tests**

In `apps/daemon/src/phone.test.cjs`, replace the test "the relay and LAN hosts get openPeer, and a confined phone never hosts a desktop" with:

```js
test("the relay and LAN hosts get openPeer and allowComputer, and a confined phone never hosts a desktop", async (t) => {
  const openPeer = () => ({ receive() {}, invalid() {}, close() {} });
  const open = await fixture(t, { phoneOptions: { openPeer } });
  await open.phone.setEnabled(true);
  await open.phone.settled();
  assert.equal(open.relays[0].options.openPeer, openPeer);
  assert.equal(typeof open.relays[0].options.allowComputer, "function");
  assert.equal(open.lans[0].options.openPeer, openPeer);
  const confined = await fixture(t, { phoneOptions: { openPeer, allowedRoot: "/tmp/milagre-demo" } });
  await confined.phone.setEnabled(true);
  await confined.phone.settled();
  assert.equal(confined.relays[0].options.openPeer, undefined);
  assert.equal(confined.relays[0].options.allowComputer, undefined);
  assert.equal(confined.lans.length, 0);
});
```

and append:

```js
/** Phone access on, with every pending list it announced, and a way to ask as a computer's hello does. */
async function asking(t, options = {}) {
  const announced = [];
  const fixed = await fixture(t, { ...options, phoneOptions: { openPeer: () => ({}), onPending: (list) => announced.push(list) } });
  await fixed.phone.setEnabled(true);
  await fixed.phone.settled();
  const ask = (key, name = null) => {
    const abort = new AbortController();
    const request = { waited: false, abort };
    request.verdict = fixed.relays[0].options.allowComputer({
      key,
      name,
      signal: abort.signal,
      waiting: () => {
        request.waited = true;
      },
    });
    return request;
  };
  return { ...fixed, announced, ask };
}

test("a new computer waits for its owner: listed, then allowed or denied", async (t) => {
  const { phone, announced, ask } = await asking(t);
  const studio = ask("deskA", "studio");
  const nameless = ask("deskB");
  assert.equal(studio.waited && nameless.waited, true, "both told to wait");
  assert.deepEqual(phone.pendingDevices(), [
    { key: "deskA", name: "studio", at: 0 },
    { key: "deskB", name: null, at: 0 },
  ]);
  assert.deepEqual(
    announced.at(-1).map((request) => request.key),
    ["deskA", "deskB"],
  );
  assert.deepEqual(
    phone.allowDevice("deskA").map((request) => request.key),
    ["deskB"],
  );
  assert.equal(await studio.verdict, "allowed");
  assert.deepEqual(phone.denyDevice("deskB"), []);
  assert.equal(await nameless.verdict, "denied");
  assert.deepEqual(announced.at(-1), []);
  assert.throws(() => phone.allowDevice("deskA"), /no longer waiting/);
  assert.throws(() => phone.denyDevice("nope"), /no longer waiting/);
});

test("a request expires with the pairing window it arrived in, and one after the window isn't held at all", async (t) => {
  const { phone, clock, ask } = await asking(t);
  clock.now = PAIRING_WINDOW_MS - 30;
  const late = ask("deskA", "studio");
  assert.equal(late.waited, true);
  assert.equal(await late.verdict, "expired");
  assert.deepEqual(phone.pendingDevices(), []);
  clock.now = PAIRING_WINDOW_MS;
  const after = ask("deskB", "lab");
  assert.equal(await after.verdict, "expired");
  assert.equal(after.waited, false, "never shown");
});

test("a request whose computer left is dropped, and a late Allow finds nothing", async (t) => {
  const { phone, announced, ask } = await asking(t);
  const gone = ask("deskA", "studio");
  gone.abort.abort();
  assert.equal(await gone.verdict, "dropped");
  assert.deepEqual(announced.at(-1), []);
  assert.throws(() => phone.allowDevice("deskA"), /no longer waiting/);
});

test("a computer's second hello replaces its first request, and a fifth computer at once is busy", async (t) => {
  const { phone, ask } = await asking(t);
  const first = ask("deskA", "studio");
  const second = ask("deskA", "studio");
  assert.equal(await first.verdict, "dropped");
  assert.deepEqual(
    phone.pendingDevices().map((request) => request.key),
    ["deskA"],
  );
  for (const key of ["deskB", "deskC", "deskD"]) ask(key);
  const fifth = ask("deskE");
  assert.equal(await fifth.verdict, "busy");
  assert.equal(fifth.waited, false);
  assert.equal(phone.pendingDevices().length, 4);
  phone.allowDevice("deskA");
  assert.equal(await second.verdict, "allowed");
});

test("turning phone access off drops every waiting request", async (t) => {
  const { phone, ask } = await asking(t);
  const waiting = ask("deskA", "studio");
  await phone.setEnabled(false);
  await phone.settled();
  assert.equal(await waiting.verdict, "dropped");
  assert.deepEqual(phone.pendingDevices(), []);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test apps/daemon/src/phone.test.cjs`
Expected: FAIL with `TypeError: fixed.relays[0].options.allowComputer is not a function` (and `phone.pendingDevices is not a function`).

- [ ] **Step 3: Keep the requests in `phone.cjs`**

Below `const PHONE_KEY = /^[A-Za-z0-9_-]{43}$/;` add:

```js
// Computers waiting for Allow at once; more are turned away ("busy") so a leaked link can't flood the window's prompt.
const MAX_PENDING_COMPUTERS = 4;
const NOT_WAITING = "That computer is no longer waiting. Ask it to pair again.";
```

Add to the doc comment above `createPhone`, after "desktop where to reach this Mac.":

```js
 * A computer's first pairing waits for its owner: `allowComputer` (handed to the relay host with `openPeer`) holds the
 * request until `allowDevice` or `denyDevice`, the end of the pairing window it arrived in, or its channel closing.
 * `onPending(requests)` hears the list of waiting `{ key, name, at }` after each change; `pendingDevices()` reads it.
```

Add `onPending = () => {},` to `createPhone`'s parameters after `onPaired = () => {},`, and replace:

```js
  // What the relay and LAN hosts get to serve paired desktops: nothing on a confined phone.
  const peer = openPeer && allowedRoot === undefined ? { openPeer } : {};
```

with:

```js
  // What the relay and LAN hosts get to serve paired desktops: nothing on a confined phone.
  const peer = openPeer && allowedRoot === undefined ? { openPeer, allowComputer } : {};
  /** Computers waiting for Allow, by key, oldest first: { key, name, at, settle(verdict) }. */
  const pending = new Map();
  const pendingList = () => [...pending.values()].map(({ key, name, at }) => ({ key, name, at }));
  function pendingChanged() {
    try {
      onPending(pendingList());
    } catch {
      /* a listener must not break the setting */
    }
  }
  /**
   * Holds a computer's first hello (phone-channels.cjs) until its owner answers. It expires when the pairing window
   * open at its hello closes; its channel closing (`signal`) or a second hello from the same key drops it.
   */
  function allowComputer({ key, name = null, signal, waiting }) {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve("dropped");
      const left = pairingUntil - now();
      if (left <= 0) return resolve("expired");
      pending.get(key)?.settle("dropped");
      if (pending.size >= MAX_PENDING_COMPUTERS) return resolve("busy");
      const entry = { key, name, at: now(), settle };
      const timer = setTimeout(() => settle("expired"), left);
      const onAbort = () => settle("dropped");
      signal?.addEventListener("abort", onAbort, { once: true });
      function settle(verdict) {
        if (pending.get(key) !== entry) return;
        pending.delete(key);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        pendingChanged();
        resolve(verdict);
      }
      pending.set(key, entry);
      waiting?.();
      pendingChanged();
    });
  }
  function answerPending(key, verdict) {
    const entry = pending.get(key);
    if (!entry) throw new Error(NOT_WAITING);
    entry.settle(verdict);
    return pendingList();
  }
```

In `teardown()`, add as its first line:

```js
    // Their channels close with the hosts; a request whose channel outlives this run must not be answerable.
    for (const entry of [...pending.values()]) entry.settle("dropped");
```

In the returned object, after `devices,` add:

```js
    /** Computers waiting for Allow, oldest first. */
    pendingDevices: () => pendingList(),
    /** Lets a waiting computer pair; returns the ones still waiting. */
    allowDevice: (key) => answerPending(key, "allowed"),
    /** Turns a waiting computer away; returns the ones still waiting. */
    denyDevice: (key) => answerPending(key, "denied"),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test apps/daemon/src/phone.test.cjs`
Expected: PASS (every test in the file).

- [ ] **Step 5: Commit**

```bash
npx oxfmt apps/daemon/src/phone.cjs apps/daemon/src/phone.test.cjs
git add apps/daemon/src/phone.cjs apps/daemon/src/phone.test.cjs
git commit -m "feat(daemon): phone access keeps computers waiting for Allow"
```

---

### Task 3: The daemon asks its own window

**Files:**
- Modify: `apps/daemon/src/server.cjs:24` (`DEVICE_METHODS`), `:384-391` (`createPhone`), `:548-550` (dispatch)
- Modify: `apps/daemon/src/relay-test-kit.cjs` (add `startTestMac`)
- Modify: `apps/daemon/src/peer-e2e.test.cjs:1-79` (use `startTestMac`)
- Test: `apps/daemon/src/server-devices.test.cjs`, `apps/daemon/src/peer-e2e.test.cjs`

**Interfaces:**
- Consumes: Task 2's `pendingDevices`, `allowDevice`, `denyDevice`, `onPending`.
- Produces: event `devices:pending` with payload `{ requests: Array<{ key: string, name: string | null, at: number }> }`, to policy-less connections only (the broadcast filter at `server.cjs:309` already skips `devices:*` for paired desktops). Methods, socket only (`devices:` is in the deny set, `peer-policy.cjs:4`): `devices:pending()`, `devices:allow(key)`, `devices:deny(key)`, each resolving the list still waiting.
- Produces (test kit): `startTestMac(t, { autoAllow = true, lan = true }) => Promise<{ clock, client, project, identity, token, dial, relay, dataDir }>`. With `autoAllow` the Mac's own client allows every request it hears; with `lan: false` the Mac has no LAN listener.

- [ ] **Step 1: Write the failing server test**

Append to `apps/daemon/src/server-devices.test.cjs`:

```js
/** A daemon whose relay host is a stand-in that only records its options, and this Mac's window connected to it. */
async function withRelays(t) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-devices-")));
  const relays = [];
  const daemon = await startDaemon({
    dataDir,
    version: "test",
    phoneOptions: {
      localPort: 0,
      lanPort: null,
      startRelay: (options) => {
        relays.push(options);
        return { close: async () => {}, status: () => "online" };
      },
    },
    runtimeOptions: {
      cwd: dataDir,
      environmentReady: Promise.resolve(),
      titleModels: {},
      agentCli: Object.assign(async () => ({ command: null }), { invalidate() {} }),
    },
  });
  const desktop = await connect({ dataDir });
  t.after(async () => {
    desktop.close();
    await daemon.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { desktop, relays };
}

test("a computer waiting for Allow reaches this Mac's window as devices:pending, answered by devices:allow and devices:deny", async (t) => {
  const { desktop, relays } = await withRelays(t);
  const heard = [];
  desktop.on("event", ({ channel, payload }) => {
    if (channel === "devices:pending") heard.push(payload.requests);
  });
  const methods = (await desktop.call("daemon:status")).methods;
  for (const method of ["devices:pending", "devices:allow", "devices:deny"]) assert.ok(methods.includes(method), method);
  assert.deepEqual(await desktop.call("devices:pending"), []);
  await desktop.call("phone:set-enabled", [true]);
  await waitFor(async () => (await desktop.call("phone:status")).state === "on");
  const ask = (key, name) => relays[0].allowComputer({ key, name, signal: new AbortController().signal, waiting() {} });
  const studio = ask("s".repeat(43), "studio");
  const lab = ask("l".repeat(43), "lab");
  await waitFor(() => heard.at(-1)?.length === 2);
  assert.deepEqual(
    (await desktop.call("devices:pending")).map((request) => request.name),
    ["studio", "lab"],
  );
  assert.deepEqual(
    (await desktop.call("devices:allow", ["s".repeat(43)])).map((request) => request.name),
    ["lab"],
  );
  assert.equal(await studio, "allowed");
  assert.deepEqual(await desktop.call("devices:deny", ["l".repeat(43)]), []);
  assert.equal(await lab, "denied");
  await waitFor(() => heard.at(-1)?.length === 0);
  await assert.rejects(desktop.call("devices:allow", ["s".repeat(43)]), /no longer waiting/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test apps/daemon/src/server-devices.test.cjs`
Expected: FAIL with `AssertionError: devices:pending` (the method isn't listed).

- [ ] **Step 3: Serve the methods and the event**

In `apps/daemon/src/server.cjs`, replace `DEVICE_METHODS` with:

```js
// Paired phones and computers, listed and removed from this Mac's own window only (Settings > Devices), and the
// computers waiting for its Allow.
const DEVICE_METHODS = Object.freeze(["devices:list", "devices:remove", "devices:pending", "devices:allow", "devices:deny"]);
```

In the `createPhone({...})` call, after `onPaired: (info) => broadcast("phone:paired", info),` add:

```js
    // Only this Mac's window hears it: paired desktops are never sent devices:* events (see broadcast).
    onPending: (requests) => broadcast("devices:pending", { requests }),
```

In `dispatch`, after the `devices:remove` branch add:

```js
        else if (request.method === "devices:pending") result = phone.pendingDevices();
        else if (request.method === "devices:allow") result = phone.allowDevice(request.args[0]);
        else if (request.method === "devices:deny") result = phone.denyDevice(request.args[0]);
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test apps/daemon/src/server-devices.test.cjs`
Expected: PASS.

- [ ] **Step 5: Move the throwaway Mac into the test kit, allowing by default**

In `apps/daemon/src/relay-test-kit.cjs`, add above `module.exports`:

```js
/**
 * A throwaway Mac: its own data folder, a local relay in place of relay.milagre.cloud, the LAN on a port the OS picks
 * on 127.0.0.1 (none with `lan: false`), and a clock the test moves (pairing windows). Never Victor's data folder, 8797
 * or 8798. `autoAllow`: this Mac's window allows every computer that asks, as its owner would.
 */
async function startTestMac(t, { autoAllow = true, lan = true } = {}) {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const { startDaemon } = require("./server.cjs");
  const { connect } = require("./client.cjs");
  const { readIdentity } = require("./relay-identity.cjs");
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "peer-e2e-")));
  const dataDir = path.join(directory, "profile");
  const project = path.join(directory, "project");
  await fs.mkdir(project);
  const clock = { now: 1_000_000 };
  const sockets = [];
  let daemon;
  let client;
  // Registered before the relay's own hook, so the daemon closes while the relay still answers; the folder goes last.
  t.after(async () => {
    for (const socket of sockets) socket.close();
    client?.close();
    try {
      await daemon?.close();
    } finally {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  const relay = await startLocalRelay(t);
  daemon = await startDaemon({
    dataDir,
    version: "9.8.7",
    runtimeOptions: { cwd: project, environmentReady: Promise.resolve(), titleModels: {}, readPullRequests: async (_worktree, refs) => refs },
    phoneOptions: {
      relayUrl: relay.url,
      localPort: 0,
      lanPort: lan ? 0 : null,
      lanHostname: "127.0.0.1",
      addresses: () => ["127.0.0.1"],
      now: () => clock.now,
    },
  });
  client = await connect({ dataDir });
  if (autoAllow)
    client.on("event", ({ channel, payload }) => {
      if (channel !== "devices:pending") return;
      for (const request of payload?.requests ?? []) void client.call("devices:allow", [request.key]).catch(() => {});
    });
  // Turning phone access on opens the pairing window, as showing the QR in Settings › Devices does.
  await client.call("phone:set-enabled", [true]);
  await until(async () => {
    const status = await client.call("phone:status");
    return status.state === "on" && status.relay === "online";
  }, "phone access on and the relay online");
  const identity = await readIdentity(dataDir);
  const token = JSON.parse(await fs.readFile(path.join(dataDir, "mobile.json"), "utf8")).token;
  /** Dials this Mac with `connectTo` (connectDesktop or connectPhone), through the relay unless `relayUrl` says otherwise. */
  const dial = (connectTo, options = {}) => {
    const socket = connectTo({ relayUrl: relay.url, identity, token, ...options });
    sockets.push(socket);
    return socket;
  };
  return { clock, client, project, identity, token, dial, relay, dataDir };
}
```

and add `startTestMac,` to `module.exports` after `fakePeerDaemon,`.

In `apps/daemon/src/peer-e2e.test.cjs`, delete `macWithRelay` (lines 32-79) and the imports it alone used, so the head of the file reads:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { b64url } = require("@milagre/shared/relay-crypto");
const { startTestMac, connectDesktop, connectPhone, until } = require("./relay-test-kit.cjs");
```

and replace each `await macWithRelay(t)` with `await startTestMac(t)`.

- [ ] **Step 6: Write the failing end-to-end test**

Append to `apps/daemon/src/peer-e2e.test.cjs`:

```js
test("a new computer waits for Allow, which only this Mac's window hears; Deny saves nothing, and a late Allow finds nothing", async (t) => {
  const mac = await startTestMac(t, { autoAllow: false });
  const heard = [];
  mac.client.on("event", ({ channel, payload }) => {
    if (channel === "devices:pending") heard.push(payload.requests);
  });
  const waitingFor = (key) => until(() => heard.at(-1)?.some((request) => request.key === key), "the window to hear the request");

  // A computer the owner allows.
  const known = mac.dial(connectDesktop, { name: "known" });
  const knownHello = known.hello({ ms: 10_000 });
  const knownKey = b64url(known.key.publicKey);
  await waitingFor(knownKey);
  await until(() => known.notices.length > 0, "the waiting notice");
  assert.deepEqual(await mac.client.call("devices:list"), [], "nothing saved before Allow");
  await mac.client.call("devices:allow", [knownKey]);
  assert.ok((await knownHello).channel);

  // Another asks: the window hears it, the computer already connected doesn't, and it can't answer for this Mac.
  const studio = mac.dial(connectDesktop, { name: "studio" });
  const studioHello = studio.hello({ ms: 10_000 });
  const studioKey = b64url(studio.key.publicKey);
  await waitingFor(studioKey);
  assert.deepEqual(
    (await mac.client.call("devices:pending")).map((request) => [request.key, request.name]),
    [[studioKey, "studio"]],
  );
  assert.deepEqual((await known.call("devices:allow", [studioKey])).error, { code: "NOT_AVAILABLE_REMOTELY", message: "Not available on a remote computer" });
  await known.call("daemon:status");
  assert.deepEqual(
    known.frames.filter((frame) => frame.event?.channel?.startsWith("devices:")),
    [],
  );
  await mac.client.call("devices:deny", [studioKey]);
  assert.deepEqual(await studioHello, { error: { t: "error", code: "unknown-phone", reason: "denied" } });
  assert.deepEqual(
    (await mac.client.call("devices:list")).map((device) => device.key),
    [knownKey],
  );

  // One that leaves before the owner answers: its request goes, and Allow afterwards changes nothing.
  const late = mac.dial(connectDesktop, { name: "late" });
  void late.hello({ ms: 2000 }).catch(() => {});
  const lateKey = b64url(late.key.publicKey);
  await waitingFor(lateKey);
  late.close();
  await until(() => heard.at(-1)?.length === 0, "the request to go");
  await assert.rejects(mac.client.call("devices:allow", [lateKey]), /no longer waiting/);
  assert.equal((await mac.client.call("devices:list")).length, 1);
});
```

- [ ] **Step 7: Run the daemon tests**

Run: `npm test -- --unit --workspace daemon`
Expected: PASS (the moved helper keeps the older end-to-end tests green, `autoAllow` answering their computers).

- [ ] **Step 8: Commit**

```bash
npx oxfmt apps/daemon/src/server.cjs apps/daemon/src/server-devices.test.cjs apps/daemon/src/relay-test-kit.cjs apps/daemon/src/peer-e2e.test.cjs
git add apps/daemon/src/server.cjs apps/daemon/src/server-devices.test.cjs apps/daemon/src/relay-test-kit.cjs apps/daemon/src/peer-e2e.test.cjs
git commit -m "feat(daemon): devices:pending, devices:allow and devices:deny for this Mac's window"
```

---

### Task 4: The Allow prompt

**Files:**
- Create: `apps/desktop/app/src/lib/pending-computers.ts`, `apps/desktop/app/src/lib/pending-computers.test.ts`
- Create: `apps/desktop/app/src/components/ComputerAllowPrompt.tsx`
- Modify: `apps/desktop/app/src/App.tsx:1` (import), `:2209-2214` (`AppWithUpdates`)
- Modify: `apps/desktop/app/src/electron.d.ts:91-101` (types), `:341-345` (methods)
- Modify: `apps/desktop/electron/preload.cjs:223-229`
- Modify: `apps/desktop/electron/notifications.cjs:17-35`, `:128-157`, `apps/desktop/electron/notifications.test.cjs`
- Modify: `apps/desktop/electron/main.cjs:187`
- Create: `scripts/test-allow-computer.cjs`

**Interfaces:**
- Consumes: Task 3's `devices:pending` event and methods. `main.cjs` already registers every host method as a pass-through (`main.cjs:209-215`) and sends every host event to the windows (`main.cjs:193-195`).
- Produces: `window.milagre.listPendingDevices(): Promise<PendingComputer[]>`, `allowDevice(key)`, `denyDevice(key)` (each resolving the ones still waiting), `onDevicesPending(callback: (payload: { requests: PendingComputer[] }) => void): () => void`; type `PendingComputer = { key: string; name: string | null; at: number }`. `AttentionNotifier.notifyComputerWaiting(requests)`.

- [ ] **Step 1: Write the failing copy test**

Create `apps/desktop/app/src/lib/pending-computers.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { allowQuestion } from "./pending-computers.ts";

test("the prompt names the computer that asks, or says a computer when it sent no name", () => {
  assert.equal(allowQuestion({ name: "studio" }), "studio wants to drive this Mac's chats");
  assert.equal(allowQuestion({ name: null }), "A computer wants to drive this Mac's chats");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test apps/desktop/app/src/lib/pending-computers.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `pending-computers.ts`.

- [ ] **Step 3: Write the copy**

Create `apps/desktop/app/src/lib/pending-computers.ts`:

```ts
import type { PendingComputer } from "../electron";

/** The prompt's question: the name the computer sent in its hello, or what it is when it sent none. */
export const allowQuestion = (request: Pick<PendingComputer, "name">) => `${request.name ?? "A computer"} wants to drive this Mac's chats`;

/** Under the question: what Allow gives it, and how to take it back. */
export const ALLOW_DETAIL = "It can do anything this window can, except pair and remove devices. You can remove it any time in Settings › Devices.";
```

In `apps/desktop/app/src/electron.d.ts`, after the `PairedDevice` type add:

```ts
/** A computer pairing with this Mac for the first time, waiting for Allow in its window (devices:pending). */
export type PendingComputer = { key: string; name: string | null; at: number };
```

and after `removeDevice: (key: string) => Promise<PairedDevice[]>;` add:

```ts
      /** Computers waiting for Allow, oldest first. */
      listPendingDevices: () => Promise<PendingComputer[]>;
      /** Lets a waiting computer pair; resolves with the ones still waiting. */
      allowDevice: (key: string) => Promise<PendingComputer[]>;
      /** Turns a waiting computer away; resolves with the ones still waiting. */
      denyDevice: (key: string) => Promise<PendingComputer[]>;
      onDevicesPending: (callback: (payload: { requests: PendingComputer[] }) => void) => () => void;
```

In `apps/desktop/electron/preload.cjs`, after `removeDevice: (key) => ipcRenderer.invoke("devices:remove", key),` add:

```js
  listPendingDevices: () => ipcRenderer.invoke("devices:pending"),
  allowDevice: (key) => ipcRenderer.invoke("devices:allow", key),
  denyDevice: (key) => ipcRenderer.invoke("devices:deny", key),
  onDevicesPending: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("devices:pending", listener);
    return () => ipcRenderer.removeListener("devices:pending", listener);
  },
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test apps/desktop/app/src/lib/pending-computers.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing Electron check**

Create `scripts/test-allow-computer.cjs`:

```js
// Run with npm test -- --only test-allow-computer. The Allow prompt in the real App against a real daemon (its own
// temporary data directory and socket; the relay host is a stand-in that records its options): a computer pairing for
// the first time asks, Allow lets it in, Deny and Escape turn it away, one that gives up takes its prompt with it, and
// two at once are asked one after the other. Set MILAGRE_SCREENSHOT_DIR to save screenshots.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import "/src/styles.css";
// The window talks to the host through the main process, as the real preload does (see electron/preload.cjs).
const { ipcRenderer } = window.require("electron");
const state = { next_id: 3, projects: { 1: { id: 1, name: "shop" } }, worktrees: { 1: { id: 1, name: "main", path: "/fixture", project_id: 1 } }, sessions: { 2: { id: 2, worktree_id: 1, agent_name: "Claude", provider: "claude", status: "Idle" } }, connections: {}, events: [], messages: [], approvals: [], tasks: {}, artifacts: {}, outputs: [], conflicts: [] };
window.milagre = new Proxy({
  getRuntimeConnection: async () => ({ connected: true }),
  getAgentPorts: async () => ({}),
  getCurrentProject: async () => ({ path: "/fixture", name: "shop", state }),
  listBranches: async () => ["main"],
  listEditors: async () => [],
  getCachedUsage: async () => ({ providers: [] }),
  readUsage: async () => ({ providers: [] }),
  getUpdateState: async () => ({ status: "idle" }),
  getAppVersion: async () => "0.0.0",
  getLinkedWork: async () => ({ delegations: [], negotiations: [], receiveOnly: [] }),
  listPendingDevices: () => ipcRenderer.invoke("devices:pending"),
  allowDevice: (key) => ipcRenderer.invoke("devices:allow", key),
  denyDevice: (key) => ipcRenderer.invoke("devices:deny", key),
  onDevicesPending: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("devices:pending", listener);
    return () => ipcRenderer.removeListener("devices:pending", listener);
  },
}, { get(target, key) { return target[key] ?? (String(key).startsWith("on") ? () => () => {} : async () => null); } });
localStorage.setItem("milagre-settings", JSON.stringify({ defaultModelId: "claude-opus-5-5", defaultPermissionMode: "ask" }));
const { default: App } = await import("/src/App");
createRoot(document.getElementById("root")).render(<App />);
`;

async function browserChecks() {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const { startDaemon } = require("../apps/daemon/src/server.cjs");
  const { connect } = require("../apps/daemon/src/client.cjs");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-allow-ui-")));
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "milagre-allow-host-")));
  await app.whenReady();
  // The check never dials the public relay: this stand-in reports that it connected and keeps the options, whose
  // allowComputer is the real one phone access hands a relay host.
  const relays = [];
  const startRelay = (options) => {
    relays.push(options);
    setTimeout(() => options.onStatus?.("online"), 20);
    return { close: async () => {}, status: () => "online" };
  };
  const daemon = await startDaemon({
    dataDir,
    version: "test",
    phoneOptions: { localPort: 0, lanPort: null, startRelay },
    runtimeOptions: {
      cwd: dataDir,
      environmentReady: Promise.resolve(),
      titleModels: {},
      agentCli: Object.assign(async () => ({ command: null }), { invalidate() {} }),
    },
  });
  const host = await connect({ dataDir });
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    useContentSize: true,
    show: false,
    webPreferences: { partition: "allow-test", backgroundThrottling: false, nodeIntegration: true, contextIsolation: false },
  });
  for (const method of ["devices:pending", "devices:allow", "devices:deny"]) ipcMain.handle(method, (_event, ...args) => host.call(method, args));
  host.on("event", ({ channel, payload }) => {
    if (channel === "devices:pending" && !window.isDestroyed()) window.webContents.send(channel, payload);
  });
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error(event.message);
  });
  const evaluate = async (source) => {
    try {
      return await window.webContents.executeJavaScript(source);
    } catch (error) {
      throw new Error(`${source}: ${error.message}`);
    }
  };
  async function waitFor(source) {
    for (let n = 0; n < 200; n++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw Error(`Timed out: ${source}`);
  }
  const prompt = `document.querySelector('dialog[data-computer-allow]')`;
  const asking = (name) => `!!${prompt}?.open && ${prompt}.textContent.includes(${JSON.stringify(`${name} wants to drive this Mac's chats`)})`;
  async function press(text) {
    const button = `[...${prompt}.querySelectorAll('button')].find((el) => el.textContent.trim() === ${JSON.stringify(text)})`;
    await waitFor(`!!(${button}) && !(${button}).disabled`);
    await evaluate(`(${button}).click()`);
  }
  const screenshotDir = process.env.MILAGRE_SCREENSHOT_DIR;
  async function screenshot(name) {
    if (!screenshotDir) return;
    await delay(400);
    fs.mkdirSync(screenshotDir, { recursive: true });
    fs.writeFileSync(path.join(screenshotDir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  /** Asks as a computer's first hello does; `verdict` settles with the owner's answer. */
  function ask(key, name) {
    const abort = new AbortController();
    const verdict = relays.at(-1).allowComputer({ key, name, signal: abort.signal, waiting() {} });
    return { verdict, abort };
  }

  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!document.querySelector('[aria-label="Settings"]')`);
    await host.call("phone:set-enabled", [true]);
    for (let n = 0; n < 200 && !relays.length; n++) await delay(25);
    assert.equal(relays.length, 1, "phone access started its relay host");
    assert.equal(await evaluate(`!!${prompt}?.open`), false, "nothing asks before a computer does");

    const studio = ask("s".repeat(43), "studio");
    await waitFor(asking("studio"));
    assert.match(await evaluate(`${prompt}.textContent`), /except pair and remove devices/);
    await screenshot("allow-prompt");
    await press("Allow");
    assert.equal(await studio.verdict, "allowed");
    await waitFor(`!${prompt}?.open`);
    console.log("PASS: a computer pairing for the first time asks, and Allow lets it in");

    const nameless = ask("n".repeat(43), null);
    await waitFor(asking("A computer"));
    await press("Deny");
    assert.equal(await nameless.verdict, "denied");
    const escaped = ask("e".repeat(43), "lab");
    await waitFor(asking("lab"));
    await evaluate(`${prompt}.dispatchEvent(new Event('cancel', { cancelable: true }))`);
    assert.equal(await escaped.verdict, "denied");
    await waitFor(`!${prompt}?.open`);
    console.log("PASS: Deny and Escape turn a computer away; one without a name is called a computer");

    const gone = ask("g".repeat(43), "gone");
    await waitFor(asking("gone"));
    gone.abort.abort();
    assert.equal(await gone.verdict, "dropped");
    await waitFor(`!${prompt}?.open`);
    console.log("PASS: a computer that gives up takes its prompt with it");

    const alpha = ask("a".repeat(43), "alpha");
    const beta = ask("b".repeat(43), "beta");
    await waitFor(asking("alpha"));
    await screenshot("allow-two-waiting");
    await press("Deny");
    await waitFor(asking("beta"));
    await press("Allow");
    assert.deepEqual(await Promise.all([alpha.verdict, beta.verdict]), ["denied", "allowed"]);
    await waitFor(`!${prompt}?.open`);
    assert.deepEqual(await host.call("devices:pending"), []);
    console.log("PASS: two computers at once are asked one after the other, oldest first");

    host.close();
    await daemon.close();
    app.exit(0);
  } catch (error) {
    console.error(error);
    await screenshot("failure").catch(() => {});
    host.close();
    await daemon.close().catch(() => {});
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "allow-fixture",
        resolveId(id) {
          if (id === "/__allow_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__allow_fixture.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__allow__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__allow_fixture.tsx"></script></body></html>',
            );
            response.setHeader("Content-Type", "text/html");
            response.end(html);
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__allow__`], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}

(process.versions.electron ? browserChecks() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -- --only test-allow-computer`
Expected: FAIL with `Timed out: !!document.querySelector('dialog[data-computer-allow]')?.open && ...` (no prompt yet).

- [ ] **Step 7: Write the prompt and mount it**

Create `apps/desktop/app/src/components/ComputerAllowPrompt.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { PendingComputer } from "../electron";
import { ALLOW_DETAIL, allowQuestion } from "../lib/pending-computers";

/**
 * Asks this Mac's owner whether a computer pairing for the first time may drive it (spec "Allowing a new computer").
 * The daemon holds that computer's channel until Allow or Deny; two at once are asked oldest first. Escape answers
 * Deny, the choice that can't give anything away. Not behind Settings › Experimental: the computer asking has the flag
 * on, this Mac may not.
 */
export function ComputerAllowPrompt() {
  const [requests, setRequests] = useState<PendingComputer[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let live = true;
    let heard = false;
    const off = window.milagre.onDevicesPending((payload) => {
      heard = true;
      setRequests(Array.isArray(payload?.requests) ? payload.requests : []);
    });
    // A host from before Allow has no devices:pending; nothing ever asks there.
    window.milagre.listPendingDevices().then(
      (list) => {
        if (live && !heard) setRequests(list ?? []);
      },
      () => {},
    );
    return () => {
      live = false;
      off();
    };
  }, []);
  const request = requests[0];
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (request && !element.open) element.showModal();
    if (!request && element.open) element.close();
  }, [request]);
  useEffect(() => setError(null), [request?.key]);

  async function answer(allow: boolean) {
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    try {
      setRequests(await (allow ? window.milagre.allowDevice(request.key) : window.milagre.denyDevice(request.key)));
    } catch (failure) {
      setError(ipcErrorMessage(failure));
      // Most often the computer gave up meanwhile: show what is still waiting.
      window.milagre.listPendingDevices().then(setRequests, () => {});
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <dialog
      ref={dialog}
      data-computer-allow
      aria-labelledby="computer-allow-title"
      onCancel={(event) => {
        event.preventDefault();
        void answer(false);
      }}
      className="m-auto w-[400px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[16px] bg-surface p-0 text-ink shadow-overlay backdrop:bg-black/20 backdrop:backdrop-blur-overlay"
    >
      {request && (
        <div className="flex flex-col p-5">
          <h2 id="computer-allow-title" className="text-[17px] font-semibold">
            {allowQuestion(request)}
          </h2>
          <p className="mt-1 text-[13px] text-ink-2">{ALLOW_DETAIL}</p>
          {error && (
            <p role="alert" className="mt-3 text-[13px] text-red">
              {error}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" disabled={busy} onClick={() => void answer(false)} className="rounded-control px-3 py-2 text-[13px] hover:bg-hover-2">
              Deny
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void answer(true)}
              className="rounded-control bg-ink px-3 py-2 text-[13px] font-medium text-surface disabled:opacity-40"
            >
              Allow
            </button>
          </div>
        </div>
      )}
    </dialog>,
    document.body,
  );
}
```

In `apps/desktop/app/src/App.tsx`, add after the first import line:

```tsx
import { ComputerAllowPrompt } from "./components/ComputerAllowPrompt";
```

and replace `AppWithUpdates` with:

```tsx
export default function AppWithUpdates() {
  return (
    <UpdateShell>
      <App />
      {/* Beside the app, so it asks whatever screen is open, Settings and Links included. */}
      <ComputerAllowPrompt />
    </UpdateShell>
  );
}
```

- [ ] **Step 8: Run the check to verify it passes**

Run: `npm test -- --only test-allow-computer`
Expected: PASS, printing the four `PASS:` lines.

- [ ] **Step 9: Write the failing notification test**

Append to `apps/desktop/electron/notifications.test.cjs`:

```js
test("a computer waiting for Allow is announced once while Milagre is in the background, and its click opens the window", () => {
  const { notifier, shown, opened, state } = setup();
  const studio = { key: "s".repeat(43), name: "studio", at: 1 };
  assert.equal(notifier.notifyComputerWaiting([studio]), true);
  assert.equal(shown[0].options.title, "studio wants to drive this Mac's chats");
  assert.equal(shown[0].options.body, "Open Milagre to allow or deny it.");
  shown[0].emit("click");
  assert.deepEqual(opened, ["settings:phone"]);
  // The same request again (another computer joined the list) says nothing more about it.
  const lab = { key: "l".repeat(43), name: null, at: 2 };
  assert.equal(notifier.notifyComputerWaiting([studio, lab]), true);
  assert.equal(shown[1].options.title, "A computer wants to drive this Mac's chats");
  assert.equal(shown[0].closed, true, "one notice at a time");
  assert.equal(notifier.notifyComputerWaiting([studio, lab]), false);
  // Answered: the notice goes.
  assert.equal(notifier.notifyComputerWaiting([]), false);
  assert.equal(shown[1].closed, true);
  // With the window focused the prompt is on screen; no notification.
  state.focused = true;
  assert.equal(notifier.notifyComputerWaiting([{ key: "x".repeat(43), name: "x", at: 3 }]), false);
});
```

- [ ] **Step 10: Run it to verify it fails**

Run: `node --test apps/desktop/electron/notifications.test.cjs`
Expected: FAIL with `TypeError: notifier.notifyComputerWaiting is not a function`.

- [ ] **Step 11: Write the notification and wire it**

In `apps/desktop/electron/notifications.cjs`, in the constructor after `this.phonePaired = null;` add:

```js
    /** @type {Electron.Notification | null} */
    this.computerWaiting = null;
    // Keys of the computers waiting for Allow that were already announced.
    this.computersAnnounced = new Set();
```

after `notifyDevicePaired(...) { ... }` add:

```js
  /**
   * Computers waiting for Allow (devices:pending): a new one is announced once, while no Milagre window has focus (the
   * prompt is on screen otherwise). The notice closes when nothing waits any more; its click brings the window back.
   * @param {Array<{ key?: unknown; name?: unknown }>} [requests]
   */
  notifyComputerWaiting(requests = []) {
    const waiting = (Array.isArray(requests) ? requests : []).filter((request) => typeof request?.key === "string");
    const keys = new Set(waiting.map((request) => /** @type {string} */ (request.key)));
    for (const key of this.computersAnnounced) if (!keys.has(key)) this.computersAnnounced.delete(key);
    if (!keys.size) {
      this.computerWaiting?.close();
      this.computerWaiting = null;
      return false;
    }
    const fresh = waiting.find((request) => !this.computersAnnounced.has(/** @type {string} */ (request.key)));
    for (const key of keys) this.computersAnnounced.add(key);
    if (!fresh || this.isAppFocused()) return false;
    const name = capped(fresh.name, MAX_TITLE) || "A computer";
    const notification = this.createNotification({ title: `${name} wants to drive this Mac's chats`, subtitle: "", body: "Open Milagre to allow or deny it." });
    this.computerWaiting?.close();
    this.computerWaiting = notification;
    notification.on("click", () => this.openPhoneSettings());
    notification.show();
    return true;
  }
```

and in `closeAll()`, after `this.completionNotifications.clear();` add:

```js
    this.computerWaiting?.close();
    this.computerWaiting = null;
```

In `apps/desktop/electron/main.cjs`, replace:

```js
        if (channel === "phone:paired" && Notification.isSupported()) notifier.notifyDevicePaired(payload?.kind);
```

with:

```js
        // A computer pairs only once its owner clicked Allow here, so only a phone's pairing needs telling.
        if (channel === "phone:paired" && payload?.kind !== "computer" && Notification.isSupported()) notifier.notifyDevicePaired(payload?.kind);
        if (channel === "devices:pending" && Notification.isSupported()) notifier.notifyComputerWaiting(payload?.requests);
```

- [ ] **Step 12: Run the tests and checks**

Run: `node --test apps/desktop/electron/notifications.test.cjs && npm run typecheck && npm test -- --only test-allow-computer && npm test -- --only test-settings-devices`
Expected: PASS for all four.

- [ ] **Step 13: Commit**

```bash
npx oxfmt apps/desktop/app/src/lib/pending-computers.ts apps/desktop/app/src/lib/pending-computers.test.ts apps/desktop/app/src/components/ComputerAllowPrompt.tsx apps/desktop/app/src/App.tsx apps/desktop/app/src/electron.d.ts apps/desktop/electron/preload.cjs apps/desktop/electron/notifications.cjs apps/desktop/electron/notifications.test.cjs apps/desktop/electron/main.cjs scripts/test-allow-computer.cjs
git add apps/desktop/app/src/lib/pending-computers.ts apps/desktop/app/src/lib/pending-computers.test.ts apps/desktop/app/src/components/ComputerAllowPrompt.tsx apps/desktop/app/src/App.tsx apps/desktop/app/src/electron.d.ts apps/desktop/electron/preload.cjs apps/desktop/electron/notifications.cjs apps/desktop/electron/notifications.test.cjs apps/desktop/electron/main.cjs scripts/test-allow-computer.cjs
git commit -m "feat(desktop): ask this Mac's owner to allow a new computer"
```

---

### Task 5: The pairing link and the route supervisor move to `@milagre/shared`

**Files:**
- Create: `packages/shared/src/pairing-link.mjs`, `packages/shared/src/pairing-link.d.mts`, `packages/shared/src/pairing-link.test.mjs`
- Create: `packages/shared/src/route-supervisor.mjs`, `packages/shared/src/route-supervisor.d.mts`
- Modify: `packages/shared/package.json` (exports, after `./peer-frames`)
- Modify: `apps/mobile/src/pairing.ts` (whole file), `apps/mobile/src/routes.ts` (whole file), `apps/mobile/src/client.ts:1-8` (imports), `:30-70` (moved definitions)
- Test: `packages/shared/src/pairing-link.test.mjs`; the phone's own `apps/mobile/src/routes.test.ts`, `hosts-store.test.ts`, `client.test.ts` unchanged

**Interfaces:**
- Consumes: nothing new.
- Produces: `@milagre/shared/pairing-link`: `parsePairing(input, { allowLocalRelay }?) => { address, token, name, access?, relay?: { url, hostId, key } }`, `validRelay(value, { allowLocalRelay }?)`, `validAccess`, `localEndpoint`, `relayAddress`, types `Access`, `RelayLink`, `Pairing`. `allowLocalRelay` also takes `ws://127.0.0.1:<port>` (tests only); without it nothing changes.
- Produces: `@milagre/shared/route-supervisor`: `createRouteSupervisor<T extends { ready(): Promise<void>; close(): void }>({ lan, probe, openLan, now }) => { current, check, suspend, subscribe, close }`, `PROBE_TIMEOUT` (2500), `HOLD_MS`, types `LanRoute`, `RouteTransport`, `ActiveRoute<T>`, `RouteSupervisor<T>`, `RouteSupervisorOptions<T>`.

- [ ] **Step 1: Record the phone's fingerprint before the move**

Run: `cd apps/mobile && npx expo-updates fingerprint:generate --platform ios | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).hash))'; cd ../..`
Expected: one hash. Write it down as BEFORE.

- [ ] **Step 2: Write the failing shared test**

Create `packages/shared/src/pairing-link.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePairing, validRelay } from "./pairing-link.mjs";

const token = "a".repeat(64);
const hostId = "h".repeat(22);
const key = "k".repeat(43);
const link = (relay, name = "studio") =>
  `milagre://pair?relay=${encodeURIComponent(relay)}&host=${hostId}&key=${key}&token=${token}&name=${encodeURIComponent(name)}`;

test("a relay link reads as the phone always read it", () => {
  assert.deepEqual(parsePairing(link("wss://relay.milagre.cloud")), {
    address: `relay://${hostId}`,
    token,
    name: "studio",
    relay: { url: "wss://relay.milagre.cloud", hostId, key },
  });
  assert.equal(parsePairing(link("wss://relay.milagre.cloud", "")).name, "Mac");
  assert.throws(() => parsePairing("https://example.com/pair?token=x"), /not a Milagre pairing link/);
});

test("a relay on this machine is read only when asked, and only on 127.0.0.1", () => {
  assert.throws(() => parsePairing(link("ws://127.0.0.1:8080")), /damaged/);
  assert.equal(parsePairing(link("ws://127.0.0.1:8080"), { allowLocalRelay: true }).relay.url, "ws://127.0.0.1:8080");
  assert.throws(() => parsePairing(link("ws://192.168.1.20:8080"), { allowLocalRelay: true }), /damaged/);
  assert.throws(() => validRelay({ url: "ws://127.0.0.1:8080", hostId, key }), /damaged/);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test packages/shared/src/pairing-link.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: Move the pairing link**

Create `packages/shared/src/pairing-link.mjs`:

```js
// The pairing link a Mac shows in Settings › Devices, as the phone (apps/mobile/src/pairing.ts) and the desktop's Add
// computer (apps/desktop/electron/computers.cjs) read it. Moved from apps/mobile/src/client.ts and pairing.ts unchanged,
// with `allowLocalRelay` added for tests that run their own relay.

/** A Cloudflare Access service token: the edge drops any request to the host's tunnel without it. */
export function validAccess(value) {
  const access = value;
  if (!access?.id && !access?.secret) return undefined;
  if (!/^[a-f0-9]{32}\.access$/.test(String(access.id)) || !/^[A-Za-z0-9_-]{32,128}$/.test(String(access.secret)))
    throw new Error("This computer's Cloudflare access token is not valid. Scan its code again.");
  return { id: String(access.id), secret: String(access.secret) };
}

export function localEndpoint(input) {
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter your computer's HTTPS address or a local simulator address.");
  }
  const local = url.protocol === "http:" && ["127.0.0.1", "10.0.2.2"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use an HTTPS address, or 127.0.0.1 on iOS / 10.0.2.2 on Android for a local simulator. Enter the token separately.");
  }
  return url.origin;
}

/**
 * How a device reaches a Mac with no tunnel: the public relay, the Mac's id there, and its pinned box key.
 * `allowLocalRelay` also takes a relay on this machine (ws://127.0.0.1), which only tests run.
 */
export function validRelay(value, { allowLocalRelay = false } = {}) {
  const relay = value;
  const damaged = () => new Error("This pairing code is damaged. Scan the code again in Settings → Devices on your Mac.");
  let url;
  try {
    url = new URL(String(relay?.url ?? ""));
  } catch {
    throw damaged();
  }
  const local = allowLocalRelay && url.protocol === "ws:" && url.hostname === "127.0.0.1";
  if ((url.protocol !== "wss:" && !local) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw damaged();
  if (!/^[A-Za-z0-9_-]{22}$/.test(String(relay?.hostId)) || !/^[A-Za-z0-9_-]{43}$/.test(String(relay?.key))) throw damaged();
  return { url: url.origin, hostId: String(relay.hostId), key: String(relay.key) };
}
/** A relay computer's address and saved id: there is no URL to show, so its id on the relay stands in. */
export const relayAddress = (hostId) => `relay://${hostId}`;

/** Reads the link the host prints and encodes in its QR code: a direct address (scripts/mobile-pairing.cjs) or the relay (apps/daemon/src/mobile-pairing.cjs). */
export function parsePairing(input, { allowLocalRelay = false } = {}) {
  // React Native's URL does not parse custom schemes or query strings, so the link is read by hand.
  const match = /^milagre(?:-local)?:\/\/\/?pair\/?\?(.*)$/i.exec(input.trim());
  if (!match) throw new Error("That is not a Milagre pairing link. Scan the code your Mac shows, or copy its pairing link.");
  const params = {};
  for (const part of match[1].split("&")) {
    const [key, ...value] = part.split("=");
    try {
      params[decodeURIComponent(key)] = decodeURIComponent(value.join("=").replace(/\+/g, " "));
    } catch {
      /* skip a malformed pair */
    }
  }
  const token = params.token || "";
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error("This pairing link has no valid token. Restart the host on your Mac and scan the new code.");
  if (params.relay !== undefined || params.host !== undefined || params.key !== undefined) {
    // A link names one way to reach the Mac; one with both was not made by Milagre.
    if (params.address !== undefined) throw new Error("This pairing link is damaged. Scan the code again in Settings → Devices on your Mac.");
    const relay = validRelay({ url: params.relay, hostId: params.host, key: params.key }, { allowLocalRelay });
    return { address: relayAddress(relay.hostId), token, name: (params.name || "").trim().slice(0, 80) || "Mac", relay };
  }
  const address = localEndpoint(params.address || "");
  const name = (params.name || "").trim().slice(0, 80) || address.replace(/^https?:\/\//, "").replace(/[:/].*$/, "");
  const access = validAccess({ id: params.cfId, secret: params.cfSecret });
  if (access && !address.startsWith("https:")) throw new Error("This pairing link has a Cloudflare token but no HTTPS address.");
  return access ? { address, token, name, access } : { address, token, name };
}
```

Create `packages/shared/src/pairing-link.d.mts`:

```ts
/** A Cloudflare Access service token: the edge drops any request to the host's tunnel without it. */
export type Access = { id: string; secret: string };
/** How a device reaches a Mac with no tunnel: the public relay, the Mac's id there, and its pinned box key. */
export type RelayLink = { url: string; hostId: string; key: string };
export type Pairing = { address: string; token: string; name: string; access?: Access; relay?: RelayLink };
/** `allowLocalRelay`: also take a relay on this machine (ws://127.0.0.1); tests only. */
export type PairingOptions = { allowLocalRelay?: boolean };
export function validAccess(value: unknown): Access | undefined;
export function localEndpoint(input: string): string;
export function validRelay(value: unknown, options?: PairingOptions): RelayLink;
export function relayAddress(hostId: string): string;
export function parsePairing(input: string, options?: PairingOptions): Pairing;
```

- [ ] **Step 5: Move the route supervisor**

Create `packages/shared/src/route-supervisor.mjs` (the code of `apps/mobile/src/routes.ts` without its types):

```js
// Which way one computer is reached: its LAN endpoints when they work, its paired route (Cloudflare or the relay)
// otherwise. The phone (apps/mobile/src/routes-native.ts) and the desktop's computers (apps/desktop/electron/computers.cjs)
// both run it. Pure: probing, opening a LAN transport and the clock are passed in. Moved from apps/mobile/src/routes.ts.
export const PROBE_TIMEOUT = 2_500;
/** An endpoint that answered its probe but would not open waits this long before it is tried again. */
export const HOLD_MS = 5 * 60_000;
const PRIMARY = { kind: "primary" };

/** A transport that fails to close must not stop the supervisor from moving on. */
function closeQuietly(transport) {
  try {
    transport.close();
  } catch {
    /* already going away */
  }
}

export function createRouteSupervisor({ lan, probe, openLan, now = Date.now }) {
  let active = PRIMARY;
  let walking = null;
  let closed = false;
  const held = new Map();
  const listeners = new Set();

  function set(next) {
    const previous = active;
    if (previous === next) return;
    active = next;
    // The copy is deliberate: a listener may (un)subscribe during notification, and a live Set would revisit it.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        /* a listener must not stop the switch */
      }
    }
    if (previous.kind === "lan") closeQuietly(previous.transport);
  }

  /** Falls back to the paired route and, unless the supervisor is closed, tries the advertised endpoints again. */
  function lost() {
    set(PRIMARY);
    if (!closed) void supervisor.check().catch(() => {});
  }

  async function walk() {
    const route = lan();
    if (active.kind === "lan") {
      const current = active;
      const { endpoint } = current;
      const answered = route?.endpoints.includes(endpoint) && (await probe(endpoint, route.hostId).catch(() => false));
      if (closed) return active;
      // Demoted while probing (suspend or a lost socket): that transport is closed, and ready() would reopen it.
      // The endpoint did nothing wrong, so it is neither asked nor held; the walk below tries it like any other.
      if (active === current) {
        if (answered) {
          // A socket that answers its probe can still be dead: the supervisor only counts it once its hello has finished.
          const ready = await current.transport.ready().then(
            () => true,
            () => false,
          );
          if (closed) return active;
          // Demoted during ready() too: its failure is the demotion's doing, not the endpoint's.
          if (active === current) {
            if (ready) return active;
            held.set(endpoint, now() + HOLD_MS);
          }
        }
        if (active === current) set(PRIMARY);
      }
    }
    if (!route) return active;
    const candidates = route.endpoints.filter((endpoint) => (held.get(endpoint) ?? 0) <= now());
    const probes = candidates.map((endpoint) => probe(endpoint, route.hostId).catch(() => false));
    for (const [index, endpoint] of candidates.entries()) {
      if (!(await probes[index]) || closed) continue;
      let opened;
      try {
        opened = await openLan(endpoint, route, () => {
          // Only the transport that was opened for this callback can demote the route: a replaced one reports late.
          if (opened && active.kind === "lan" && active.transport === opened) lost();
        });
      } catch {
        held.set(endpoint, now() + HOLD_MS);
        continue;
      }
      if (closed) {
        closeQuietly(opened);
        return active;
      }
      set({ kind: "lan", endpoint, transport: opened });
      return active;
    }
    return active;
  }

  const supervisor = {
    current: () => active,
    check() {
      if (closed) return Promise.resolve(active);
      walking ??= walk().finally(() => {
        walking = null;
      });
      return walking;
    },
    suspend() {
      set(PRIMARY);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      listeners.clear();
      const previous = active;
      active = PRIMARY;
      if (previous.kind === "lan") closeQuietly(previous.transport);
    },
  };
  return supervisor;
}
```

Create `packages/shared/src/route-supervisor.d.mts`:

```ts
export const PROBE_TIMEOUT: number;
/** An endpoint that answered its probe but would not open waits this long before it is tried again. */
export const HOLD_MS: number;
/** How a computer is reached on its local network: its relay id and box key, and its addresses there. */
export type LanRoute = { hostId: string; key: string; endpoints: string[]; learnedAt: number };
/** What the supervisor needs of a LAN connection: whether it still works, and a way to close it. */
export type RouteTransport = { ready(): Promise<void>; close(): void };
export type ActiveRoute<T extends RouteTransport = RouteTransport> = { kind: "primary" } | { kind: "lan"; endpoint: string; transport: T };
export type RouteSupervisor<T extends RouteTransport = RouteTransport> = {
  current(): ActiveRoute<T>;
  /** Moves to the best route that works now: a LAN endpoint if one answers and opens, else the paired route. */
  check(): Promise<ActiveRoute<T>>;
  /** Closes the LAN socket and falls back to the paired route; the next check reopens it. */
  suspend(): void;
  subscribe(listener: (route: ActiveRoute<T>) => void): () => void;
  close(): void;
};
export type RouteSupervisorOptions<T extends RouteTransport = RouteTransport> = {
  lan: () => LanRoute | undefined;
  probe: (endpoint: string, hostId: string) => Promise<boolean>;
  openLan: (endpoint: string, lan: LanRoute, onLost: () => void) => Promise<T>;
  now?: () => number;
};
export function createRouteSupervisor<T extends RouteTransport>(options: RouteSupervisorOptions<T>): RouteSupervisor<T>;
```

In `packages/shared/package.json`, after the `"./peer-frames": { ... },` entry add:

```json
    "./pairing-link": {
      "types": "./src/pairing-link.d.mts",
      "default": "./src/pairing-link.mjs"
    },
    "./route-supervisor": {
      "types": "./src/route-supervisor.d.mts",
      "default": "./src/route-supervisor.mjs"
    },
```

- [ ] **Step 6: Point the phone at them**

Replace the whole of `apps/mobile/src/pairing.ts` with:

```ts
// Moved to @milagre/shared so Add computer on the desktop reads the same links.
export { parsePairing } from "@milagre/shared/pairing-link";
export type { Pairing } from "@milagre/shared/pairing-link";
```

Replace the whole of `apps/mobile/src/routes.ts` with:

```ts
// Moved to @milagre/shared so the desktop's computers (apps/desktop/electron/computers.cjs) pick routes the same way.
import type { RouteSupervisor as SharedSupervisor, RouteSupervisorOptions as SharedOptions } from "@milagre/shared/route-supervisor";
import type { RelayTransport } from "./relay-transport.ts";

export { createRouteSupervisor, PROBE_TIMEOUT, HOLD_MS } from "@milagre/shared/route-supervisor";
export type RouteSupervisor = SharedSupervisor<RelayTransport>;
export type RouteSupervisorOptions = SharedOptions<RelayTransport>;
```

In `apps/mobile/src/client.ts`, add after `import type { RelayTransport } from "./relay-transport.ts";`:

```ts
import { localEndpoint, relayAddress, validAccess, validRelay, type Access, type RelayLink } from "@milagre/shared/pairing-link";
```

and replace lines 30-70 (from `/** A Cloudflare Access service token: the edge drops any request to the host's tunnel without it. */` through `export const relayAddress = (hostId: string) => \`relay://${hostId}\`;`) with:

```ts
// The pairing link's parts moved to @milagre/shared with parsePairing; the phone's modules still import them from here.
export { localEndpoint, relayAddress, validAccess, validRelay };
export type { Access, RelayLink };
```

- [ ] **Step 7: Run the shared and phone tests and typechecks**

Run: `node --test packages/shared/src/pairing-link.test.mjs && npm test -- --unit --workspace mobile && npm run typecheck --workspace @milagre/shared && npm run typecheck --workspace @milagre/mobile && npm run lint --workspace @milagre/mobile`
Expected: PASS for each; the phone's `routes.test.ts`, `hosts-store.test.ts` and `client.test.ts` pass unedited.

- [ ] **Step 8: Confirm the fingerprint did not change**

Run: `cd apps/mobile && npx expo-updates fingerprint:generate --platform ios | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).hash))'; cd ../..`
Expected: the same hash as BEFORE. If it differs, stop and report what changed it (apps/mobile/AGENTS.md: a new build needs the user's approval).

- [ ] **Step 9: Commit**

```bash
npx oxfmt packages/shared/src/pairing-link.mjs packages/shared/src/pairing-link.d.mts packages/shared/src/pairing-link.test.mjs packages/shared/src/route-supervisor.mjs packages/shared/src/route-supervisor.d.mts packages/shared/package.json apps/mobile/src/pairing.ts apps/mobile/src/routes.ts apps/mobile/src/client.ts
git add packages/shared/src/pairing-link.mjs packages/shared/src/pairing-link.d.mts packages/shared/src/pairing-link.test.mjs packages/shared/src/route-supervisor.mjs packages/shared/src/route-supervisor.d.mts packages/shared/package.json apps/mobile/src/pairing.ts apps/mobile/src/routes.ts apps/mobile/src/client.ts
git commit -m "refactor: move the pairing link and the route supervisor to @milagre/shared"
```

---

### Task 6: A desktop's channel to a computer

**Files:**
- Create: `apps/desktop/electron/peer-client.cjs`, `apps/desktop/electron/peer-client.test.cjs`
- Create: `apps/desktop/electron/computer-errors.cjs`, `apps/desktop/electron/computer-errors.test.cjs`

**Interfaces:**
- Consumes: `phoneHello`, `phoneFinish`, `fromB64url` (`@milagre/shared/relay-crypto`); `createFrameReader("evt")`, `createFrameWriter("rpc")` (`@milagre/shared/peer-frames`); `deadlineFor` (`@milagre/daemon/client`); `VERSION`, `MAX_PENDING` (`@milagre/daemon/protocol`). Task 1's pending notice.
- Produces: `connectPeer({ url, hostId, hostKey, token, identity, name, onPending?, signal?, random?, createSocket?, timeoutMs? }) => Promise<PeerClient>`, where `PeerClient` is an EventEmitter with `call(method, args?) => Promise<any>`, `close()`, `closed: boolean`, `status: { methods, capabilities, ... }`, emitting `"event"` (`{ channel, payload, seq }`) and `"close"` once: the interface `daemon-runtime.cjs` uses of `@milagre/daemon/client`'s `connect`. `url` is the relay's base or a LAN `ws://address:port`; both serve `/v1/phone?id=<hostId>`. `createSocket(url)` returns a WebSocket-like object (`binaryType`, `onopen`, `onmessage`, `onclose`, `onerror`, `send`, `close`); the default is Node's global `WebSocket`.
- Produces: `PeerError` with `code` one of `denied`, `unknown-phone`, `busy`, `reset`, `bad-token`, `kind`, `bad-hello`, `bad-host`, `outdated`, `full`, `offline`, `lost`, `cancelled`, `keys`, and `final` (true for `denied`, `unknown-phone`, `reset`, `bad-token`, `kind`, `bad-host`, `keys`: retrying can't help).
- Produces: `computerProblem(code, { name, pairing? }) => string`.

- [ ] **Step 1: Write the failing copy test**

Create `apps/desktop/electron/computer-errors.test.cjs`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { computerProblem } = require("./computer-errors.cjs");

test("each problem reads as the spec words it, naming the computer", () => {
  const name = "studio";
  const pairing = true;
  assert.equal(computerProblem("unknown-phone", { name }), "Removed on studio. Pair again with a new link.");
  assert.equal(computerProblem("unknown-phone", { name, pairing }), "This link expired. Copy a new one on studio.");
  assert.equal(computerProblem("outdated", { name }), "Update Milagre on studio to connect.");
  assert.equal(computerProblem("kind", { name, pairing }), "Update Milagre on studio to connect.");
  assert.equal(computerProblem("full", { name }), "studio has too many devices connected. Remove one in its Settings › Devices.");
  assert.equal(computerProblem("denied", { name, pairing }), "studio didn't allow this Mac.");
  assert.equal(computerProblem("busy", { name, pairing }), "studio is answering another computer. Try again in a minute.");
  assert.equal(computerProblem("reset", { name }), "studio was reset. Pair again with a new link.");
  assert.equal(computerProblem("bad-token", { name, pairing }), "This link is out of date. Copy a new one on studio.");
  assert.equal(computerProblem("bad-host", { name, pairing }), "This isn't the Mac the link was made on. Copy a new link on studio.");
  assert.equal(computerProblem("offline", { name, pairing }), "studio isn't reachable. Open Milagre on it and check Settings › Devices.");
  assert.equal(computerProblem("keys", { name }), "This Mac lost its keys for studio. Remove it and pair again.");
  assert.equal(computerProblem("lost", { name, pairing }), "Couldn't reach studio. Check your connection and try again.");
  assert.equal(computerProblem("lost", { name }), "studio is offline.");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test apps/desktop/electron/computer-errors.test.cjs`
Expected: FAIL with `Cannot find module './computer-errors.cjs'`.

- [ ] **Step 3: Write the copy**

Create `apps/desktop/electron/computer-errors.cjs`:

```js
/**
 * What the window says when a computer turned this Mac away or can't be reached (spec "Errors"), by PeerError code
 * (peer-client.cjs). `name` is the computer's name; `pairing` is set during Add computer, before it was saved, where
 * unknown-phone means the link's pairing window closed rather than a removal.
 */
function computerProblem(code, { name, pairing = false }) {
  switch (code) {
    case "denied":
      return `${name} didn't allow this Mac.`;
    case "unknown-phone":
      return pairing ? `This link expired. Copy a new one on ${name}.` : `Removed on ${name}. Pair again with a new link.`;
    case "busy":
      return `${name} is answering another computer. Try again in a minute.`;
    case "reset":
      return `${name} was reset. Pair again with a new link.`;
    case "bad-token":
      return pairing ? `This link is out of date. Copy a new one on ${name}.` : `${name} has a new pairing link. Pair again with it.`;
    // A Mac from before PR 1 takes the hello as a phone's, and PR 1's refuse it with reason "kind".
    case "kind":
    case "outdated":
      return `Update Milagre on ${name} to connect.`;
    case "full":
      return `${name} has too many devices connected. Remove one in its Settings › Devices.`;
    case "offline":
      return pairing ? `${name} isn't reachable. Open Milagre on it and check Settings › Devices.` : `${name} is offline.`;
    case "bad-host":
      return `This isn't the Mac the link was made on. Copy a new link on ${name}.`;
    case "bad-hello":
      return `${name} couldn't read this Mac's hello. Copy a new link on it and try again.`;
    case "keys":
      return `This Mac lost its keys for ${name}. Remove it and pair again.`;
    default:
      return pairing ? `Couldn't reach ${name}. Check your connection and try again.` : `${name} is offline.`;
  }
}

module.exports = { computerProblem };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test apps/desktop/electron/computer-errors.test.cjs`
Expected: PASS.

- [ ] **Step 5: Write the failing client tests**

Create `apps/desktop/electron/peer-client.test.cjs`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { boxKeyPair, b64url, hostAccept } = require("@milagre/shared/relay-crypto");
const { createFrameReader, createFrameWriter } = require("@milagre/shared/peer-frames");
const { connectPeer, PeerError } = require("./peer-client.cjs");

const random = (n) => new Uint8Array(randomBytes(n));
const TOKEN = "a".repeat(64);
const encoder = new TextEncoder();
const STATUS = { version: "9.8.7", methods: ["project:recent"], capabilities: ["desktop-v1", "desktop-peer-v1"] };
const echo = (frame) => ({ v: 1, id: frame.id, result: frame.method === "daemon:status" ? STATUS : { echo: frame.args } });

async function until(check, label) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/**
 * A Mac at the other end of an in-memory socket: it reads the hello with the real hostAccept, then answers each daemon
 * frame as `answer(frame)` says ("close" closes the socket as a Mac from before PR 1 does). `hello`: "accept", "pending"
 * (accept later with mac.accept()), "full" (the relay's 4429), or a refusal body.
 */
function fakeMac({ hello = "accept", answer = echo } = {}) {
  const host = boxKeyPair(random);
  const mac = { hostKey: b64url(host.publicKey), sockets: [], hellos: [], accept: () => {} };
  mac.createSocket = (url) => {
    const reader = createFrameReader("rpc");
    const writer = createFrameWriter("evt");
    let channel = null;
    const socket = {
      url,
      binaryType: "",
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      closed: null,
      deliver(bytes) {
        const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        queueMicrotask(() => socket.onmessage?.({ data }));
      },
      closeWith(code) {
        if (socket.closed) return;
        socket.closed = code;
        queueMicrotask(() => socket.onclose?.({ code }));
      },
      close() {
        socket.closeWith(1000);
      },
      push(event) {
        for (const text of writer.write(JSON.stringify({ v: 1, event }))) socket.deliver(channel.sealEncoded(text));
      },
      send(bytes) {
        if (socket.closed) throw new Error("closed");
        if (!channel) {
          if (hello === "full") return socket.closeWith(4429);
          if (typeof hello === "object") return socket.deliver(new Uint8Array([0x04, ...encoder.encode(JSON.stringify({ t: "error", ...hello }))]));
          const accepted = hostAccept({ host, hello: bytes, isKnown: () => false, canPair: true, token: TOKEN, random });
          mac.hellos.push({ kind: accepted.kind, name: accepted.name });
          mac.accept = () => {
            socket.deliver(accepted.reply);
            channel = accepted.channel;
          };
          if (hello === "pending") socket.deliver(new Uint8Array([0x05, ...encoder.encode('{"t":"pending"}')]));
          else mac.accept();
          return;
        }
        const message = channel.open(bytes);
        if (message.t === "ping") return socket.deliver(channel.seal({ t: "pong" }));
        const read = reader.read(message);
        if (!read) return;
        const reply = answer(read.frame);
        if (reply === "close") return socket.closeWith(1000);
        if (reply) for (const text of writer.write(JSON.stringify(reply))) socket.deliver(channel.sealEncoded(text));
      },
    };
    mac.sockets.push(socket);
    queueMicrotask(() => socket.onopen?.());
    return socket;
  };
  return mac;
}

const dial = (mac, options = {}) =>
  connectPeer({
    url: "wss://relay.test/",
    hostId: "h".repeat(22),
    hostKey: mac.hostKey,
    token: TOKEN,
    identity: boxKeyPair(random),
    name: "desk",
    createSocket: mac.createSocket,
    ...options,
  });

test("the hello says desktop and its name, daemon calls go out as rpc and come back, events arrive", async (t) => {
  const mac = fakeMac();
  const client = await dial(mac);
  t.after(() => client.close());
  assert.equal(mac.sockets[0].url, `wss://relay.test/v1/phone?id=${"h".repeat(22)}`);
  assert.deepEqual(mac.hellos, [{ kind: "desktop", name: "desk" }]);
  assert.deepEqual(client.status, STATUS);
  assert.deepEqual(await client.call("project:recent", [1]), { echo: [1] });
  // Past 768 KiB both ways: parts out, parts back, through the 512 KiB pieces.
  const big = "ação🙂".repeat(150_000);
  assert.deepEqual(await client.call("echo", [big]), { echo: [big] });
  const events = [];
  client.on("event", (event) => events.push(event));
  mac.sockets[0].push({ channel: "project:state", payload: { path: "/p" }, seq: 3 });
  await until(() => events.length === 1, "the event");
  assert.deepEqual(events, [{ channel: "project:state", payload: { path: "/p" }, seq: 3 }]);
});

test("a Mac holding a first pairing says so, and the desktop waits until it is allowed", async (t) => {
  const mac = fakeMac({ hello: "pending" });
  let pending = 0;
  let done = false;
  const connecting = dial(mac, { onPending: () => pending++ }).then((client) => {
    done = true;
    return client;
  });
  await until(() => pending === 1, "the pending notice");
  await delay(50);
  assert.equal(done, false, "still waiting for Allow");
  mac.accept();
  const client = await connecting;
  t.after(() => client.close());
  assert.equal(pending, 1);
});

test("each refusal reads as its code, final when retrying can't help", async () => {
  for (const [hello, code, final] of [
    [{ code: "unknown-phone" }, "unknown-phone", true],
    [{ code: "unknown-phone", reason: "denied" }, "denied", true],
    [{ code: "unknown-phone", reason: "busy" }, "busy", false],
    [{ code: "bad-token", reason: "reset" }, "reset", true],
    [{ code: "bad-token" }, "bad-token", true],
    [{ code: "bad-hello", reason: "kind" }, "kind", true],
    [{ code: "bad-hello" }, "bad-hello", false],
    ["full", "full", false],
  ]) {
    await assert.rejects(dial(fakeMac({ hello })), (error) => {
      assert.ok(error instanceof PeerError, code);
      assert.equal(error.code, code);
      assert.equal(error.final, final, code);
      return true;
    });
  }
});

test("a Mac from before paired desktops, closing on the first rpc, reads as outdated, as does one without desktop-peer-v1", async () => {
  await assert.rejects(dial(fakeMac({ answer: () => "close" })), { code: "outdated", final: false });
  const old = (frame) => ({ v: 1, id: frame.id, result: { methods: [], capabilities: ["desktop-v1"] } });
  await assert.rejects(dial(fakeMac({ answer: old })), { code: "outdated" });
});

test("a dropped channel fails its calls and says close once", async () => {
  const mac = fakeMac({ answer: (frame) => (frame.method === "slow" ? null : echo(frame)) });
  const client = await dial(mac);
  let closes = 0;
  client.on("close", () => closes++);
  const slow = client.call("slow");
  mac.sockets[0].closeWith(1006);
  await assert.rejects(slow, /closed/);
  await until(() => closes === 1, "close");
  client.close();
  await delay(20);
  assert.equal(closes, 1);
  assert.equal(client.closed, true);
  await assert.rejects(client.call("project:recent"), /closed/);
});

test("cancelling a pairing that waits for Allow ends it as cancelled", async () => {
  const abort = new AbortController();
  await assert.rejects(dial(fakeMac({ hello: "pending" }), { signal: abort.signal, onPending: () => abort.abort() }), { code: "cancelled", final: false });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `node --test apps/desktop/electron/peer-client.test.cjs`
Expected: FAIL with `Cannot find module './peer-client.cjs'`.

- [ ] **Step 7: Write the client**

Create `apps/desktop/electron/peer-client.cjs`:

```js
const { EventEmitter } = require("node:events");
const { randomBytes } = require("node:crypto");
const { phoneHello, phoneFinish, fromB64url } = require("@milagre/shared/relay-crypto");
const { createFrameReader, createFrameWriter } = require("@milagre/shared/peer-frames");
const { deadlineFor } = require("@milagre/daemon/client");
const { VERSION, MAX_PENDING } = require("@milagre/daemon/protocol");

const ACCEPT = 0x02;
const REFUSED = 0x04;
// A Mac holding a computer's first hello until its owner allows it (phone-channels.cjs), again every 20 s.
const PENDING = 0x05;
// As the phone's relay transport (apps/mobile/src/relay-transport.ts:66-70): the hello's reply within 15 s, a ping every
// 20 s, and a socket that says nothing for 45 s is dead. The Mac's pending notices count, so the same 45 s catches a
// Mac that went away while its owner decided; ALLOW_MS bounds that wait by the 10-minute pairing window.
const HANDSHAKE_MS = 15_000;
const PING_MS = 20_000;
const SILENCE_MS = 45_000;
const ALLOW_MS = 11 * 60_000;
// The relay's close codes (apps/relay/src/room.mjs): the Mac closed the socket, no Mac in the room, room full.
const CLOSE_BY_HOST = 1000;
const CLOSE_HOST_OFFLINE = 4404;
const CLOSE_ROOM_FULL = 4429;
const DESKTOP_PEER = "desktop-peer-v1";
// Refusals that retrying can't change: the computer must be paired again (or its keys found).
const FINAL = new Set(["denied", "unknown-phone", "reset", "bad-token", "kind", "bad-host", "keys"]);
const decoder = new TextDecoder();

/** Why a computer turned this Mac away or couldn't be reached; computer-errors.cjs words it. */
class PeerError extends Error {
  /** @param {string} code @param {boolean} [final] */
  constructor(code, final = FINAL.has(code)) {
    super(`Couldn't connect to the computer (${code})`);
    this.name = "PeerError";
    this.code = code;
    this.final = final;
  }
}

/** The code for a Mac's refusal `{ t: "error", code, reason? }` (phone-channels.cjs). */
function refusalCode(refusal) {
  const { code, reason } = refusal ?? {};
  if (code === "unknown-phone") return reason === "denied" ? "denied" : reason === "busy" ? "busy" : "unknown-phone";
  if (code === "bad-token") return reason === "reset" ? "reset" : "bad-token";
  if (code === "bad-hello") return reason === "kind" ? "kind" : "bad-hello";
  return "lost";
}

function toBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null; // a text frame: the relay and the LAN host only send binary
}
const defaultRandom = (n) => new Uint8Array(randomBytes(n));
const defaultSocket = (url) => new WebSocket(url);

/**
 * Opens one paired-desktop channel to a computer and reads its daemon:status: over the relay (`url` is its base, e.g.
 * wss://relay.milagre.cloud) or the LAN (ws://<address>:8798); both serve /v1/phone?id=<hostId>. The hello carries
 * `kind: "desktop"` and this Mac's `name`; `hostKey` is the Mac's box key pinned from its link. Resolves with a client
 * shaped like @milagre/daemon/client's `connect` (call, close, status, "event", "close"), so daemon-runtime.cjs drives
 * it as it drives the socket. Rejects with a PeerError. `onPending()` runs once if the Mac holds this first pairing for
 * its owner's Allow; `signal` cancels the attempt ("cancelled").
 */
async function connectPeer({ url, hostId, hostKey, token, identity, name, onPending, signal, random = defaultRandom, createSocket = defaultSocket, timeoutMs = 30_000 }) {
  if (signal?.aborted) throw new PeerError("cancelled");
  const host = fromB64url(hostKey);
  const hello = phoneHello({ phone: identity, host, token, random, name, kind: "desktop" });
  const socket = createSocket(`${url.replace(/\/+$/, "")}/v1/phone?id=${encodeURIComponent(hostId)}`);
  socket.binaryType = "arraybuffer";
  const client = Object.assign(new EventEmitter(), {
    closed: false,
    /** @type {any} */
    status: undefined,
    /** @type {(method: string, args?: unknown[]) => Promise<any>} */
    call: async () => undefined,
    close: () => {},
  });
  const pending = new Map();
  const reader = createFrameReader("evt");
  const writer = createFrameWriter("rpc");
  /** @type {import("@milagre/shared/relay-crypto").Channel | null} */
  let channel = null;
  let nextId = 0;
  // Whether the daemon answered anything on this channel: a close before that, by the Mac, is a Mac from before PR 1.
  let answered = false;
  /** @type {Error | null} */
  let failure = null;
  let handshake, silence, ping, allowDeadline;
  /** @type {{ resolve: (value: unknown) => void; reject: (error: Error) => void } | null} */
  let settle = null;
  const opened = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });

  function end(error) {
    if (client.closed) return;
    client.closed = true;
    failure = error;
    for (const timer of [handshake, silence, ping, allowDeadline]) clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    try {
      socket.close();
    } catch {
      /* already closed */
    }
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("Daemon connection closed"));
    }
    pending.clear();
    if (settle) {
      settle.reject(error);
      settle = null;
    } else client.emit("close");
  }
  function cancel() {
    end(new PeerError("cancelled"));
  }
  signal?.addEventListener("abort", cancel, { once: true });
  function send(bytes) {
    try {
      socket.send(bytes);
    } catch {
      end(new PeerError("lost"));
    }
  }
  function heard() {
    clearTimeout(silence);
    silence = setTimeout(() => end(new PeerError("lost")), SILENCE_MS);
  }
  function tick() {
    if (client.closed || !channel) return;
    send(channel.seal({ t: "ping" }));
    ping = setTimeout(tick, PING_MS);
  }
  function waitForAllow() {
    clearTimeout(handshake);
    if (allowDeadline) return;
    allowDeadline = setTimeout(() => end(new PeerError("unknown-phone")), ALLOW_MS);
    try {
      onPending?.();
    } catch {
      /* the caller's bug must not end the pairing */
    }
  }
  /** One daemon frame: an event, or the answer to a call (as @milagre/daemon/client reads the socket's). */
  function receive(frame) {
    if (frame?.v !== VERSION) return end(new PeerError("outdated"));
    if (frame.event) {
      client.emit("event", frame.event);
      return;
    }
    answered = true;
    const request = pending.get(frame.id);
    if (!request) return;
    pending.delete(frame.id);
    clearTimeout(request.timeout);
    if (frame.error) request.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }));
    else if (frame.pages) request.resolve(readPages(frame.pages));
    else request.resolve(frame.result);
  }
  // A response too large for one frame (a big Project's state) arrives as pages, read one at a time in order.
  async function readPages({ pageId, pageCount }) {
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new Error("The daemon sent an invalid paged response");
    const parts = [];
    for (let index = 0; index < pageCount; index++) parts.push(await client.call("daemon:result-page", [pageId, index]));
    return JSON.parse(parts.join(""));
  }

  socket.onopen = () => {
    if (!client.closed) send(hello.message);
  };
  // A failed socket always closes afterwards, with the code that says why.
  socket.onerror = () => {};
  socket.onclose = (event) => {
    const code = event?.code;
    if (!channel) end(new PeerError(code === CLOSE_ROOM_FULL ? "full" : code === CLOSE_HOST_OFFLINE ? "offline" : "lost"));
    // A Mac from before PR 1 takes the hello as a phone's and closes on the first rpc message.
    else end(new PeerError(!answered && code === CLOSE_BY_HOST ? "outdated" : "lost"));
  };
  socket.onmessage = (event) => {
    if (client.closed) return;
    const bytes = toBytes(event?.data);
    if (!bytes?.length) return end(new PeerError("lost"));
    heard();
    if (channel) {
      let read;
      try {
        const message = channel.open(bytes);
        if (message?.t === "pong") return;
        read = reader.read(message);
      } catch {
        return end(new PeerError("lost"));
      }
      if (read) receive(read.frame);
      return;
    }
    if (bytes[0] === PENDING) return waitForAllow();
    clearTimeout(handshake);
    clearTimeout(allowDeadline);
    if (bytes[0] === REFUSED) {
      let refusal = null;
      try {
        refusal = JSON.parse(decoder.decode(bytes.subarray(1)));
      } catch {
        /* unreadable: a drop */
      }
      return end(new PeerError(refusalCode(refusal)));
    }
    if (bytes[0] !== ACCEPT) return end(new PeerError("lost"));
    try {
      channel = phoneFinish({ ephemeral: hello.ephemeral, phone: identity, host, reply: bytes });
    } catch {
      return end(new PeerError("bad-host"));
    }
    ping = setTimeout(tick, PING_MS);
    settle?.resolve(undefined);
    settle = null;
  };
  handshake = setTimeout(() => end(new PeerError("lost")), HANDSHAKE_MS);

  client.call = (method, args = []) =>
    new Promise((resolve, reject) => {
      if (client.closed || !channel) return reject(new Error("Daemon connection closed"));
      if (pending.size >= MAX_PENDING) return reject(new Error("Too many pending daemon requests"));
      const id = ++nextId;
      let texts;
      try {
        texts = writer.write(JSON.stringify({ v: VERSION, id, method, args, pages: true }));
      } catch (error) {
        return reject(error);
      }
      const timeout = setTimeout(
        () => {
          pending.delete(id);
          reject(new Error(`Timed out: ${method}. It may still be running; do not retry a mutation without checking state.`));
        },
        deadlineFor(method, timeoutMs),
      );
      pending.set(id, { resolve, reject, timeout });
      for (const text of texts) send(channel.sealEncoded(text));
    });
  client.close = () => end(new PeerError("lost"));

  await opened;
  let status;
  try {
    status = await client.call("daemon:status");
  } catch (error) {
    const reason = failure;
    client.close();
    throw reason ?? error;
  }
  if (!status?.capabilities?.includes(DESKTOP_PEER) || !Array.isArray(status.methods)) {
    client.close();
    throw new PeerError("outdated");
  }
  client.status = status;
  return client;
}

module.exports = { connectPeer, PeerError };
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test apps/desktop/electron/peer-client.test.cjs apps/desktop/electron/computer-errors.test.cjs`
Expected: PASS (every test in both files), and the process exits (no timer left behind).

- [ ] **Step 9: Commit**

```bash
npx oxfmt apps/desktop/electron/peer-client.cjs apps/desktop/electron/peer-client.test.cjs apps/desktop/electron/computer-errors.cjs apps/desktop/electron/computer-errors.test.cjs
git add apps/desktop/electron/peer-client.cjs apps/desktop/electron/peer-client.test.cjs apps/desktop/electron/computer-errors.cjs apps/desktop/electron/computer-errors.test.cjs
git commit -m "feat(desktop): a paired-desktop channel shaped like the daemon client"
```

---

### Task 7: Saved computers and their keys

**Files:**
- Create: `apps/desktop/electron/computers-store.cjs`, `apps/desktop/electron/computers-store.test.cjs`
- Create: `apps/desktop/electron/computer-keys.cjs`, `apps/desktop/electron/computer-keys.test.cjs`

**Interfaces:**
- Consumes: `helloName`, `b64url`, `fromB64url`, `boxKeyPair` (`@milagre/shared/relay-crypto`); `writePrivate` (`@milagre/daemon/relay-identity`).
- Produces: `createComputersStore({ file, now? })` with `load() => Promise<Computer[]>`, `list()`, `get(id) => Computer | null`, `add({ id, hostId, name, relay }) => Promise<Computer>`, `rename(id, name) => Promise<Computer>` (throws "Give it a name." / "That computer was removed."), `setLanRoutes(id, routes)`, `seen(id)` (file written at most once a minute), `remove(id) => Promise<boolean>`. `Computer = { id, hostId, name, relay, lanRoutes: string[], addedAt, lastSeen }`. Also `lanRoutesFrom(answer, { hostId, hostKey }) => string[] | null` and `LAN_ROUTE`.
- Produces: `createComputerKeys({ file, safeStorage, random })` with `identity() => Promise<KeyPair>` (made once), `secretsOf(id) => Promise<{ hostKey, token } | null>`, `save(id, { hostKey, token })`, `forget(id)`. The file is `{ v: 1, sealed: base64 }`, sealed with `safeStorage.encryptString`.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/electron/computers-store.test.cjs`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createComputersStore, lanRoutesFrom } = require("./computers-store.cjs");

const HOST = "h".repeat(22);
const KEY = "k".repeat(43);

async function store(t, clock = { now: 1000 }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "computers-store-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "computers.json");
  const open = () => createComputersStore({ file, now: () => clock.now });
  return { file, open, clock };
}

test("a computer is saved with this Mac's name for it, renamed, seen and removed", async (t) => {
  const { file, open, clock } = await store(t);
  const computers = open();
  assert.deepEqual(await computers.load(), []);
  const added = await computers.add({ id: "c1", hostId: HOST, name: "  studio‮  ", relay: "wss://relay.milagre.cloud" });
  assert.deepEqual(added, { id: "c1", hostId: HOST, name: "studio", relay: "wss://relay.milagre.cloud", lanRoutes: [], addedAt: 1000, lastSeen: 1000 });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await computers.rename("c1", "lab")).name, "lab");
  await assert.rejects(computers.rename("c1", "   "), /Give it a name/);
  await assert.rejects(computers.rename("nope", "x"), /removed/);
  clock.now = 2000;
  await computers.seen("c1");
  clock.now = 3000;
  await computers.seen("c1");
  assert.equal(computers.get("c1").lastSeen, 3000, "in memory at once");
  assert.equal(JSON.parse(await fs.readFile(file, "utf8"))[0].lastSeen, 2000, "on disk at most once a minute");
  const again = open();
  assert.deepEqual(
    (await again.load()).map((computer) => [computer.id, computer.name]),
    [["c1", "lab"]],
  );
  assert.equal(await again.remove("c1"), true);
  assert.equal(await again.remove("c1"), false);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), []);
});

test("LAN routes keep private and loopback addresses only, and a damaged file reads as no computers", async (t) => {
  const { file, open } = await store(t);
  const computers = open();
  await computers.load();
  await computers.add({ id: "c1", hostId: HOST, name: "studio", relay: "wss://relay.milagre.cloud" });
  await computers.setLanRoutes("c1", ["ws://192.168.1.20:8798", "ws://8.8.8.8:8798", "wss://10.0.0.1:8798", "ws://127.0.0.1:5000", 7]);
  assert.deepEqual(computers.get("c1").lanRoutes, ["ws://192.168.1.20:8798", "ws://127.0.0.1:5000"]);
  await fs.writeFile(file, "[{ not json");
  assert.deepEqual(await open().load(), []);
  await fs.writeFile(file, JSON.stringify([{ id: "x", hostId: "short", relay: "wss://r" }, { id: "c2", hostId: HOST, relay: "wss://r", name: "" }]));
  assert.deepEqual(
    (await open().load()).map((computer) => [computer.id, computer.name]),
    [["c2", "Computer"]],
  );
});

test("a peer:routes answer gives LAN routes only when it names the Mac pinned at pairing", () => {
  const answer = { hostId: HOST, key: KEY, lan: ["ws://192.168.1.20:8798", "ws://1.2.3.4:8798"] };
  assert.deepEqual(lanRoutesFrom(answer, { hostId: HOST, hostKey: KEY }), ["ws://192.168.1.20:8798"]);
  assert.equal(lanRoutesFrom({ ...answer, key: "x".repeat(43) }, { hostId: HOST, hostKey: KEY }), null);
  assert.equal(lanRoutesFrom({ ...answer, hostId: "g".repeat(22) }, { hostId: HOST, hostKey: KEY }), null);
  assert.equal(lanRoutesFrom(null, { hostId: HOST, hostKey: KEY }), null);
  assert.deepEqual(lanRoutesFrom({ hostId: HOST, key: KEY }, { hostId: HOST, hostKey: KEY }), []);
});
```

Create `apps/desktop/electron/computer-keys.test.cjs`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { b64url } = require("@milagre/shared/relay-crypto");
const { createComputerKeys } = require("./computer-keys.cjs");

const random = (n) => new Uint8Array(randomBytes(n));
/** Stands in for Electron's safeStorage: reversible, and never the plain text. */
const keychain = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (text) => Buffer.from(text, "utf8").map((byte) => byte ^ 0x5a),
  decryptString: (bytes) => Buffer.from(bytes).map((byte) => byte ^ 0x5a).toString("utf8"),
});

async function file(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "computer-keys-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, "computer-keys.json");
}

test("this Mac's key pair is made once, and each computer's key and token stay sealed", async (t) => {
  const where = await file(t);
  const keys = createComputerKeys({ file: where, safeStorage: keychain(), random });
  const [one, two] = await Promise.all([keys.identity(), keys.identity()]);
  assert.equal(b64url(one.publicKey), b64url(two.publicKey), "two callers, one key pair");
  const token = "f".repeat(64);
  const hostKey = "K".repeat(43);
  await keys.save("c1", { hostKey, token });
  const raw = await fs.readFile(where, "utf8");
  assert.equal(raw.includes(token), false);
  assert.equal(raw.includes(hostKey), false);
  assert.equal(raw.includes(b64url(one.secretKey)), false);
  assert.equal((await fs.stat(where)).mode & 0o777, 0o600);
  const reopened = createComputerKeys({ file: where, safeStorage: keychain(), random });
  assert.equal(b64url((await reopened.identity()).publicKey), b64url(one.publicKey));
  assert.deepEqual(await reopened.secretsOf("c1"), { hostKey, token });
  await reopened.forget("c1");
  assert.equal(await reopened.secretsOf("c1"), null);
  assert.equal(await reopened.secretsOf("nope"), null);
});

test("without a keychain, or with keys sealed by another, nothing is made or read", async (t) => {
  const where = await file(t);
  await assert.rejects(createComputerKeys({ file: where, safeStorage: keychain(false), random }).identity(), /keychain/);
  await fs.writeFile(where, JSON.stringify({ v: 1, sealed: Buffer.from("not sealed by this keychain").toString("base64") }));
  await assert.rejects(createComputerKeys({ file: where, safeStorage: keychain(), random }).identity(), /can't be read/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test apps/desktop/electron/computers-store.test.cjs apps/desktop/electron/computer-keys.test.cjs`
Expected: FAIL with `Cannot find module './computers-store.cjs'` and `'./computer-keys.cjs'`.

- [ ] **Step 3: Write the store**

Create `apps/desktop/electron/computers-store.cjs`:

```js
const fs = require("node:fs/promises");
const { helloName } = require("@milagre/shared/relay-crypto");
const { writePrivate } = require("@milagre/daemon/relay-identity");

// lastSeen moves with every connection; the file follows at most this often.
const SEEN_WRITE_MS = 60_000;
const MAX_LAN_ROUTES = 4;
const HOST_ID = /^[A-Za-z0-9_-]{22}$/;
// A computer's id here; no "|", which PR 4's stored chat keys use (`${computerId}|${key}`).
const ID = /^[A-Za-z0-9-]{1,64}$/;
// A LAN route: a private address, as the phone takes (apps/mobile/src/lan-route.ts), or this Mac's loopback, which
// reaches only this Mac and still has to pass the probe's host id and the hello's pinned key (the end-to-end tests).
const LAN_ROUTE = /^ws:\/\/(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168|127\.0)\.\d{1,3}\.\d{1,3}:\d{1,5}$/;

const lanRoutesOf = (value) =>
  Array.isArray(value) ? value.filter((url) => typeof url === "string" && LAN_ROUTE.test(url)).slice(0, MAX_LAN_ROUTES) : [];
const time = (value) => (Number.isFinite(value) ? value : null);
const copy = (computer) => ({ ...computer, lanRoutes: [...computer.lanRoutes] });

function readComputer(value) {
  if (!value || typeof value.id !== "string" || !ID.test(value.id) || !HOST_ID.test(String(value.hostId)) || typeof value.relay !== "string") return null;
  return {
    id: value.id,
    hostId: String(value.hostId),
    name: helloName(value.name) ?? "Computer",
    relay: value.relay,
    lanRoutes: lanRoutesOf(value.lanRoutes),
    addedAt: time(value.addedAt),
    lastSeen: time(value.lastSeen),
  };
}

/** The LAN routes in a computer's peer:routes answer, only when it names the Mac pinned at pairing; null otherwise. */
function lanRoutesFrom(answer, { hostId, hostKey }) {
  if (!answer || answer.hostId !== hostId || answer.key !== hostKey) return null;
  return lanRoutesOf(answer.lan);
}

/**
 * The computers this Mac drives, oldest first, in `<userData>/computers.json` (0600): `[{ id, hostId, name, relay,
 * lanRoutes, addedAt, lastSeen }]`. `name` is this Mac's label ("Show it as"), sent nowhere. The Mac's pinned key and its
 * pairing token are secrets and live in computer-keys.cjs. Writes land in call order.
 */
function createComputersStore({ file, now = Date.now }) {
  let computers = [];
  let writes = Promise.resolve();
  const seenWritten = new Map();
  const write = () => {
    const value = computers.map(copy);
    const next = writes.then(() => writePrivate(file, value));
    writes = next.catch(() => {});
    return next;
  };
  const find = (id) => computers.find((computer) => computer.id === id);
  const list = () => computers.map(copy);
  return {
    async load() {
      try {
        const value = JSON.parse(await fs.readFile(file, "utf8"));
        computers = (Array.isArray(value) ? value : []).map(readComputer).filter((computer) => computer !== null);
      } catch {
        computers = [];
      }
      return list();
    },
    list,
    get(id) {
      const computer = find(id);
      return computer ? copy(computer) : null;
    },
    async add({ id, hostId, name, relay }) {
      const computer = readComputer({ id, hostId, name, relay, lanRoutes: [], addedAt: now(), lastSeen: now() });
      if (!computer) throw new Error("That computer's link is damaged.");
      computers = [...computers.filter((item) => item.id !== id), computer];
      await write();
      return copy(computer);
    },
    async rename(id, name) {
      const computer = find(id);
      if (!computer) throw new Error("That computer was removed.");
      const next = helloName(name);
      if (!next) throw new Error("Give it a name.");
      computer.name = next;
      await write();
      return copy(computer);
    },
    async setLanRoutes(id, routes) {
      const computer = find(id);
      if (!computer) return;
      const next = lanRoutesOf(routes);
      if (JSON.stringify(next) === JSON.stringify(computer.lanRoutes)) return;
      computer.lanRoutes = next;
      await write();
    },
    async seen(id) {
      const computer = find(id);
      if (!computer) return;
      const at = now();
      computer.lastSeen = at;
      if (at - (seenWritten.get(id) ?? -Infinity) < SEEN_WRITE_MS) return;
      seenWritten.set(id, at);
      await write();
    },
    async remove(id) {
      if (!find(id)) return false;
      computers = computers.filter((computer) => computer.id !== id);
      await write();
      return true;
    },
  };
}

module.exports = { createComputersStore, lanRoutesFrom, LAN_ROUTE };
```

- [ ] **Step 4: Write the keys**

Create `apps/desktop/electron/computer-keys.cjs`:

```js
const fs = require("node:fs/promises");
const { b64url, boxKeyPair, fromB64url } = require("@milagre/shared/relay-crypto");
const { writePrivate } = require("@milagre/daemon/relay-identity");

const NO_KEYCHAIN = "This Mac can't keep keys in its keychain, so it can't pair with computers.";
const UNREADABLE = "This Mac's keys for its computers can't be read. Remove them and pair again.";

/**
 * This Mac's own key pair (the "phone" key of every computer's hello) and, per computer, the Mac's pinned box key and
 * pairing token (every hello carries it), sealed with Electron's safeStorage, whose key lives in the login keychain, in
 * `<userData>/computer-keys.json` as `{ v: 1, sealed: base64 }`. Read once, kept in memory; each change rewrites it.
 */
function createComputerKeys({ file, safeStorage, random }) {
  let loaded = null;
  let making = null;
  let writes = Promise.resolve();
  async function read() {
    if (!safeStorage.isEncryptionAvailable()) throw new Error(NO_KEYCHAIN);
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { identity: null, computers: {} };
      throw new Error(UNREADABLE);
    }
    try {
      const plain = JSON.parse(safeStorage.decryptString(Buffer.from(JSON.parse(text).sealed, "base64")));
      return { identity: plain?.identity ?? null, computers: plain?.computers && typeof plain.computers === "object" ? plain.computers : {} };
    } catch {
      throw new Error(UNREADABLE);
    }
  }
  const state = () =>
    (loaded ??= read().catch((error) => {
      loaded = null;
      throw error;
    }));
  function persist(value) {
    const sealed = safeStorage.encryptString(JSON.stringify(value)).toString("base64");
    const next = writes.then(() => writePrivate(file, { v: 1, sealed }));
    writes = next.catch(() => {});
    return next;
  }
  return {
    /** This Mac's box key pair, made the first time a computer needs it. */
    identity() {
      making ??= (async () => {
        const value = await state();
        if (!value.identity) {
          const pair = boxKeyPair(random);
          value.identity = { publicKey: b64url(pair.publicKey), secretKey: b64url(pair.secretKey) };
          await persist(value);
        }
        return { publicKey: fromB64url(value.identity.publicKey), secretKey: fromB64url(value.identity.secretKey) };
      })().catch((error) => {
        making = null;
        throw error;
      });
      return making;
    },
    async secretsOf(id) {
      const found = (await state()).computers[id];
      return found && typeof found.hostKey === "string" && typeof found.token === "string" ? { hostKey: found.hostKey, token: found.token } : null;
    },
    async save(id, { hostKey, token }) {
      const value = await state();
      value.computers[id] = { hostKey, token };
      await persist(value);
    },
    async forget(id) {
      const value = await state();
      if (!(id in value.computers)) return;
      delete value.computers[id];
      await persist(value);
    },
  };
}

module.exports = { createComputerKeys };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test apps/desktop/electron/computers-store.test.cjs apps/desktop/electron/computer-keys.test.cjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx oxfmt apps/desktop/electron/computers-store.cjs apps/desktop/electron/computers-store.test.cjs apps/desktop/electron/computer-keys.cjs apps/desktop/electron/computer-keys.test.cjs
git add apps/desktop/electron/computers-store.cjs apps/desktop/electron/computers-store.test.cjs apps/desktop/electron/computer-keys.cjs apps/desktop/electron/computer-keys.test.cjs
git commit -m "feat(desktop): save paired computers, their keys sealed in the keychain"
```

---

### Task 8: The runtime drives a host it reaches but doesn't own

**Files:**
- Modify: `apps/desktop/electron/daemon-runtime.cjs:43-51` (start), `:196-211` (reconnect), `:332-336` (`restartHost`), `:355-369` (`close`)
- Test: `apps/desktop/electron/daemon-runtime.test.cjs`

**Interfaces:**
- Consumes: a `connect() => Promise<DaemonClient>` such as Task 6's `connectPeer`.
- Produces: `connectDesktopRuntime({ connect, emit, dataDir, reconnectMs })`. With `connect`, the first connection and every reconnect come from it; the runtime never starts a host, never calls `daemon:flush` on close, and `restartHost()` and `close({ stopHost: true })` throw. Without it nothing changes.

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/electron/daemon-runtime.test.cjs`:

```js
test("a runtime given `connect` reconnects through it alone, and never starts, flushes, stops or restarts that host", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-remote-runtime-")));
  const project = path.join(root, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  const dataDir = path.join(root, "profile");
  const daemon = await startDaemon({ dataDir, version: "test", runtimeOptions: { cwd: project, environmentReady: Promise.resolve(), titleModels: {} } });
  const connections = [];
  const calls = [];
  const connect = async () => {
    const client = await compatibleClient(dataDir);
    const call = client.call.bind(client);
    client.call = (method, args) => {
      calls.push(method);
      return call(method, args);
    };
    connections.push(client);
    return client;
  };
  const events = [];
  const remote = await connectDesktopRuntime({
    dataDir: path.join(root, "not-this-macs-host"),
    connect,
    reconnectMs: 20,
    startHost: async () => {
      throw new Error("must not start a host");
    },
    emit: (channel, payload) => events.push({ channel, payload }),
  });
  t.after(async () => {
    await remote.close().catch(() => {});
    await daemon.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.equal(connections.length, 1);
  assert.ok(remote.methods.includes("project:open"));
  connections[0].close();
  await waitFor(() => events.some((event) => event.channel === "runtime:connection" && event.payload.connected));
  assert.equal(connections.length, 2, "reconnected through connect");
  assert.ok(events.some((event) => event.channel === "runtime:snapshot"), "and read the state again");
  await assert.rejects(remote.restartHost(), /Only this Mac's own host/);
  await assert.rejects(remote.close({ stopHost: true }), /Only this Mac's own host/);
  await remote.close();
  assert.equal(calls.includes("daemon:flush"), false);
  assert.equal(calls.includes("daemon:stop"), false);
  const check = await compatibleClient(dataDir);
  check.close();
  assert.ok(check.status.capabilities.includes("desktop-v1"), "the host still runs");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test --test-name-pattern "given .connect." apps/desktop/electron/daemon-runtime.test.cjs`
Expected: FAIL with `Error: must not start a host`.

- [ ] **Step 3: Add the `connect` option**

In `apps/desktop/electron/daemon-runtime.cjs`, replace the start of `connectDesktopRuntime`:

```js
async function connectDesktopRuntime(options) {
  const { emit = () => {}, dataDir, reconnectMs = 1000 } = options;
  // The start every launch and restartHost use; tests stand in for it.
  /** @type {typeof ensureDaemon} */
  const startHost = options.startHost ?? ensureDaemon;
  /** @type {import('@milagre/daemon/bootstrap').DaemonClient | null} */
  let client = await startHost(options);
```

with:

```js
async function connectDesktopRuntime(options) {
  const { emit = () => {}, dataDir, reconnectMs = 1000 } = options;
  // The start every launch and restartHost use; tests stand in for it.
  /** @type {typeof ensureDaemon} */
  const startHost = options.startHost ?? ensureDaemon;
  // A paired computer's host (computers.cjs) is only reached, through `connect`: this Mac never starts, flushes, stops
  // or restarts it. Without `connect` the runtime drives this Mac's own host.
  const remote = typeof options.connect === "function";
  /** @type {import('@milagre/daemon/bootstrap').DaemonClient | null} */
  let client = remote ? await options.connect() : await startHost(options);
```

In `reconnect()`, replace:

```js
      if (mayStart()) {
```

with:

```js
      if (remote) connection = await options.connect();
      else if (mayStart()) {
```

At the top of `restartHost()`, before `if (closed || restarting) return;`, add:

```js
      if (remote) throw new Error("Only this Mac's own host restarts from here.");
```

In `close()`, replace:

```js
      if (stop) {
```

with:

```js
      if (stop && remote) throw new Error("Only this Mac's own host stops from here.");
      if (stop) {
```

and replace:

```js
      } else if (client && !recovering) await client.call("daemon:flush");
```

with:

```js
      } else if (client && !recovering && !remote) await client.call("daemon:flush");
```

The test's `/Only this Mac's own host/` matches both messages.

- [ ] **Step 4: Run the runtime tests**

Run: `node --test apps/desktop/electron/daemon-runtime.test.cjs`
Expected: PASS (every test in the file).

- [ ] **Step 5: Commit**

```bash
npx oxfmt apps/desktop/electron/daemon-runtime.cjs apps/desktop/electron/daemon-runtime.test.cjs
git add apps/desktop/electron/daemon-runtime.cjs apps/desktop/electron/daemon-runtime.test.cjs
git commit -m "feat(desktop): the daemon runtime can drive a host it only reaches"
```

---

### Task 9: `computers.cjs`

**Files:**
- Create: `apps/desktop/electron/computers.cjs`, `apps/desktop/electron/computers.test.cjs`

**Interfaces:**
- Consumes: `connectPeer`, `PeerError` (Task 6); `computerProblem` (Task 6); `createComputersStore`, `lanRoutesFrom` (Task 7); `createComputerKeys` (Task 7); `connectDesktopRuntime` with `connect` (Task 8); `parsePairing` and `createRouteSupervisor`, `PROBE_TIMEOUT` (Task 5); `computerName` (`@milagre/daemon/mobile-pairing`).
- Produces: `createComputers({ dataDir, safeStorage, name?, onChange?, emit?, ownHostId?, allowLocalRelay?, createSocket?, fetch?, now?, random?, reconnectMs?, offlineAfterMs?, checkEveryMs?, networkMs?, backoffMs?, networkSignature? })` returning:
  - `list(): ComputerView[]` with `ComputerView = { id, name, hostId, relayHost, state: "off" | "connecting" | "online" | "reconnecting" | "offline" | "refused", route: "lan" | "relay" | null, lastSeen: number | null, message: string | null, lan: boolean }` (`route` only while online; `lan` once it knows a LAN route).
  - `preview(link): Promise<{ name, hostId, relayHost }>`; throws the words to show.
  - `add(link, { name }, { onPending }): Promise<ComputerView>`; throws the words to show (an `Error` with `code`); `cancelAdd()`.
  - `rename(id, name)`, `remove(id)`, `invoke(id, method, args?)`, `setEnabled(on)`, `close()`.
  - `onChange(list)` after every change; `emit(computerId, channel, payload)` for each runtime event other than `runtime:connection` (PR 4 forwards them to the window).
  PR 3b's `main.cjs` passes `safeStorage` from Electron, `ownHostId` read from the local host's `phone:status` link, and calls `setEnabled` from the "Other computers" setting.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/electron/computers.test.cjs`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createComputers } = require("./computers.cjs");

const OWN = "o".repeat(22);
const HOST = "h".repeat(22);
const keychain = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text, "utf8").map((byte) => byte ^ 0x5a),
  decryptString: (bytes) => Buffer.from(bytes).map((byte) => byte ^ 0x5a).toString("utf8"),
};
const link = ({ relay = "wss://relay.milagre.cloud", host = HOST, name = "studio" } = {}) =>
  `milagre://pair?relay=${encodeURIComponent(relay)}&host=${host}&key=${"k".repeat(43)}&token=${"a".repeat(64)}&name=${encodeURIComponent(name)}`;

async function setup(t, { saved } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "computers-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  if (saved) await fs.writeFile(path.join(dataDir, "computers.json"), JSON.stringify(saved), { mode: 0o600 });
  const changes = [];
  const computers = createComputers({
    dataDir,
    safeStorage: keychain,
    name: () => "desk",
    ownHostId: async () => OWN,
    onChange: (list) => changes.push(list),
    networkMs: 60_000,
  });
  t.after(() => computers.close());
  return { dataDir, computers, changes };
}
const studio = { id: "c1", hostId: HOST, name: "studio", relay: "wss://relay.milagre.cloud", lanRoutes: [], addedAt: 1, lastSeen: 1 };

test("a relay link previews as the computer it names and how it is reached, without its token", async (t) => {
  const { computers } = await setup(t);
  assert.deepEqual(await computers.preview(link()), { name: "studio", hostId: HOST, relayHost: "relay.milagre.cloud" });
});

test("a pasted link that isn't a relay link, this Mac's own, or a computer already added, is refused before any socket opens", async (t) => {
  const { computers } = await setup(t, { saved: [studio] });
  await assert.rejects(computers.preview("hello"), { message: "That isn't a Milagre pairing link. Copy it from Settings › Devices on the other Mac." });
  await assert.rejects(computers.preview(link({ relay: "ws://127.0.0.1:9000" })), /isn't a Milagre pairing link/);
  await assert.rejects(computers.preview(`milagre://pair?address=${encodeURIComponent("https://mac.example.com")}&token=${"a".repeat(64)}&name=x`), {
    message: "This link reaches its Mac through a Cloudflare tunnel, which computers can't use yet.",
  });
  await assert.rejects(computers.preview(link({ host: OWN })), { message: "That's this Mac's own link. Copy the one on the other Mac." });
  await assert.rejects(computers.preview(link({ name: "anything" })), { message: "studio is already in your computers." });
  await assert.rejects(computers.add(link()), { message: "studio is already in your computers." });
});

test("saved computers are off until Other computers is on, and one whose keys are gone says so and stops", async (t) => {
  const { computers } = await setup(t, { saved: [studio] });
  assert.deepEqual(
    computers.list().map((computer) => [computer.name, computer.state, computer.route]),
    [["studio", "off", null]],
  );
  await computers.setEnabled(true);
  for (let i = 0; i < 200 && computers.list()[0].state !== "refused"; i++) await delay(5);
  assert.deepEqual(computers.list()[0].state, "refused");
  assert.equal(computers.list()[0].message, "This Mac lost its keys for studio. Remove it and pair again.");
  await assert.rejects(computers.invoke("c1", "daemon:status"), /studio is offline/);
  await computers.setEnabled(false);
  assert.equal(computers.list()[0].state, "off");
});

test("a computer is renamed here only, and removed with its keys", async (t) => {
  const { dataDir, computers, changes } = await setup(t, { saved: [studio] });
  await computers.rename("c1", "  lab  ");
  assert.equal(computers.list()[0].name, "lab");
  assert.equal(changes.at(-1)[0].name, "lab");
  await assert.rejects(computers.rename("c1", ""), /Give it a name/);
  await computers.remove("c1");
  assert.deepEqual(computers.list(), []);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, "computers.json"), "utf8")), []);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test apps/desktop/electron/computers.test.cjs`
Expected: FAIL with `Cannot find module './computers.cjs'`.

- [ ] **Step 3: Write `computers.cjs`**

Create `apps/desktop/electron/computers.cjs`:

```js
const os = require("node:os");
const path = require("node:path");
const { randomBytes, randomUUID } = require("node:crypto");
const { helloName } = require("@milagre/shared/relay-crypto");
const { parsePairing } = require("@milagre/shared/pairing-link");
const { createRouteSupervisor, PROBE_TIMEOUT } = require("@milagre/shared/route-supervisor");
const { computerName } = require("@milagre/daemon/mobile-pairing");
const { connectDesktopRuntime } = require("./daemon-runtime.cjs");
const { connectPeer, PeerError } = require("./peer-client.cjs");
const { computerProblem } = require("./computer-errors.cjs");
const { createComputersStore, lanRoutesFrom } = require("./computers-store.cjs");
const { createComputerKeys } = require("./computer-keys.cjs");

// Spec "Errors": amber ("Reconnecting…") while it comes back, grey ("Offline") once it has been gone this long.
const OFFLINE_AFTER_MS = 30_000;
// The route is checked again this often, and when this Mac's addresses change (looked at every NETWORK_MS).
const CHECK_EVERY_MS = 60_000;
const NETWORK_MS = 5_000;
// A computer that can't be reached at launch is tried again after these waits; a runtime then retries on its own.
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
// Problems worth a line under a computer while it keeps retrying; the rest read as Reconnecting… or Offline.
const SHOWN = new Set(["full", "outdated", "kind", "bad-hello", "busy"]);
const NOT_A_LINK = "That isn't a Milagre pairing link. Copy it from Settings › Devices on the other Mac.";
const TUNNEL_LINK = "This link reaches its Mac through a Cloudflare tunnel, which computers can't use yet.";

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const defaultNetworkSignature = () =>
  JSON.stringify(
    Object.values(os.networkInterfaces())
      .flat()
      .filter((address) => address && !address.internal)
      .map((address) => address.address)
      .sort(),
  );

/**
 * The other Macs this desktop drives (spec "This Mac (Electron main) › Computers"). Each saved computer, while
 * `setEnabled(true)` (Settings › Experimental › Other computers), gets one runtime (daemon-runtime.cjs) whose connections
 * are paired-desktop channels (peer-client.cjs) on the route the shared supervisor picks: a LAN address the computer
 * gave (peer:routes) when it answers, the relay otherwise; checked on every connect, every 60 s and when this Mac's
 * network changes. A refusal retrying can't fix (removed, reset, denied) stops it until it is paired again.
 */
function createComputers({
  dataDir,
  safeStorage,
  name = computerName,
  onChange = () => {},
  emit = () => {},
  ownHostId = async () => null,
  allowLocalRelay = false,
  createSocket,
  fetch = globalThis.fetch,
  now = Date.now,
  random = (n) => new Uint8Array(randomBytes(n)),
  reconnectMs = 3000,
  offlineAfterMs = OFFLINE_AFTER_MS,
  checkEveryMs = CHECK_EVERY_MS,
  networkMs = NETWORK_MS,
  backoffMs = BACKOFF_MS,
  networkSignature = defaultNetworkSignature,
}) {
  const store = createComputersStore({ file: path.join(dataDir, "computers.json"), now });
  const keys = createComputerKeys({ file: path.join(dataDir, "computer-keys.json"), safeStorage, random });
  const ready = store.load();
  const entries = new Map();
  let enabled = false;
  let closed = false;
  /** @type {AbortController | null} */
  let adding = null;
  let checkTimer = null;
  let networkTimer = null;
  const socketOption = createSocket ? { createSocket } : {};

  function view(computer) {
    const entry = entries.get(computer.id);
    const state = enabled ? (entry?.state ?? "connecting") : "off";
    return {
      id: computer.id,
      name: computer.name,
      hostId: computer.hostId,
      relayHost: hostOf(computer.relay),
      state,
      route: state === "online" ? (entry?.route ?? null) : null,
      lastSeen: computer.lastSeen,
      message: enabled ? (entry?.message ?? null) : null,
      lan: computer.lanRoutes.length > 0,
    };
  }
  const list = () => store.list().map(view);
  function changed() {
    try {
      onChange(list());
    } catch {
      /* a listener must not break the computers */
    }
  }

  /** Whether this address still answers as the Mac pinned at pairing (lan-host.cjs /v1/hello). No credentials go out. */
  async function probe(endpoint, hostId) {
    try {
      const response = await fetch(`${endpoint.replace(/^ws:/, "http:")}/v1/hello`, { signal: AbortSignal.timeout(PROBE_TIMEOUT) });
      if (!response.ok) return false;
      const body = await response.json();
      return body?.v === 1 && body.hostId === hostId;
    } catch {
      return false;
    }
  }

  async function dial(entry, url) {
    const computer = store.get(entry.id);
    if (!computer || !entry.secrets) throw new PeerError("keys");
    return connectPeer({
      url,
      hostId: computer.hostId,
      hostKey: entry.secrets.hostKey,
      token: entry.secrets.token,
      identity: await keys.identity(),
      name: name(),
      random,
      // Turning the computer off or quitting cancels a hello in flight instead of waiting out its 15 s.
      signal: entry.abort.signal,
      ...socketOption,
    });
  }

  /** A LAN channel as the route supervisor sees it; the runtime takes its client once (`used`). */
  async function openLan(entry, endpoint, onLost) {
    const client = await dial(entry, endpoint);
    client.once("close", onLost);
    return {
      client,
      used: false,
      ready: async () => {
        if (client.closed) throw new Error("The LAN connection closed");
      },
      close: () => client.close(),
    };
  }

  function entryFor(id) {
    const found = entries.get(id);
    if (found) return found;
    const entry = {
      id,
      runtime: null,
      client: null,
      route: null,
      state: "connecting",
      message: null,
      lastError: null,
      secrets: null,
      starting: null,
      retryTimer: null,
      offlineTimer: null,
      attempts: 0,
      refused: false,
      stopped: false,
      switching: false,
      abort: new AbortController(),
      supervisor: null,
    };
    entry.supervisor = createRouteSupervisor({
      lan: () => {
        const computer = store.get(id);
        if (!computer?.lanRoutes.length || !entry.secrets) return undefined;
        return { hostId: computer.hostId, key: entry.secrets.hostKey, endpoints: computer.lanRoutes, learnedAt: 0 };
      },
      probe,
      openLan: (endpoint, _lan, onLost) => openLan(entry, endpoint, onLost),
      now,
    });
    // A LAN route that opens while the runtime is on the relay: closing the relay channel makes the runtime reconnect,
    // and its connect takes the LAN one. Its brief disconnect is a switch, not an outage.
    entry.supervisor.subscribe((route) => {
      if (route.kind !== "lan" || entry.route !== "relay" || !entry.client || route.transport.used) return;
      entry.switching = true;
      entry.client.close();
    });
    entries.set(id, entry);
    return entry;
  }

  function adopt(entry, client, route) {
    entry.client = client;
    entry.route = route;
    client.once("close", () => {
      if (entry.client === client) entry.client = null;
    });
    return client;
  }

  /** The runtime's `connect`: the LAN channel the supervisor holds, when it has one, else a new relay channel. */
  async function connectRoute(entry) {
    if (entry.stopped || entry.refused) throw new Error("This computer is no longer connected.");
    await entry.supervisor.check().catch(() => {});
    const route = entry.supervisor.current();
    if (route.kind === "lan" && !route.transport.used && !route.transport.client.closed) {
      route.transport.used = true;
      return adopt(entry, route.transport.client, "lan");
    }
    const computer = store.get(entry.id);
    if (!computer) throw new Error("This computer was removed.");
    try {
      return adopt(entry, await dial(entry, computer.relay), "relay");
    } catch (error) {
      if (error instanceof PeerError && error.final) refuse(entry, error);
      else entry.lastError = error;
      throw error;
    }
  }

  function online(entry) {
    clearTimeout(entry.offlineTimer);
    entry.state = "online";
    entry.message = null;
    entry.lastError = null;
    entry.switching = false;
    void store.seen(entry.id).catch(() => {});
    void learnRoutes(entry);
    changed();
  }

  function down(entry, error) {
    if (entry.switching) return;
    const computer = store.get(entry.id);
    entry.message = error instanceof PeerError && SHOWN.has(error.code) && computer ? computerProblem(error.code, { name: computer.name }) : null;
    if (entry.state !== "reconnecting" && entry.state !== "offline") {
      entry.state = "reconnecting";
      clearTimeout(entry.offlineTimer);
      entry.offlineTimer = setTimeout(() => {
        if (entry.state !== "reconnecting") return;
        entry.state = "offline";
        changed();
      }, offlineAfterMs);
    }
    changed();
  }

  /** Retrying can't fix it: stop the runtime and keep the reason on screen until the computer is paired again. */
  function refuse(entry, error) {
    if (entry.refused) return;
    const computer = store.get(entry.id);
    entry.refused = true;
    entry.state = "refused";
    entry.message = computerProblem(error.code, { name: computer?.name ?? "That computer" });
    clearTimeout(entry.offlineTimer);
    clearTimeout(entry.retryTimer);
    const runtime = entry.runtime;
    entry.runtime = null;
    void runtime?.close().catch(() => {});
    entry.supervisor.close();
    changed();
  }

  /** Asks the computer where else to reach it (peer:routes) and keeps the answer if it names the pinned Mac. */
  async function learnRoutes(entry) {
    const runtime = entry.runtime;
    const computer = store.get(entry.id);
    if (!runtime || !computer || !entry.secrets) return;
    let answer;
    try {
      answer = await runtime.invoke("peer:routes");
    } catch {
      return;
    }
    const routes = lanRoutesFrom(answer, { hostId: computer.hostId, hostKey: entry.secrets.hostKey });
    if (!routes || entry.stopped) return;
    await store.setLanRoutes(entry.id, routes).catch(() => {});
    changed();
    void entry.supervisor.check().catch(() => {});
  }

  function runtimeEvent(entry, channel, payload) {
    if (entry.stopped || entry.refused) return;
    if (channel === "runtime:connection") {
      if (payload?.connected) online(entry);
      else down(entry, entry.lastError);
      return;
    }
    try {
      emit(entry.id, channel, payload);
    } catch {
      /* a listener must not break the runtime */
    }
  }

  /** Starts a computer's runtime. `first`: the channel that just paired, used as its first connection. */
  function start(entry, first = null) {
    if (!enabled || closed || entry.stopped || entry.refused || entry.runtime || entry.starting) {
      first?.close();
      return entry.starting;
    }
    clearTimeout(entry.retryTimer);
    let handed = first;
    entry.starting = (async () => {
      try {
        entry.secrets ??= await keys.secretsOf(entry.id);
        const runtime = await connectDesktopRuntime({
          dataDir,
          reconnectMs,
          connect: () => {
            if (!handed) return connectRoute(entry);
            const client = handed;
            handed = null;
            return Promise.resolve(adopt(entry, client, "relay"));
          },
          emit: (channel, payload) => runtimeEvent(entry, channel, payload),
        });
        if (!enabled || closed || entry.stopped || entry.refused) {
          await runtime.close().catch(() => {});
          return;
        }
        entry.runtime = runtime;
        entry.attempts = 0;
        online(entry);
      } catch (error) {
        handed?.close();
        if (!enabled || closed || entry.stopped || entry.refused) return;
        down(entry, error);
        const wait = backoffMs[Math.min(entry.attempts++, backoffMs.length - 1)];
        entry.retryTimer = setTimeout(() => void start(entry), wait);
      } finally {
        entry.starting = null;
      }
    })();
    return entry.starting;
  }

  async function stop(entry) {
    entry.stopped = true;
    entry.abort.abort();
    clearTimeout(entry.retryTimer);
    clearTimeout(entry.offlineTimer);
    const runtime = entry.runtime;
    entry.runtime = null;
    await entry.starting?.catch(() => {});
    await runtime?.close().catch(() => {});
    entry.supervisor.close();
    entry.client?.close();
  }

  function checkRoutes() {
    for (const entry of entries.values()) if (!entry.stopped && !entry.refused) void entry.supervisor.check().catch(() => {});
  }
  function watch() {
    let network = networkSignature();
    checkTimer = setInterval(checkRoutes, checkEveryMs);
    networkTimer = setInterval(() => {
      const next = networkSignature();
      if (next === network) return;
      network = next;
      checkRoutes();
    }, networkMs);
    checkTimer.unref?.();
    networkTimer.unref?.();
  }
  function unwatch() {
    clearInterval(checkTimer);
    clearInterval(networkTimer);
    checkTimer = null;
    networkTimer = null;
  }

  /** The pasted link, checked: a relay link, not this Mac's, not a computer already here (one refused may pair again). */
  async function read(link) {
    let pairing;
    try {
      pairing = parsePairing(String(link ?? ""), { allowLocalRelay });
    } catch {
      throw new Error(NOT_A_LINK);
    }
    const relay = pairing.relay;
    if (!relay) throw new Error(TUNNEL_LINK);
    let own = null;
    try {
      own = await ownHostId();
    } catch {
      /* unknown: no check */
    }
    if (relay.hostId === own) throw new Error("That's this Mac's own link. Copy the one on the other Mac.");
    const existing = store.list().find((computer) => computer.hostId === relay.hostId);
    if (existing && !entries.get(existing.id)?.refused) throw new Error(`${existing.name} is already in your computers.`);
    return { pairing, relay, replaces: existing?.id ?? null };
  }

  async function removeComputer(id) {
    const entry = entries.get(id);
    entries.delete(id);
    if (entry) await stop(entry);
    await store.remove(id);
    await keys.forget(id).catch(() => {});
  }

  return {
    list,
    async preview(link) {
      await ready;
      const { pairing, relay } = await read(link);
      return { name: pairing.name, hostId: relay.hostId, relayHost: hostOf(relay.url) };
    },
    /**
     * Pairs with the computer the link names and saves it as `name` ("Show it as"). Waits through its owner's Allow
     * (`onPending` runs when the Mac says it is asking). Rejects with the words to show; `cancelAdd()` stops it.
     */
    async add(link, { name: label } = {}, { onPending } = {}) {
      await ready;
      if (closed) throw new Error("Milagre is quitting.");
      if (adding) throw new Error("Another computer is being added.");
      const abort = new AbortController();
      adding = abort;
      try {
        const { pairing, relay, replaces } = await read(link);
        const shown = helloName(label) ?? helloName(pairing.name) ?? "Computer";
        let client;
        try {
          client = await connectPeer({
            url: relay.url,
            hostId: relay.hostId,
            hostKey: relay.key,
            token: pairing.token,
            identity: await keys.identity(),
            name: name(),
            random,
            onPending,
            signal: abort.signal,
            ...socketOption,
          });
        } catch (error) {
          const code = error instanceof PeerError ? error.code : "lost";
          const words = code === "cancelled" ? "Cancelled." : error instanceof PeerError ? computerProblem(code, { name: pairing.name, pairing: true }) : error.message;
          throw Object.assign(new Error(words), { code });
        }
        if (replaces) await removeComputer(replaces);
        const id = randomUUID();
        try {
          await keys.save(id, { hostKey: relay.key, token: pairing.token });
          await store.add({ id, hostId: relay.hostId, name: shown, relay: relay.url });
        } catch (error) {
          client.close();
          await keys.forget(id).catch(() => {});
          throw error;
        }
        if (enabled) {
          const entry = entryFor(id);
          entry.secrets = { hostKey: relay.key, token: pairing.token };
          void start(entry, client);
        } else client.close();
        changed();
        return view(store.get(id));
      } finally {
        if (adding === abort) adding = null;
      }
    },
    cancelAdd() {
      adding?.abort();
    },
    async rename(id, label) {
      await ready;
      await store.rename(id, label);
      changed();
      return list();
    },
    async remove(id) {
      await ready;
      await removeComputer(id);
      changed();
      return list();
    },
    /** One daemon call on a computer, through its runtime. */
    async invoke(id, method, args = []) {
      const entry = entries.get(id);
      if (!entry?.runtime) throw new Error(`${store.get(id)?.name ?? "That computer"} is offline.`);
      return entry.runtime.invoke(method, args);
    },
    async setEnabled(on) {
      await ready;
      if (closed || enabled === (on === true)) return;
      enabled = on === true;
      if (enabled) {
        for (const computer of store.list()) void start(entryFor(computer.id));
        watch();
      } else {
        unwatch();
        adding?.abort();
        const stopping = [...entries.values()];
        entries.clear();
        await Promise.all(stopping.map(stop));
      }
      changed();
    },
    async close() {
      if (closed) return;
      closed = true;
      adding?.abort();
      unwatch();
      const stopping = [...entries.values()];
      entries.clear();
      await Promise.all(stopping.map(stop));
    },
  };
}

module.exports = { createComputers, OFFLINE_AFTER_MS };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test apps/desktop/electron/computers.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx oxfmt apps/desktop/electron/computers.cjs apps/desktop/electron/computers.test.cjs
git add apps/desktop/electron/computers.cjs apps/desktop/electron/computers.test.cjs
git commit -m "feat(desktop): computers.cjs pairs, routes and runs each paired computer"
```

---

### Task 10: End to end: a real Mac, a local relay, the LAN and `computers.cjs`

**Files:**
- Create: `apps/desktop/electron/computers-e2e.test.cjs`

**Interfaces:**
- Consumes: `startTestMac`, `until` (Task 3's test kit, `apps/daemon/src/relay-test-kit.cjs`); `createComputers` (Task 9). Node's global `WebSocket` and `fetch`.
- Produces: nothing new; this pins the whole path.

- [ ] **Step 1: Write the end-to-end tests**

Create `apps/desktop/electron/computers-e2e.test.cjs`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { startTestMac, until } = require("../../daemon/src/relay-test-kit.cjs");
const { createComputers } = require("./computers.cjs");

const keychain = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text, "utf8").map((byte) => byte ^ 0x5a),
  decryptString: (bytes) => Buffer.from(bytes).map((byte) => byte ^ 0x5a).toString("utf8"),
};

/**
 * This Mac's side: computers.cjs in a folder of its own (never Victor's userData), turned on, dialing with Node's
 * WebSocket. Registered after the Mac's own hooks, so it closes after the daemon (node:test runs t.after in order).
 */
async function desk(t, options = {}) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "computers-e2e-")));
  const sockets = [];
  const events = [];
  const computers = createComputers({
    dataDir,
    safeStorage: keychain,
    name: () => "desk",
    allowLocalRelay: true,
    reconnectMs: 50,
    networkMs: 60_000,
    createSocket: (url) => {
      sockets.push(url);
      return new WebSocket(url);
    },
    emit: (id, channel, payload) => events.push({ id, channel, payload }),
    ...options,
  });
  t.after(async () => {
    await computers.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await computers.setEnabled(true);
  return { computers, sockets, events, dataDir };
}
const linkOf = async (mac) => (await mac.client.call("phone:status")).pairingLink;
/** Every request list this Mac's window heard (devices:pending), newest last. */
function pendingHeard(mac) {
  const heard = [];
  mac.client.on("event", ({ channel, payload }) => {
    if (channel === "devices:pending") heard.push(payload.requests);
  });
  return heard;
}
const first = (computers) => computers.list()[0];

test("a new computer waits for Allow, then drives the Mac over the relay and moves to its LAN", async (t) => {
  const mac = await startTestMac(t, { autoAllow: false });
  const heard = pendingHeard(mac);
  const { computers, events, dataDir } = await desk(t);
  const link = await linkOf(mac);
  assert.deepEqual(Object.keys(await computers.preview(link)).toSorted(), ["hostId", "name", "relayHost"]);
  let told = 0;
  const adding = computers.add(link, { name: "studio" }, { onPending: () => told++ });
  const [request] = await until(() => heard.at(-1)?.length && heard.at(-1), "the Mac's window to hear the request");
  assert.equal(request.name, "desk");
  await until(() => told === 1, "this Mac to hear it waits");
  assert.deepEqual(await mac.client.call("devices:list"), [], "nothing saved before Allow");
  await mac.client.call("devices:allow", [request.key]);
  const added = await adding;
  assert.equal(added.name, "studio");
  await until(() => first(computers)?.state === "online", "online");
  assert.equal((await computers.invoke(added.id, "daemon:status")).version, "9.8.7");

  // peer:routes taught it the Mac's LAN address; the supervisor moves the runtime there.
  await until(() => first(computers).route === "lan", "the LAN route");
  assert.equal(first(computers).lan, true);
  assert.equal((await computers.invoke(added.id, "daemon:status")).version, "9.8.7");
  await until(async () => (await mac.client.call("devices:list"))[0]?.route === "lan", "the Mac to see it on the LAN");

  // A change made on the Mac reaches this desktop's runtime as an event.
  const opened = await mac.client.call("project:open", [mac.project]);
  const chatId = Object.values(opened.state.sessions)[0].id;
  await mac.client.call("chat:patch", [mac.project, chatId, { title: "Set on the Mac" }]);
  await until(
    () => events.some((event) => event.id === added.id && event.channel === "project:state" && event.payload?.path === mac.project),
    "the state event",
  );

  // The token and the Mac's key are sealed in computer-keys.json; computers.json has neither.
  const saved = await fs.readFile(path.join(dataDir, "computers.json"), "utf8");
  assert.deepEqual(
    JSON.parse(saved).map((computer) => [computer.name, computer.hostId]),
    [["studio", mac.identity.hostId]],
  );
  for (const file of ["computers.json", "computer-keys.json"]) assert.equal((await fs.readFile(path.join(dataDir, file), "utf8")).includes(mac.token), false, file);
});

test("Deny, and a link whose window closed, turn the computer away and save nothing on either Mac", async (t) => {
  const mac = await startTestMac(t, { autoAllow: false });
  const heard = pendingHeard(mac);
  const { computers } = await desk(t);
  const link = await linkOf(mac);
  const { name } = await computers.preview(link);
  const adding = computers.add(link, { name: "studio" });
  const [request] = await until(() => heard.at(-1)?.length && heard.at(-1), "the request");
  await mac.client.call("devices:deny", [request.key]);
  await assert.rejects(adding, { message: `${name} didn't allow this Mac.` });
  assert.deepEqual(computers.list(), []);
  assert.deepEqual(await mac.client.call("devices:list"), []);
  mac.clock.now += 11 * 60_000;
  await assert.rejects(computers.add(link, { name: "studio" }), { message: `This link expired. Copy a new one on ${name}.` });
  assert.deepEqual(computers.list(), []);
});

test("a computer removed on the Mac it drives stops dialing and says so", async (t) => {
  const mac = await startTestMac(t, { lan: false });
  const { computers, sockets } = await desk(t);
  const added = await computers.add(await linkOf(mac), { name: "studio" });
  await until(() => first(computers)?.state === "online", "online");
  const [device] = await mac.client.call("devices:list");
  await mac.client.call("devices:remove", [device.key]);
  await until(() => first(computers)?.state === "refused", "refused");
  assert.equal(first(computers).message, "Removed on studio. Pair again with a new link.");
  const dialed = sockets.length;
  await delay(500);
  assert.equal(sockets.length, dialed, "no more hellos");
  await assert.rejects(computers.invoke(added.id, "daemon:status"), /studio is offline/);
});

test("a computer whose relay drops reads Reconnecting, comes back by itself and reads the Mac's state again", async (t) => {
  const mac = await startTestMac(t, { lan: false });
  const states = [];
  const { computers, events } = await desk(t, { onChange: (list) => states.push(list[0]?.state) });
  await computers.add(await linkOf(mac), { name: "studio" });
  await until(() => first(computers)?.state === "online", "online");
  mac.relay.hostSockets.at(-1).terminate();
  await until(() => states.includes("reconnecting"), "reconnecting");
  await until(
    () => first(computers).state === "online" && events.some((event) => event.channel === "runtime:snapshot"),
    "back online with a fresh snapshot",
    10_000,
  );
  assert.equal(first(computers).route, "relay");
});
```

- [ ] **Step 2: Run them**

Run: `node --test apps/desktop/electron/computers-e2e.test.cjs`
Expected: PASS (four tests). If one fails, debug the module it points at (Tasks 1-9) before changing the test; the tests are the spec's behavior.

- [ ] **Step 3: Run the desktop and daemon unit tests together**

Run: `npm test -- --unit --workspace desktop && npm test -- --unit --workspace daemon`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
npx oxfmt apps/desktop/electron/computers-e2e.test.cjs
git add apps/desktop/electron/computers-e2e.test.cjs
git commit -m "test(desktop): a computer pairs with Allow and runs over the relay and the LAN, end to end"
```

---

### Task 11: Checks before the PR

**Files:** none new.

- [ ] **Step 1: The repo's checks**

Run: `npm run typecheck && npm run lint && npm test -- --unit`
Expected: PASS for all three.

- [ ] **Step 2: The Electron checks for what changed**

Run: `npm test -- --only test-allow-computer && npm test -- --only test-settings-devices && npm test -- --only test-experimental-settings`
Expected: PASS for each (Settings › Devices reads the same payloads as before; the prompt is new).

- [ ] **Step 3: The phone**

Run: `npm run typecheck --workspace @milagre/mobile && npm run lint --workspace @milagre/mobile && npm test -- --unit --workspace mobile`
Expected: PASS. Then compare the fingerprint with the latest TestFlight build, as `apps/mobile/AGENTS.md` says:

```bash
cd apps/mobile
npx expo-updates fingerprint:generate --platform ios | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).hash))'
npx eas-cli@latest build:list --platform ios --status finished --limit 1 --json --non-interactive | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].runtimeVersion))'
cd ../..
```

Expected: the two values match. If they don't, stop and report; do not merge.

- [ ] **Step 4: Screenshots of the prompt**

Run: `MILAGRE_SCREENSHOT_DIR="$TMPDIR/computers-allow" npm test -- --only test-allow-computer`
Expected: PASS, with `allow-prompt.png` and `allow-two-waiting.png` in `$TMPDIR/computers-allow`.

Put them on the orphan `screenshots` branch from a temporary worktree (never in this branch):

```bash
git fetch origin screenshots
git worktree add "$TMPDIR/milagre-screenshots" origin/screenshots
mkdir -p "$TMPDIR/milagre-screenshots/computers-allow"
cp "$TMPDIR/computers-allow/"*.png "$TMPDIR/milagre-screenshots/computers-allow/"
git -C "$TMPDIR/milagre-screenshots" add computers-allow
git -C "$TMPDIR/milagre-screenshots" commit -m "screenshots: computers Allow prompt"
git -C "$TMPDIR/milagre-screenshots" push origin HEAD:screenshots
git -C "$TMPDIR/milagre-screenshots" rev-parse HEAD
git worktree remove "$TMPDIR/milagre-screenshots"
```

Link each image in the PR body as `https://raw.githubusercontent.com/the-ptf/milagre-ade/<that sha>/computers-allow/<name>.png`.

- [ ] **Step 5: The PR body says what ships where**

The PR body (no Claude or Anthropic footer) states: the Allow prompt is the only visible change; computers.cjs is not wired into the app until PR 3b; the phone's code moved to `@milagre/shared` with no behavior change and an unchanged fingerprint, so after merge an OTA ships it from `main` with `npm run update:testflight -- --message "Pairing link and route supervisor read from @milagre/shared (no change)"`; and the manual check: on two Macs (or two user accounts), pair with the test kit's raw desktop or wait for 3b.

---

## PR 3b (follow-up plan; tasks only)

Written after 3a merges, against its merged code.

1. **Main wiring and IPC.** `main.cjs` creates `createComputers({ dataDir: userData, safeStorage, ownHostId: from the local host's phone:status link, onChange: send "computers:changed" to windows })`, closes it in `prepareQuit`, and handles `computers:list`, `computers:preview`, `computers:add` (sends `computers:pending` to the asking window for `onPending`), `computers:cancel-add`, `computers:rename`, `computers:remove`, `computers:projects` (`invoke(id, "project:recent")`), `settings:other-computers` (`setEnabled`). Preload and `electron.d.ts` get `window.milagre.computers.*` and `onComputersChanged`. `npm run typecheck` now checks `computers.cjs` and its modules for the first time (`tsconfig.electron.json` includes `main.cjs`); add JSDoc where it asks. Settings › Experimental gains the "Other computers" switch (`settings.ts` `otherComputers`, default false), pushed to main on change and at launch. Check: `test-experimental-settings.cjs` extended.
2. **The footer popover** (`sidebar-c-sections` v6). `components/sidebar/ComputersButton.tsx`, a laptop button beside Add project and Link projects, shown with "Other computers" on; its popover (portal, `useDismiss` with `follow`, `GlideMenu`, `ScrollArea` per `docs/agents/ui.md`) lists This Mac first, then each computer with its status dot (green online, amber reconnecting, grey offline, red refused), its route on a second line ("This Mac", "Same network", `relay.milagre.cloud`, "Reconnecting…", "Offline, seen 2h ago", or the refusal), a gear on hover with the tooltip "<name> settings: rename, connection, remove" (This Mac's gear opens Settings › Devices), and Add computer. `lib/computers.ts` holds the line and dot logic, unit-tested. Check: `scripts/test-sidebar-computers.cjs` against a fake `window.milagre.computers` (no real runtime), with screenshots.
3. **Add computer** (`add-computer` v1). `components/AddComputerDialog.tsx`: paste the link (Paste reads the clipboard), the steps on the other Mac (Settings › Devices › Pair a device › Copy link), the computer it found and how it is reached (from `preview`), "Show it as" prefilled with its name, the full-control note, Cancel / Add computer; while the other Mac decides, "Waiting for studio to allow this Mac…" with Cancel (`cancelAdd`); every refusal in its words. Check: `scripts/test-add-computer.cjs` (paste, found computer, waiting, each error), screenshots.
4. **Computer settings** (`computer-settings` v1). A Settings section per computer (`SettingsSection` gains `"computer"` with the computer's id): Name (a local label only, renames on blur), Connection (Same network and Relay, each "In use" or "Ready", from `route` and `lan`), what lives there (its Projects from `computers:projects`, or "studio is offline" with its last-seen time), and Remove with "Its chats leave this sidebar and this Mac forgets its keys. Nothing changes on atlas; pair again with a new link." Check: the popover check opens it from the gear, renames and removes, with screenshots.
5. **Checks and screenshots.** Typecheck, lint, unit tests, the three new checks plus `test-settings-devices`, `test-experimental-settings` and `test-sidebar-all-projects`; screenshots on the `screenshots` branch; no phone change (no OTA).

## Self-Review

- **Spec coverage.** "Allowing a new computer": held hello and pending record (Tasks 1-2), `devices:pending` to the window only (Task 3, end to end in Task 3's e2e), the prompt with Allow / Deny (Task 4), Deny with `reason: "denied"` saving nothing (Tasks 1, 3, 10), dropped on the window's end or a closed channel (Tasks 2, 3), known computers reconnect without asking (Task 1), the desktop told it waits (`onPending`, Tasks 6, 10; its words are 3b's). "Computers": `computers.json` and `safeStorage` (Task 7), one transport and runtime per computer with LAN first and the 60 s and network checks (Tasks 8-9), pairing from a relay link with `kind: "desktop"` and the Mac's name, saved after `hostAccept` (Tasks 6, 9, 10). The transport move (Task 5, with the argued exception). "Errors": every line (Task 6's copy, Tasks 6 and 10 for the codes), the 30 s offline (Task 9's `down`, Task 10's reconnect). Footer popover, Add computer, Computer settings: PR 3b. Routing, the second line, the offline cache: PR 4; remote folder picker, `media:read`: PR 5.
- **Placeholder scan.** No step leaves code out; PR 3b is a task list by design, to be planned against 3a's merged code.
- **Type consistency.** `allowComputer({ key, name, signal, waiting })` and its verdict strings match across Tasks 1-4 and the test kit; `connectPeer`'s options and `PeerError` codes match Tasks 6, 9, 10 and `computer-errors.cjs`; `ComputerView` fields match Task 9's tests and Task 10; `connectDesktopRuntime`'s `connect` matches Tasks 8-9; `lanRoutesFrom(answer, { hostId, hostKey })` matches Tasks 7 and 9.
- **Review Focus.** Each line has its test in the owning task: the held hello outliving `helloMs` (Task 1), a late Allow (Tasks 2 and 3), removal while connected (Task 10), the pre-PR 1 Mac (Task 6), an already-added or own link (Task 9).
