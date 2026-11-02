// Real Electron media stream/worklet and React hook, with a synthetic microphone and deterministic STT responses.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useDictation } from '/src/components/useDictation';
import { updateSettings } from '/src/lib/settings';
window.calls = []; window.delivered = []; window.corrections = []; window.polishRequests = []; window.hold = false;
window.requests = []; window.setDictationLanguage = language => updateSettings({dictationLanguage:language}); window.updateSettings = updateSettings;
window.holdMic = false; window.pendingStreams = []; window.draft = 'original draft';
window.modelMissing = false; window.downloads = []; window.cancelled = [];
const context = new AudioContext({sampleRate:48000,sinkId:{type:'none'}});
const oscillator = context.createOscillator();
const gain = context.createGain();
gain.gain.value = 0.2;
oscillator.connect(gain); oscillator.start();
async function syntheticStream() {
  const destination = context.createMediaStreamDestination();
  gain.connect(destination);
  await context.resume();
  window.pendingStreams.push(destination.stream);
  return destination.stream;
}
function resolveSyntheticStream(resolve) {
  const destination = context.createMediaStreamDestination();
  gain.connect(destination);
  window.pendingStreams.push(destination.stream);
  void context.resume();
  resolve(destination.stream);
}
navigator.mediaDevices.getUserMedia = async () => {
  if (window.holdMic) return new Promise(resolve => {
    window.resolveMic = () => resolveSyntheticStream(resolve);
  });
  return syntheticStream();
};
window.milagre = {
  // A slow/offline computer must not hold up local recognition.
  dictationContext: () => new Promise(() => {}),
  // The Mac's fix-up of the finished words, as Claude Haiku answers it.
  polishDictation: async (request) => { window.polishRequests.push(request); return {text: request.text.replace('Corrija', 'Corrige'), polished: true}; },
  dictation: {
    status: async () => [{id:'large-v3-turbo', ready: !window.modelMissing, size: 574041195, received: null}],
    download: (id) => new Promise((resolve, reject) => {
      window.downloads.push(id);
      window.finishDownload = () => { window.modelMissing = false; resolve(); };
      window.failDownload = reject;
    }),
    cancel: async (id) => { window.cancelled.push(id); window.failDownload?.(Object.assign(new Error('aborted'), {name:'AbortError'})); },
    onModel: () => () => {},
    prepare: async (id) => { window.warmed = id; },
    transcribe: async ({audio, language, prompt}) => {
      window.calls.push(audio.byteLength);
      window.requests.push({language,prompt});
      if (window.hold) await new Promise(resolve => { window.releaseInference = resolve; });
      return {text:'Corrija o Milagre.'};
    },
  },
};
function Fixture() {
  const [scope,setScope] = useState('first');
  const dictation = useDictation('/fixture', scope, (text, _anchor, correction) => { window.delivered.push(text); window.draft += text; if (correction) void correction.text.then(fixed => window.corrections.push(fixed)); }, {scope: '/fixture', chatId: 7});
  useEffect(() => { window.dictation = dictation; window.changeScope = setScope; });
  return <div>
    <p id="phase">{dictation.phase}</p><p id="partial">{dictation.partial.text}</p><p id="settled">{dictation.partial.settled}</p><p id="error">{dictation.error?.message}</p>
    {dictation.phase === 'preparing' && <><p role="status">Preparing the microphone\u2026</p><button aria-label="Discard dictation" onClick={dictation.cancel}>Discard dictation</button></>}
  </div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;

async function checks() {
  const { app, BrowserWindow, session } = require("electron");
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-dictation-")));
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(true));
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (expression) => window.webContents.executeJavaScript(expression, true);
  const errors = [];
  const production = process.argv[3] === "--production";
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  const until = async (expression) => {
    for (let tries = 0; tries < 400; tries++) {
      if (await evaluate(expression)) return;
      await delay(25);
    }
    throw new Error(
      `Timed out: ${expression}. ${JSON.stringify(await evaluate("({phase:window.dictation?.phase,error:window.dictation?.error,calls:window.calls,warmed:window.warmed,focused:document.hasFocus(),holdMic:window.holdMic,resolver:typeof window.resolveMic,pendingStreams:window.pendingStreams?.length})"))}`,
    );
  };
  try {
    await window.loadURL(process.argv[2]);
    await until("!!window.dictation");
    await evaluate("window.setDictationLanguage('auto')");
    await delay(50);
    if (production) {
      const csp = await evaluate("document.querySelector('meta[http-equiv=\\\"Content-Security-Policy\\\"]')?.content");
      assert.match(csp, /script-src 'self'/, "production fixture uses the repository renderer CSP");
      assert.doesNotMatch(csp.split("script-src ")[1]?.split(";")[0] ?? "", /data:/, "renderer CSP does not allow data scripts");
    }
    await evaluate("void window.dictation.start({selection:{start:0,end:0}})");
    await until("window.dictation.partial.text === 'Corrija o Milagre.'");
    assert.equal(await evaluate("window.dictation.partial.settled"), 0, "an open segment is provisional: nothing has settled");
    assert.equal(await evaluate("window.dictation.phase"), "recording");
    assert.equal(await evaluate("window.warmed"), "large-v3-turbo", "the picked model is the one loaded");
    assert.equal(await evaluate("window.requests[0].language"), "auto", "automatic preference reaches Whisper as auto detection");
    assert.match(await evaluate("window.requests[0].prompt"), /switch languages/, "multilingual hint reaches the recognizer");
    assert.equal(await evaluate("window.delivered.length"), 0, "partials never submit or edit the draft");
    await evaluate("void window.dictation.stop()");
    await until("window.delivered.length === 1");
    await until("window.dictation.partial.text === '' && window.dictation.phase === 'idle'");
    assert.deepEqual(await evaluate("({...window.dictation.partial})"), { text: "", settled: 0 });
    assert.equal(await evaluate("window.dictation.phase"), "idle");
    assert.equal(await evaluate("window.delivered[0]"), "Corrija o Milagre.", "the words land before the fix-up answers");
    await until("window.corrections.length === 1");
    assert.equal(await evaluate("window.corrections[0]"), "Corrige o Milagre.", "the fix-up's correction follows the delivery");
    assert.deepEqual(await evaluate("window.polishRequests[0]"), {
      cwd: "/fixture",
      text: "Corrija o Milagre.",
      provider: undefined,
      model: "auto",
      scope: "/fixture",
      chatId: 7,
    });
    await evaluate(
      "window.holdMic = true; window.resolveMic = null; window.draftBeforePending = window.draft; window.callsBeforePending = window.calls.length; window.streamCountBeforePending = window.pendingStreams.length; void window.dictation.start({selection:{start:0,end:0}})",
    );
    await until("window.dictation.phase === 'preparing' && !!document.querySelector('[aria-label=\\\"Discard dictation\\\"]')");
    assert.equal(await evaluate("document.querySelector('[role=status]')?.textContent"), "Preparing the microphone\u2026");
    await evaluate("document.querySelector('[aria-label=\\\"Discard dictation\\\"]').click()");
    await until("window.dictation.phase === 'idle'");
    await evaluate("window.resolveMic()");
    await until("window.pendingStreams.length === window.streamCountBeforePending + 1");
    assert.equal(
      await evaluate("window.pendingStreams[window.streamCountBeforePending].getTracks().every(track => track.readyState === 'ended')"),
      true,
      "cancelled pending microphone tracks stop when permission resolves",
    );
    assert.equal(await evaluate("window.draft"), await evaluate("window.draftBeforePending"), "late microphone resolution does not change the draft");
    assert.equal(await evaluate("window.delivered.length"), 1, "cancelled pending microphone delivers no transcript");
    assert.equal(await evaluate("window.calls.length"), await evaluate("window.callsBeforePending"), "cancelled pending microphone starts no transcription");
    await evaluate(
      "window.resolveMic = null; window.draftBeforePending = window.draft; window.callsBeforePending = window.calls.length; window.streamCountBeforePending = window.pendingStreams.length; void window.dictation.start({selection:{start:0,end:0}})",
    );
    await until("window.dictation.phase === 'preparing' && !!window.resolveMic");
    assert.equal(
      await evaluate(
        "(() => { const event = new KeyboardEvent('keydown', {key:'Escape',cancelable:true}); window.escapePrevented = !window.dispatchEvent(event); return event.defaultPrevented; })()",
      ),
      true,
      "Escape prevents its default action while cancelling pending capture",
    );
    await until("window.dictation.phase === 'idle'");
    await evaluate("window.resolveMic()");
    await until("window.pendingStreams.length === window.streamCountBeforePending + 1");
    assert.equal(
      await evaluate("window.pendingStreams[window.streamCountBeforePending].getTracks().every(track => track.readyState === 'ended')"),
      true,
      "Escape cancellation stops tracks after microphone resolution",
    );
    assert.equal(await evaluate("window.draft"), await evaluate("window.draftBeforePending"));
    assert.equal(await evaluate("window.delivered.length"), 1, "Escape cancellation delivers no transcript");
    assert.equal(await evaluate("window.calls.length"), await evaluate("window.callsBeforePending"), "Escape cancellation starts no transcription");
    await evaluate("window.holdMic = false; window.hold = true; window.releaseInference = null; void window.dictation.start({selection:{start:0,end:0}})");
    await until("!!window.releaseInference");
    await evaluate("window.changeScope('second')");
    await until("window.dictation.phase === 'idle'");
    await evaluate("window.releaseInference()");
    await delay(100);
    assert.equal(await evaluate("window.delivered.length"), 1, "leaving the Chat discards late recognition");
    assert.equal(await evaluate("window.dictation.partial.text"), "");

    // A missing model downloads before the microphone opens; Escape cancels the download, and a finished one starts the take.
    await evaluate(
      "window.hold = false; window.modelMissing = true; window.streamCountBeforeDownload = window.pendingStreams.length; void window.dictation.start({selection:{start:0,end:0}})",
    );
    await until("window.dictation.phase === 'downloading' && window.downloads.length === 1");
    assert.deepEqual(await evaluate("window.dictation.download"), { received: 0, total: 574041195 }, "the take reports its model download");
    assert.equal(
      await evaluate("window.pendingStreams.length"),
      await evaluate("window.streamCountBeforeDownload"),
      "nothing records while the model downloads",
    );
    await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',cancelable:true}))");
    await until("window.dictation.phase === 'idle'");
    assert.deepEqual(await evaluate("window.cancelled"), ["large-v3-turbo"], "cancelling the take cancels its download");
    assert.equal(await evaluate("window.dictation.error"), null, "a cancelled download is not an error");
    const deliveredBefore = await evaluate("window.delivered.length");
    await evaluate("void window.dictation.start({selection:{start:0,end:0}})");
    await until("window.dictation.phase === 'downloading' && window.downloads.length === 2");
    await evaluate("window.finishDownload()");
    await until("window.dictation.phase === 'recording' && window.dictation.partial.text === 'Corrija o Milagre.'");
    await evaluate("void window.dictation.stop()");
    await until(`window.delivered.length === ${deliveredBefore + 1}`);
    await until("window.dictation.phase === 'idle'");
    await evaluate(
      "window.baselinePolish = window.polishRequests.length; window.baselineCorrections = window.corrections.length; window.baselineDelivered = window.delivered.length",
    );
    // The selected model travels with the take, and disabling correction skips the Mac entirely.
    await evaluate("window.updateSettings({dictationFixModel:'codex'});");
    await delay(50);
    await evaluate("void window.dictation.start({selection:{start:0,end:0}})");
    await until("window.dictation.phase === 'recording'");
    await delay(120);
    await evaluate("void window.dictation.stop()");
    await until("window.polishRequests.length === baselinePolish + 1 && window.corrections.length === baselineCorrections + 1");
    assert.equal(await evaluate("window.polishRequests.at(-1).model"), "codex");
    await evaluate("window.updateSettings({dictationFixUp:false})");
    await delay(50);
    await evaluate("void window.dictation.start({selection:{start:0,end:0}})");
    await until("window.dictation.phase === 'recording'");
    await delay(120);
    await evaluate("void window.dictation.stop()");
    await until("window.delivered.length === baselineDelivered + 2");
    assert.equal(await evaluate("window.polishRequests.length"), await evaluate("baselinePolish + 1"), "correction off makes no model request");
    await evaluate("window.updateSettings({dictationFixUp:true,dictationFixModel:'auto'})");
    await delay(50);
    assert.deepEqual(errors, []);
    console.log(
      `PASS: ${production ? "production file fixture under renderer CSP" : "dev-server fixture"}, synthetic PCM, real audio worklet, live preview, final delivery, pending-start cancellation, download before recording`,
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    app.exit(1);
  }
}

async function main() {
  const { createServer, build } = await import("vite");
  const repoRoot = path.resolve(__dirname, "..");
  const configFile = path.join(repoRoot, "apps/desktop/vite.config.ts");
  const server = await createServer({
    configFile,
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "dictation-fixture",
        resolveId: (id) => (id === "/__dictation.tsx" ? id : undefined),
        load: (id) => (id === "/__dictation.tsx" ? fixture : undefined),
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__dictation") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__dictation.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
  });
  let fixtureDir;
  try {
    await server.listen();
    await runElectron(`${server.resolvedUrls.local[0]}__dictation`);

    fixtureDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "milagre-dictation-production-")));
    fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(fixtureDir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const useDictationPath = path.join(repoRoot, "apps/desktop/app/src/components/useDictation.ts");
    const useDictationImport = JSON.stringify(useDictationPath.split(path.sep).join("/"));
    const productionFixture = fixture
      .replace("'/src/components/useDictation'", useDictationImport)
      .replace("'/src/lib/settings'", JSON.stringify(path.join(repoRoot, "apps/desktop/app/src/lib/settings.ts").split(path.sep).join("/")));
    fs.writeFileSync(path.join(fixtureDir, "fixture.tsx"), productionFixture);
    fs.writeFileSync(
      path.join(fixtureDir, "index.html"),
      '<!doctype html><html><head><meta charset="UTF-8"><title>Dictation fixture</title></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>',
    );
    const distDir = path.join(fixtureDir, "dist");
    await build({
      configFile,
      root: fixtureDir,
      base: "./",
      build: { outDir: distDir, emptyOutDir: true },
    });
    const assetsDir = path.join(distDir, "assets");
    const emittedWorklet = fs.readdirSync(assetsDir).find((file) => /^dictation-worklet-.*\.js$/.test(file));
    assert.ok(emittedWorklet, "production build emits the dictation worklet as a same-origin JavaScript asset");
    const builtScripts = fs
      .readdirSync(assetsDir)
      .filter((file) => file.endsWith(".js"))
      .map((file) => fs.readFileSync(path.join(assetsDir, file), "utf8"))
      .join("\n");
    assert.doesNotMatch(builtScripts, /data:text\/javascript;base64/, "production scripts do not inline the worklet as a data URL");
    await runElectron(pathToFileURL(path.join(distDir, "index.html")).href, true);
  } finally {
    await server.close();
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

async function runElectron(url, production = false) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [__filename, url];
  if (production) args.push("--production");
  const child = require("node:child_process").spawn(require("electron"), args, { env, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (status) => resolve(status ?? 1));
  });
  assert.equal(code, 0, `${production ? "production" : "dev"} Electron dictation fixture exits successfully`);
}
if (process.versions.electron) void checks();
else
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
