// Real Chromium check for generated public pages. The server and Electron profile are disposable;
// no publication reaches the public sharing service. MILAGRE_SCREENSHOT_DIR retains screenshots.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { deflateSync } = require("node:zlib");
const { renderDesignPage } = require("@milagre/shared/design-page");

function raster() {
  const chunk = (name, value) => {
    const content = Buffer.concat([Buffer.from(name), value]);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const head = Buffer.alloc(4),
      tail = Buffer.alloc(4);
    head.writeUInt32BE(value.length);
    tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([head, content, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return (
    "data:image/png;base64," +
    Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.from([0, 82, 94, 234, 255]))),
      chunk("IEND", Buffer.alloc(0)),
    ]).toString("base64")
  );
}
const samplePage = () => ({
  schemaVersion: 1,
  title: "Studio notes",
  designs: [
    {
      title: "Desktop workspace",
      document: {
        schemaVersion: 1,
        width: 1024,
        height: 768,
        background: "#f5f3ee",
        nodes: [
          { id: "eyebrow", type: "text", x: 48, y: 44, width: 400, height: 24, text: "FIELDNOTES / WORKSPACE", fontSize: 13, fontWeight: 700, fill: "#61756d" },
          {
            id: "heading",
            type: "text",
            x: 48,
            y: 100,
            width: 800,
            height: 90,
            text: "Make room for good work.",
            fontSize: 48,
            fontWeight: 700,
            fill: "#243a32",
          },
          {
            id: "subtitle",
            type: "text",
            x: 48,
            y: 200,
            width: 840,
            height: 60,
            text: "A quiet place for plans, conversations and the next idea.",
            fontSize: 20,
            fill: "#61756d",
          },
          { id: "card", type: "rectangle", x: 48, y: 310, width: 580, height: 340, fill: "#ffffff", radius: 20 },
          { id: "card-title", type: "text", x: 76, y: 340, width: 500, height: 40, text: "This week", fontSize: 24, fontWeight: 600, fill: "#243a32" },
          {
            id: "list",
            type: "text",
            x: 76,
            y: 410,
            width: 490,
            height: 160,
            text: "Finish the first draft\nCollect a little inspiration\nLeave space to think",
            fontSize: 20,
            lineHeight: 2,
            fill: "#61756d",
          },
          { id: "raster", type: "image", x: 660, y: 310, width: 316, height: 340, src: raster(), radius: 20 },
          {
            id: "raster-label",
            type: "text",
            x: 690,
            y: 350,
            width: 254,
            height: 160,
            text: "A small idea.\nA fresh start.",
            fontSize: 34,
            fontWeight: 700,
            lineHeight: 1.4,
            fill: "#ffffff",
          },
        ],
      },
    },
    {
      title: "Phone workspace",
      document: {
        schemaVersion: 1,
        width: 390,
        height: 844,
        background: "#243a32",
        nodes: [
          { id: "eyebrow", type: "text", x: 28, y: 50, width: 320, height: 24, text: "FIELDNOTES", fontSize: 13, fontWeight: 700, fill: "#bed0c4" },
          {
            id: "heading",
            type: "text",
            x: 28,
            y: 108,
            width: 334,
            height: 115,
            text: "Good things\ntake shape.",
            fontSize: 42,
            fontWeight: 700,
            fill: "#f5f3ee",
          },
          {
            id: "subtitle",
            type: "text",
            x: 28,
            y: 245,
            width: 330,
            height: 75,
            text: "Your ideas, gathered in one place.",
            fontSize: 18,
            lineHeight: 1.4,
            fill: "#bed0c4",
          },
          { id: "card", type: "rectangle", x: 28, y: 364, width: 334, height: 240, fill: "#f5f3ee", radius: 20 },
          {
            id: "card-label",
            type: "text",
            x: 52,
            y: 392,
            width: 280,
            height: 100,
            text: "Today\nOne thoughtful step.",
            fontSize: 24,
            fontWeight: 600,
            lineHeight: 1.6,
            fill: "#243a32",
          },
          { id: "button", type: "rectangle", x: 52, y: 518, width: 286, height: 54, fill: "#5260df", radius: 12 },
          {
            id: "button-label",
            type: "text",
            x: 66,
            y: 534,
            width: 258,
            height: 24,
            text: "Open notebook",
            textAlign: "center",
            fontSize: 16,
            fontWeight: 600,
            fill: "#ffffff",
          },
        ],
      },
    },
  ],
});

function artifactPage(origin) {
  const blocked = `${origin}/blocked`;
  return {
    schemaVersion: 1,
    kind: "artifacts",
    title: "An explanation </h1><script>window.outerInjected=true</script>",
    artifacts: [
      {
        title: 'Interactive explanation " onload="window.outerInjected=true',
        width: 1280,
        height: 800,
        html: `<!doctype html><html><head><style>body{font-family:system-ui;padding:28px;color:#243a32}button{padding:12px}#remote-background{background-image:url('${blocked}/background')}</style></head><body>
        <h1>Why the result changes</h1><p>Adjust the count to explore the explanation.</p>
        <button id="increment">Add one</button><output id="count">0</output>
        <p id="remote-background">Embedded interactive content remains usable.</p>
        "></iframe><script>window.escapeMarker=true</script>
        <script>
          window.artifactProbe = { inline: true, violations: [] };
          const probe = window.artifactProbe;
          document.addEventListener('securitypolicyviolation', event => probe.violations.push(event.effectiveDirective));
          const denied = action => { try { action(); return false; } catch (error) { return error.name === 'SecurityError'; } };
          probe.parentDOM = denied(() => parent.document.body);
          probe.parentCookies = denied(() => parent.document.cookie);
          probe.cookies = denied(() => document.cookie);
          probe.localStorage = denied(() => localStorage.getItem('public-session'));
          probe.sessionStorage = denied(() => sessionStorage.getItem('public-session'));
          probe.node = typeof require === 'undefined' && typeof process === 'undefined';
          document.getElementById('increment').onclick = () => document.getElementById('count').textContent = String(Number(document.getElementById('count').textContent) + 1);
          fetch('${blocked}/fetch').then(() => probe.fetch = false, () => probe.fetch = true);
          const image = new Image(); image.onload = () => probe.image = false; image.onerror = () => probe.image = true; image.src = '${blocked}/image'; document.body.append(image);
          const script = document.createElement('script'); script.onerror = () => probe.script = true; script.src = '${blocked}/script'; document.body.append(script);
          const frame = document.createElement('iframe'); frame.src = '${blocked}/nested-frame'; document.body.append(frame);
          window.attemptArtifactNavigation = () => {
            probe.popup = window.open('${blocked}/popup') === null;
            probe.top = denied(() => top.location.href = '${blocked}/top');
            const form = document.createElement('form'); form.action = '${blocked}/form'; form.method = 'POST'; document.body.append(form); form.submit();
            const link = document.createElement('a'); link.href = '${blocked}/self-link'; document.body.append(link); link.click();
            window.location.href = '${blocked}/self-script';
            const refresh = document.createElement('meta'); refresh.httpEquiv = 'refresh'; refresh.content = '0;url=${blocked}/self-refresh'; document.head.append(refresh);
            probe.navigationAttempted = true;
          };
        </script></body></html>`,
      },
    ],
  };
}

// Camera moves animate on animation frames, which a hidden window may run slowly: wait for the move to end.
async function settled(evaluate) {
  for (let attempt = 0; attempt < 250; attempt++) {
    await delay(20);
    if (await evaluate("!('animating' in document.getElementById('mv-canvas').dataset)")) return;
  }
  throw Error("The canvas kept animating");
}

async function checkCanvas({ window, evaluate, ready, screenshot, send, url }) {
  await window.loadURL(url + "/page");
  await ready();
  assert.equal(await evaluate("document.images.length"), 2);
  assert.deepEqual(await evaluate("[...document.images].map(image => [image.naturalWidth, image.naturalHeight])"), [
    [1024, 768],
    [390, 844],
  ]);
  const pixel = await evaluate(
    `(async () => {const image = document.images[0]; const canvas = document.createElement('canvas'); canvas.width=image.naturalWidth; canvas.height=image.naturalHeight; const context=canvas.getContext('2d');context.drawImage(image,0,0);return [...context.getImageData(670,630,1,1).data]})()`,
  );
  assert.deepEqual(pixel, [82, 94, 234, 255], "the embedded raster survives SVG image rendering");
  assert.equal(await evaluate("fetch('https://example.com/blocked').then(() => false, () => true)"), true, "CSP blocks external network requests");
  assert.equal(await evaluate("!!window.milagre || !!window.require"), false, "public pages cannot reach the host bridge or Node");
  await screenshot("viewer-desktop");
  assert.equal(await evaluate("document.querySelectorAll('header, footer, #canvas, #viewport, .dock').length"), 0, "the viewer replaces the stored layout");
  assert.equal(await evaluate("document.querySelectorAll('style').length"), 1, "only the viewer's style applies");
  assert.deepEqual(
    await evaluate("(r => [innerHeight - r.bottom, r.top])(document.getElementById('mv-port').getBoundingClientRect())"),
    [0, 0],
    "the canvas fills the window",
  );
  const logo = await evaluate(
    "(() => {const a=document.querySelector('a.mv-logo');return {href:a.href,target:a.target,rel:a.rel,label:a.getAttribute('aria-label')}})()",
  );
  assert.deepEqual(logo, { href: "https://milagre.cloud/", target: "_blank", rel: "noopener noreferrer", label: "Made with Milagre" });
  const placed = await evaluate(
    "(() => {const box=e=>e.getBoundingClientRect(),bar=box(document.querySelector('.mv-bar')),logo=box(document.querySelector('a.mv-logo'));return {barLeft:bar.left,barBottom:bar.bottom,barHeight:bar.height,logoRight:logo.right,logoBottom:logo.bottom,logoSize:[logo.width,logo.height],width:innerWidth,height:innerHeight}})()",
  );
  assert.equal(placed.width - placed.logoRight, 16, "the logo sits 16px from the right edge");
  assert.equal(placed.height - placed.logoBottom, 16, "the logo sits 16px from the bottom edge");
  assert.deepEqual(placed.logoSize, [32, 32]);
  assert.equal(placed.barLeft, 16, "the zoom bar sits 16px from the left edge");
  assert.equal(placed.barBottom, placed.logoBottom, "zoom bar and logo share a baseline");
  assert.equal(placed.barHeight, 32);
  const transform = () => evaluate("document.getElementById('mv-canvas').style.transform");
  const before = await transform();
  await evaluate("document.getElementById('mv-in').click()");
  await settled(evaluate);
  assert.notEqual(await transform(), before, "zoom changes the canvas");
  const afterZoom = await transform();
  await evaluate("document.getElementById('mv-port').dispatchEvent(new WheelEvent('wheel',{deltaX:35,deltaY:20,bubbles:true,cancelable:true}))");
  assert.notEqual(await transform(), afterZoom, "wheel pans the canvas");
  await evaluate("document.getElementById('mv-fit').click()");
  await settled(evaluate);
  assert.equal(await transform(), before, "Fit restores the whole page");
  await evaluate("document.getElementById('mv-zoom').click()");
  await settled(evaluate);
  assert.equal(await evaluate("document.getElementById('mv-zoom').textContent"), "100%", "the zoom reading resets to 100%");
  assert.equal(await evaluate("new DOMMatrix(getComputedStyle(document.getElementById('mv-canvas')).transform).a"), 1);
  await evaluate("document.getElementById('mv-fit').click()");
  await settled(evaluate);

  // A mouse drag across a frame's text pans the canvas and selects nothing.
  const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
  const [fx, fy] = await evaluate("(r => [r.x + 60, r.y + 60])(document.querySelector('.mv-surface').getBoundingClientRect())");
  await mouse("mousePressed", fx, fy, { buttons: 1 });
  for (let i = 1; i <= 5; i++) await mouse("mouseMoved", fx + i * 40, fy + i * 30, { buttons: 1 });
  await mouse("mouseReleased", fx + 200, fy + 150);
  assert.equal(await evaluate("getSelection().toString()"), "", "dragging selects no text");
  assert.equal(await evaluate("getComputedStyle(document.body).userSelect"), "none");
  assert.notEqual(await transform(), before, "dragging over a frame pans the canvas");

  // Double-click zooms to a frame; double-click on the background fits everything again; keys do both too.
  const surface = (index) =>
    evaluate(`(r => ({x:r.x,y:r.y,width:r.width,height:r.height}))(document.querySelectorAll('.mv-surface')[${index}].getBoundingClientRect())`);
  const doubleClick = async (x, y) => {
    for (let i = 0; i < 2; i++) {
      await mouse("mousePressed", x, y, { clickCount: i + 1 });
      await mouse("mouseReleased", x, y, { clickCount: i + 1 });
    }
    await settled(evaluate);
  };
  const phone = await surface(1);
  await doubleClick(phone.x + phone.width / 2, phone.y + phone.height / 2);
  const zoomed = await surface(1);
  assert.ok(Math.abs(zoomed.x + zoomed.width / 2 - 640) < 2, "double-click centres the frame");
  assert.ok(zoomed.height > 760 && zoomed.y >= 0 && zoomed.y + zoomed.height <= 900 - 64 + 1, "and zooms until it fills the window above the dock");
  await doubleClick(4, 4);
  assert.equal(await transform(), before, "double-click on the background fits everything");
  await evaluate("document.getElementById('mv-port').focus()");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "1", text: "1" });
  await settled(evaluate);
  assert.equal(await evaluate("document.getElementById('mv-zoom').textContent"), "100%", "1 zooms to 100%");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "0", text: "0" });
  await settled(evaluate);
  assert.equal(await transform(), before, "0 fits everything");

  // A link to one frame opens zoomed to it.
  await window.loadURL("about:blank");
  await window.loadURL(url + "/page#frame=phone-workspace");
  await ready();
  const linked = await surface(1);
  assert.ok(Math.abs(linked.x + linked.width / 2 - 640) < 2 && linked.height > 600, "a frame link opens on that frame");
  return before;
}

async function checkMenu({ window, evaluate, ready, screenshot, send, url, downloads }) {
  await window.loadURL(url + "/page");
  await ready();
  const [x, y] = await evaluate("(r => [r.x + r.width / 2, r.y + r.height / 2])(document.querySelector('.mv-surface').getBoundingClientRect())");
  const rightClick = async (px, py) => {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: px, y: py, button: "right", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: px, y: py, button: "right", clickCount: 1 });
  };
  const items = () =>
    evaluate("document.getElementById('mv-menu').hidden ? null : [...document.querySelectorAll('#mv-menu button')].map(b => b.firstChild.textContent)");
  await rightClick(x, y);
  assert.deepEqual(await items(), ["Download PNG", "Download SVG", "Copy image", "Zoom to frame", "Copy link to frame"], "right-click opens the frame's menu");
  await delay(100);
  await screenshot("viewer-frame-menu");
  const pick = (text) => evaluate(`[...document.querySelectorAll('#mv-menu button')].find(b => b.firstChild.textContent === ${JSON.stringify(text)}).click()`);
  const downloaded = async (count) => {
    for (let i = 0; i < 100 && downloads.length < count; i++) await delay(20);
    return downloads[count - 1];
  };
  await pick("Download PNG");
  assert.equal(await items(), null, "choosing closes the menu");
  const image = await downloaded(1);
  assert.equal(image.state, "completed");
  assert.equal(image.name, "desktop-workspace.png");
  const bytes = await fs.readFile(image.file);
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [2048, 1536], "PNGs export at twice the frame size");
  await rightClick(x, y);
  await pick("Download SVG");
  const vector = await downloaded(2);
  assert.equal(vector.name, "desktop-workspace.svg");
  assert.match(await fs.readFile(vector.file, "utf8"), /^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  await evaluate("navigator.clipboard.writeText = text => (window.copied = text, Promise.resolve()), 0");
  await rightClick(x, y);
  await pick("Copy link to frame");
  await delay(20);
  assert.equal(await evaluate("window.copied"), url + "/page#frame=desktop-workspace");
  assert.equal(await evaluate("document.getElementById('mv-toast').textContent"), "Link copied");
  await rightClick(4, 4);
  assert.deepEqual(await items(), ["Fit everything", "Zoom to 100%", "Copy link"], "the background has the canvas menu");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  assert.equal(await items(), null, "Escape closes the menu");
  await evaluate("document.querySelector('figure').focus()");
  await evaluate("document.querySelector('.mv-more').click()");
  assert.equal((await items())?.[0], "Download PNG", "a frame's More button opens the same menu");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}

async function checkLiveAndLegacy({ window, evaluate, ready, screenshot, send, url }) {
  await window.loadURL(url + "/live");
  await ready();
  const transform = () => evaluate("document.getElementById('mv-canvas').style.transform");
  const live = () => evaluate("document.querySelector('figure:has(iframe)').classList.contains('on')");
  const frame = window.webContents.mainFrame.frames.find((child) => child.url === "about:srcdoc");
  assert.ok(frame, "the interactive design loads");
  const count = () => frame.executeJavaScript("document.getElementById('count').textContent");
  const box = await evaluate(
    "(r => ({x:r.x,y:r.y,width:r.width,height:r.height}))(document.querySelector('figure:has(iframe) .mv-surface').getBoundingClientRect())",
  );
  const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
  const before = await transform();
  await mouse("mousePressed", box.x + 40, box.y + 40, { buttons: 1 });
  for (let i = 1; i <= 4; i++) await mouse("mouseMoved", box.x + 40 + i * 30, box.y + 40 + i * 20, { buttons: 1 });
  await mouse("mouseReleased", box.x + 160, box.y + 120);
  assert.notEqual(await transform(), before, "a drag over an interactive design pans the canvas");
  assert.equal(await live(), false);
  assert.equal(await count(), "0", "and never reaches the design");
  const moved = await evaluate(
    "(r => ({x:r.x,y:r.y,width:r.width,height:r.height}))(document.querySelector('figure:has(iframe) .mv-surface').getBoundingClientRect())",
  );
  await mouse("mousePressed", moved.x + moved.width / 2, moved.y + moved.height / 2);
  await mouse("mouseReleased", moved.x + moved.width / 2, moved.y + moved.height / 2);
  assert.equal(await live(), true, "a click lets you use the design");
  await delay(50);
  await screenshot("viewer-live-design");
  const button = await frame.executeJavaScript("(r => [r.x + r.width / 2, r.y + r.height / 2])(document.getElementById('count').getBoundingClientRect())");
  const ratio = moved.width / 390;
  await mouse("mousePressed", moved.x + button[0] * ratio, moved.y + button[1] * ratio);
  await mouse("mouseReleased", moved.x + button[0] * ratio, moved.y + button[1] * ratio);
  await delay(30);
  assert.equal(await count(), "1", "clicks reach the design while it is in use");
  await mouse("mousePressed", 4, 4);
  await mouse("mouseReleased", 4, 4);
  assert.equal(await live(), false, "a click outside hands the pointer back to the canvas");

  await window.loadURL(url + "/legacy");
  await ready();
  assert.equal(await evaluate("window.legacyRan > 0"), true, "the old page's own script ran");
  assert.equal(await evaluate("document.querySelectorAll('#canvas, #viewport, .dock, #fit').length"), 0, "an old page's layout and chrome are replaced");
  assert.equal(await evaluate("document.querySelectorAll('style').length"), 1);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#mv-canvas section figure figcaption span')].map(s => s.textContent)"), ["Old frame"]);
  const legacy = await evaluate("document.getElementById('mv-canvas').style.transform");
  window.setContentSize(1000, 700);
  await delay(150);
  assert.notEqual(
    await evaluate("document.getElementById('mv-canvas').style.transform"),
    "translate(1px, 1px) scale(0.5)",
    "the old script no longer moves the canvas",
  );
  assert.notEqual(await evaluate("document.getElementById('mv-canvas').style.transform"), legacy, "the new viewer refits on resize");
  window.setContentSize(1280, 900);
  await screenshot("viewer-legacy-page");
}

async function checkPresentation({ window, evaluate, ready, send, url }) {
  await window.loadURL(url + "/present#screen=2");
  await ready();
  const state = () =>
    evaluate(
      "[document.getElementById('mvp-count').textContent, document.querySelector('.mvp-slide:not([hidden])').getAttribute('aria-label'), location.hash, !!document.getElementById('mv-port')]",
    );
  assert.deepEqual(await state(), ["2 of 3", "Counter", "#screen=2", false], "a link to a screen opens on it, with no canvas");
  const key = async (code) => {
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: code, code, windowsVirtualKeyCode: code === "ArrowLeft" ? 37 : 39 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: code, code, windowsVirtualKeyCode: code === "ArrowLeft" ? 37 : 39 });
  };
  let frame;
  for (let tries = 0; tries < 100 && !frame; tries++) {
    const found = window.webContents.mainFrame.frames.find((child) => child.url === "about:srcdoc");
    if (found && (await found.executeJavaScript("!!document.getElementById('count')").catch(() => false))) frame = found;
    else await delay(20);
  }
  assert.ok(frame, "the interactive screen loads");
  const button = await frame.executeJavaScript("(r => [r.x + r.width / 2, r.y + r.height / 2])(document.getElementById('count').getBoundingClientRect())");
  const screen = await evaluate("(r => ({x:r.x,width:r.width,y:r.y}))(document.querySelector('.mvp-slide:not([hidden]) .mvp-screen').getBoundingClientRect())");
  const ratio = screen.width / 390;
  const mouse = (type, x, y) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  await mouse("mouseMoved", screen.x + button[0] * ratio, screen.y + button[1] * ratio);
  await mouse("mousePressed", screen.x + button[0] * ratio, screen.y + button[1] * ratio);
  await mouse("mouseReleased", screen.x + button[0] * ratio, screen.y + button[1] * ratio);
  const counted = () => frame.executeJavaScript("document.getElementById('count').textContent");
  for (let tries = 0; tries < 100 && (await counted()) !== "1"; tries++) await delay(10);
  assert.equal(await counted(), "1", "an interactive screen takes clicks directly");
  await evaluate("document.activeElement?.blur(); document.body.focus()");
  await key("ArrowRight");
  assert.deepEqual((await state()).slice(0, 3), ["3 of 3", "Last", "#screen=3"]);
  assert.equal(await evaluate("document.getElementById('mvp-next').disabled"), true, "the last screen can't go further");
  await key("ArrowLeft");
  await key("ArrowLeft");
  assert.deepEqual((await state()).slice(0, 2), ["1 of 3", "First"]);
  await evaluate("document.getElementById('mvp-next').click()");
  assert.equal((await state())[0], "2 of 3");
  assert.equal(await counted(), "1", "moving between screens keeps an interactive screen's state");
}

async function checkTouch({ window, evaluate, ready, screenshot, send, url }) {
  await window.loadURL(url + "/page");
  await ready();
  window.setContentSize(390, 844);
  await delay(150);
  await screenshot("viewer-phone");
  assert.ok(await evaluate("document.getElementById('mv-fit').getBoundingClientRect().right <= innerWidth"));
  const touch = (type, touchPoints) => send("Input.dispatchTouchEvent", { type, touchPoints });
  const matrix = "new DOMMatrix(getComputedStyle(document.getElementById('mv-canvas')).transform)";
  const beforeTouch = await evaluate(`[...${matrix}.toFloat64Array().slice(12,14)]`);
  await touch("touchStart", [
    { x: 110, y: 350, id: 1 },
    { x: 230, y: 350, id: 2 },
  ]);
  await touch("touchMove", [
    { x: 130, y: 370, id: 1 },
    { x: 250, y: 370, id: 2 },
  ]);
  await touch("touchEnd", []);
  const afterTouch = await evaluate(`[...${matrix}.toFloat64Array().slice(12,14)]`);
  assert.ok(
    Math.abs(afterTouch[0] - beforeTouch[0] - 20) < 1 && Math.abs(afterTouch[1] - beforeTouch[1] - 20) < 1,
    "two fingers pan by their midpoint movement",
  );
  const startScale = await evaluate(`${matrix}.a`);
  await touch("touchStart", [
    { x: 110, y: 350, id: 1 },
    { x: 230, y: 350, id: 2 },
  ]);
  await touch("touchMove", [
    { x: 80, y: 350, id: 1 },
    { x: 260, y: 350, id: 2 },
  ]);
  await touch("touchEnd", []);
  assert.ok((await evaluate(`${matrix}.a`)) > startScale, "pinch zooms in");
  const [x, y] = await evaluate("(r => [r.x + r.width / 2, r.y + r.height / 2])(document.querySelector('.mv-surface').getBoundingClientRect())");
  await touch("touchStart", [{ x, y, id: 1 }]);
  await delay(600);
  await touch("touchEnd", []);
  assert.deepEqual(
    await evaluate("(m => [m.hidden, m.className, m.querySelector('.head').textContent])(document.getElementById('mv-menu'))"),
    [false, "sheet", "Desktop workspace"],
    "pressing and holding a frame opens its menu as a sheet",
  );
  await screenshot("viewer-phone-sheet");
  await touch("touchStart", [{ x: 195, y: 60, id: 1 }]);
  await touch("touchEnd", []);
  assert.equal(await evaluate("document.getElementById('mv-menu').hidden"), true, "a tap outside the sheet closes it");

  window.setContentSize(320, 640);
  await window.loadURL(url + "/large");
  await ready();
  await delay(100);
  const bounds = await evaluate(
    "(() => {const r=document.getElementById('mv-canvas').getBoundingClientRect();return {left:r.left,right:r.right,viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,fit:document.getElementById('mv-fit').getBoundingClientRect().right}})()",
  );
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewport, "Fit includes all 20 maximum-width designs on a narrow phone");
  assert.equal(bounds.overflow, false, "a long public title does not overflow the phone");
  assert.ok(bounds.fit <= bounds.viewport, "the phone keeps zoom controls reachable");
  assert.notEqual(await evaluate("document.getElementById('mv-zoom').textContent"), "0%", "sub-percent zoom remains meaningful");
  await screenshot("viewer-phone-wide-page");
  await window.loadURL(url + "/escaped");
  await ready();
  assert.equal(await evaluate("window.injected"), undefined);
  assert.equal(await evaluate("document.querySelectorAll('script').length"), 1, "the viewer is the page's only script");
  assert.equal(await evaluate("document.querySelector('h1').textContent"), "</h1><script>window.injected=true</script>");
  assert.equal(await evaluate("document.querySelector('figcaption span').textContent"), '<img src=x onerror="window.injected=true">');
}

async function checkArtifact({ window, evaluate, screenshot, send, url, failedLoads }) {
  // Execute the actual public HTML under the same HTTP CSP as the Worker. The opaque
  // srcdoc frame must remain interactive without inheriting the public origin's authority.
  window.setContentSize(1280, 900);
  await window.loadURL(url + "/artifact");
  await evaluate("localStorage.setItem('public-session','parent-secret');sessionStorage.setItem('public-session','parent-secret')");
  assert.match(await evaluate("document.cookie"), /public-session=parent-secret/, "the parent origin has a cookie for the isolation probe");
  const frame = window.webContents.mainFrame.frames.find((child) => child.url === "about:srcdoc");
  assert.ok(frame, "the public Artifact loads its srcdoc under frame-src none");
  const evaluateArtifact = (code) => frame.executeJavaScript(code);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluateArtifact("!!(window.artifactProbe?.fetch && window.artifactProbe?.image && window.artifactProbe?.script)")) break;
    await delay(20);
  }
  const probe = await evaluateArtifact("window.artifactProbe");
  for (const field of ["inline", "parentDOM", "parentCookies", "cookies", "localStorage", "sessionStorage", "node", "fetch", "image", "script"])
    assert.equal(probe[field], true, `Artifact sandbox/CSP check: ${field}`);
  assert.equal(
    await evaluate("window.escapeMarker || window.outerInjected"),
    undefined,
    "malicious HTML and titles cannot escape srcdoc into the public wrapper",
  );
  assert.equal(await evaluateArtifact("window.escapeMarker"), true, "the escape probe remains inside the opaque frame");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('iframe')].map(frame => frame.getAttribute('sandbox'))"), ["allow-scripts"]);
  assert.equal(
    await evaluate("document.querySelectorAll('#mv-canvas, #mv-port, #mv-fit, nav, select').length"),
    0,
    "Artifact snapshots have no design canvas, chooser or history controls",
  );
  assert.equal(await evaluate("document.querySelectorAll('header, footer').length"), 0, "the public Artifact has no header or footer");
  assert.deepEqual(
    await evaluate("(r => [innerWidth - r.right, innerHeight - r.bottom, r.width, r.height])(document.querySelector('a.mv-logo').getBoundingClientRect())"),
    [16, 16, 32, 32],
    "the Milagre logo floats bottom-right over the Artifact",
  );
  assert.equal(await evaluate("document.querySelector('a.mv-logo').href"), "https://milagre.cloud/");
  await delay(150);
  await screenshot("viewer-artifact-before-click");
  const click = await evaluateArtifact(
    "(() => {const r=document.getElementById('increment').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
  );
  const outer = await evaluate("(() => {const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y}})()");
  for (const type of ["mousePressed", "mouseReleased"])
    await send("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, x: outer.x + click.x, y: outer.y + click.y });
  await delay(50);
  assert.equal(await evaluateArtifact("document.getElementById('count').textContent"), "1", "a native click runs the Artifact's inline interaction");
  await screenshot("viewer-artifact-desktop");
  await evaluateArtifact("window.attemptArtifactNavigation()");
  await delay(150);
  assert.equal(window.webContents.getURL(), url + "/artifact", "the Artifact cannot navigate the public wrapper");
  assert.ok(
    failedLoads.some((failure) => failure.url.includes("/blocked/self-") && failure.description === "ERR_BLOCKED_BY_CSP"),
    "CSP refuses remote self navigation (Chromium may display its blocked-page document)",
  );
  // Reload the immutable page after the deliberate navigation attack for the phone rendering check.
  await window.loadURL(url + "/artifact");
  window.setContentSize(390, 844);
  await delay(50);
  assert.ok(await evaluate("document.querySelector('iframe').getBoundingClientRect().right <= innerWidth"), "the live page fits the phone viewport");
  await screenshot("viewer-artifact-phone");
}

// The shape pages had before the viewer moved to read time: their own layout, chrome and pan/zoom script.
const LEGACY_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Legacy | Milagre Designs</title><style>#canvas{position:absolute;transform-origin:0 0}figure{margin:0}.dock{position:fixed;bottom:16px}</style></head><body><h1 class="sr">Legacy</h1><main id="viewport" tabindex="0"><div id="canvas"><section aria-label="Flow"><div class="name"><div><span>Flow</span><b>1</b></div></div><div class="block"><figure style="width:390px"><figcaption>Old frame</figcaption><img draggable="false" width="390" height="844" alt="Old frame" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844"><rect width="390" height="844" fill="#d6ddd9"/></svg>')}"></figure></div></section></div></main><div class="dock"><nav class="bar"><button id="in">+</button><button id="fit">Fit</button></nav></div><script>(()=>{const port=document.getElementById('viewport'),canvas=document.getElementById('canvas');const fit=()=>{canvas.style.transform='translate(1px,1px) scale(0.5)';window.legacyRan=(window.legacyRan||0)+1};document.getElementById('fit').onclick=fit;new ResizeObserver(fit).observe(port);fit()})();</script></body></html>`;

async function check() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", process.argv[3]);
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    useContentSize: true,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const failedLoads = [];
  window.webContents.on("did-fail-load", (_event, code, description, url) => failedLoads.push({ code, description, url }));
  const downloadDir = path.join(process.argv[3], "downloads");
  const downloads = [];
  window.webContents.session.on("will-download", (_event, item) => {
    const file = path.join(downloadDir, item.getFilename());
    item.setSavePath(file);
    item.once("done", (_done, state) => downloads.push({ name: item.getFilename(), state, file }));
  });
  const context = {
    window,
    url: process.argv[2],
    failedLoads,
    downloads,
    evaluate: (code) => window.webContents.executeJavaScript(code),
    ready: () => window.webContents.executeJavaScript("Promise.all([...document.images].map(image => image.decode()))"),
    send: (method, params) => window.webContents.debugger.sendCommand(method, params),
    screenshot: async (name) => {
      if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
      await fs.mkdir(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
      await fs.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `${name}.png`), (await window.webContents.capturePage()).toPNG());
    },
  };
  window.webContents.debugger.attach("1.3");
  try {
    await checkCanvas(context);
    await checkMenu(context);
    await checkLiveAndLegacy(context);
    await checkPresentation(context);
    await checkTouch(context);
    await checkArtifact(context);
    console.log(
      "PASS: public pages render under Worker CSP with the read-time viewer; panning never selects, frame menus download and link, live designs take the pointer on click, presentations step through their screens, old pages upgrade, opaque Artifacts stay isolated",
    );
  } finally {
    window.destroy();
    app.quit();
  }
}

async function run() {
  const http = require("node:http");
  const { spawn } = require("node:child_process");
  const { SECURITY_HEADERS, withHead } = await import("../apps/design-share/src/service.mjs");
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-page-viewer-"));
  const sample = samplePage();
  const large = {
    schemaVersion: 1,
    title: "A".repeat(120),
    designs: Array.from({ length: 20 }, (_, index) => ({
      title: `Design ${index + 1}`,
      document: { schemaVersion: 1, width: 3840, height: 844, background: "#d6ddd9", nodes: [] },
    })),
  };
  const escaped = structuredClone(sample);
  escaped.title = "</h1><script>window.injected=true</script>";
  escaped.designs[0].title = '<img src=x onerror="window.injected=true">';
  const live = {
    schemaVersion: 1,
    title: "Live",
    designs: [
      sample.designs[1],
      {
        title: "Counter",
        interactive: {
          width: 390,
          height: 300,
          html: '<!doctype html><html><body style="margin:0"><button id="count" style="width:200px;height:80px;margin:20px">0</button><script>count.onclick=()=>count.textContent=Number(count.textContent)+1</script></body></html>',
        },
      },
    ],
  };
  const pages = new Map([
    ["/page", renderDesignPage(sample)],
    ["/large", renderDesignPage(large)],
    ["/escaped", renderDesignPage(escaped)],
    ["/live", renderDesignPage(live)],
    [
      "/present",
      renderDesignPage({
        schemaVersion: 1,
        kind: "selection",
        title: "Flow",
        designs: [{ ...sample.designs[1], title: "First" }, live.designs[1], { ...sample.designs[1], title: "Last" }],
      }),
    ],
    ["/legacy", LEGACY_PAGE],
  ]);
  const blockedRequests = [];
  const server = http.createServer((request, response) => {
    if (request.url.startsWith("/blocked/")) blockedRequests.push(request.url);
    const page = request.url === "/artifact" ? renderDesignPage(artifactPage(`http://127.0.0.1:${server.address().port}`)) : pages.get(request.url);
    response.writeHead(page ? 200 : 404, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      ...(request.url === "/artifact" ? { "Set-Cookie": "public-session=parent-secret; SameSite=Lax" } : {}),
    });
    response.end(page ? Buffer.from(withHead(new TextEncoder().encode(page), `http://127.0.0.1${request.url}`)) : "Not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [__filename, `http://127.0.0.1:${server.address().port}`, profile], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
    assert.deepEqual(blockedRequests, [], "no Artifact fetch, image, script, form, popup or frame navigation reaches the server");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(profile, { recursive: true, force: true });
  }
}
if (process.versions.electron || require.main === module)
  (process.versions.electron ? check() : run()).catch((error) => {
    console.error(error);
    process.exit(1);
  });
module.exports = { samplePage };
