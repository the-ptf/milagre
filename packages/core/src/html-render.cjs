const { z } = require("zod");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { setTimeout: delay } = require("node:timers/promises");
const { createBrowserAdapter } = require("./browsers-cdp.cjs");
const { htmlRenderShell, htmlRenderHeight, HTML_RENDER_THEMES, HTML_RENDER_MIN_HEIGHT, HTML_RENDER_MAX_HEIGHT } = require("@milagre/shared/html-render");
const { artifactDocument } = require("@milagre/shared/artifact-document");

const htmlInput = z
  .string()
  .min(1)
  .max(1_000_000)
  .describe("A self-contained HTML document with inline CSS and JavaScript. Embed images as data URLs or use HTTPS URLs.");
// What makes a page read as part of the reply. Shared by both tools so a preview is judged by the same rules.
const GUIDE = [
  "The page appears inside your reply at the transcript's width (as narrow as 340px on a phone, up to 760px on desktop), on the chat background, with no card, frame, title or toolbar around it.",
  "Milagre already styles plain HTML like the chat in light and dark: body text, h1-h4 at chat sizes, tables, buttons (type=submit or aria-pressed=true for the primary one), inputs, selects, sliders, checkboxes and details/summary. Write semantic HTML and add only layout CSS; don't restyle those elements, set a font or a base font size, or set a background or padding on body.",
  "No outer wrapper card: no outer padding, border, shadow, background or max-width. The first element starts at the top edge. Don't add a page title that repeats your reply; a short h3 per section is enough.",
  "Keep it compact, usually under 600px tall. Lay out with flex-wrap or grid repeat(auto-fit,minmax(...,1fr)) so it reflows at 340px: about 90px for a row of short stats, 160px for larger blocks. No viewport units (vh, vw) and no fixed widths over 320px.",
  "Charts: inline SVG with a viewBox, width:100% and a height between 140 and 240px. Label axes and values in 11-12px text with fill var(--muted), gridlines in var(--line), series in var(--chart-1) to var(--chart-5), and leave room in the viewBox for labels. Lay a chart out at its real width (read clientWidth, redraw on resize) so text never stretches. A canvas reads colors with getComputedStyle and redraws on the window themechange event; prefer SVG.",
  "Theme variables: --ink, --ink-2, --muted, --background, --surface, --field, --line, --line-strong, --accent, --accent-ink, --accent-tint, --on-accent, --green, --orange, --red, --purple, --chart-1 to --chart-5, --font, --mono, --text-size, --radius.",
  "Scripts are isolated from Milagre; remote scripts, fetch, forms and access to local files are blocked. HTTPS images and fonts work. Links open in the reader's browser.",
].join(" ");

function htmlRenderToolDefinitions(chatId, artifacts, { preview = previewHtml } = {}) {
  return [
    {
      name: "html_preview",
      description: `Check HTML before publishing it with html_render. Returns a PNG screenshot in Milagre's theme, the measured height, horizontal overflow in pixels (overflowX), its first element selector (overflowSelector), and browser console messages without adding anything to the conversation. Check width 340 as well as the default 720, and dark appearance when colors matter. ${GUIDE}`,
      input: { html: htmlInput, width: z.number().int().min(240).max(1600).optional(), appearance: z.enum(["light", "dark"]).optional() },
      readOnly: true,
      run: async (args) => {
        const { png, ...result } = await preview(args);
        return { text: JSON.stringify(result), images: [{ base64: png, mime: "image/png" }] };
      },
    },
    {
      name: "html_render",
      description: `Show a finished HTML page, chart or interactive explainer directly in this Chat above your reply. Call html_preview to check it first. Each call saves a separate immutable page in the conversation; it does not replace the live Artifact page. It renders directly in the conversation on desktop and phone, without a card, title bar or toolbar. ${GUIDE} Use design_show for editable UI designs and artifact_show for a live report to revise in place.`,
      input: {
        html: htmlInput,
        title: z.string().min(1).max(120).describe("Non-empty internal label for this saved reply; it is not displayed as a heading or frame."),
        height: z
          .number()
          .int()
          .min(HTML_RENDER_MIN_HEIGHT)
          .max(HTML_RENDER_MAX_HEIGHT)
          .optional()
          .describe("contentHeight from html_preview, in pixels, so the reply opens at its size. Defaults to 400."),
      },
      readOnly: false,
      run: async (args) => JSON.stringify(await artifacts.render({ chatId, ...args })),
    },
  ];
}

async function chromeExecutable() {
  const candidates = [process.env.MILAGRE_HTML_PREVIEW_CHROME];
  if (process.platform === "darwin")
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  if (process.platform === "win32")
    for (const root of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean))
      candidates.push(path.join(root, "Google/Chrome/Application/chrome.exe"), path.join(root, "Microsoft/Edge/Application/msedge.exe"));
  for (const root of (process.env.PATH ?? "").split(path.delimiter))
    for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) candidates.push(path.join(root, name));
  for (const candidate of candidates.filter(Boolean))
    if (
      await fs.access(candidate, fs.constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  throw Error(
    "HTML preview needs Chrome or Chromium on this computer. Install one or set MILAGRE_HTML_PREVIEW_CHROME to its executable. html_render still works without it.",
  );
}

// Dedicated temporary profile: preview never opens or reads the user's browser session. Always torn down on error.
// `run(page)` drives the headless page: `page.session` (CDP), `page.open(html)` navigates to the document, and
// `page.messages` collects what its console logged and threw. `deadline` is when it gives up.
async function withPreviewPage(run, { timeout = 20_000 } = {}) {
  const executable = await chromeExecutable();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-html-preview-"));
  const adapter = createBrowserAdapter();
  let child, session, failure;
  const messages = [];
  const deadline = Date.now() + timeout;
  try {
    child = spawn(
      executable,
      [
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${directory}`,
        // A fresh profile has no saved key: without these, macOS Chrome asks for "Chrome Safe Storage" on every preview.
        "--use-mock-keychain",
        "--password-store=basic",
        "about:blank",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    child.on("error", (error) => {
      failure = error;
    });
    let port;
    while (!port) {
      if (failure) throw failure;
      if (child.exitCode !== null) throw Error(`The HTML preview browser could not start: it exited with code ${child.exitCode}.`);
      if (Date.now() > deadline) throw Error(`The HTML preview browser could not start: no debugging port after ${timeout / 1000} s.`);
      // Chromium writes the file in place, so a read can catch the port's first digits only: wait for the line to end.
      const [line, rest] = (await fs.readFile(path.join(directory, "DevToolsActivePort"), "utf8").catch(() => "")).split("\n");
      if (rest !== undefined) port = Number(line);
      if (!port) await delay(50);
    }
    // The page list shares the start's deadline: a browser still starting up answers late, not never.
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1000)) }).then((r) =>
      r.json(),
    );
    const page = pages.find((p) => p.type === "page");
    if (!page) throw Error("The HTML preview browser has no page.");
    session = await adapter.session({ host: "127.0.0.1", port }, page.id);
    session.on((method, params) => {
      if (messages.length >= 50) return;
      if (method === "Runtime.consoleAPICalled")
        messages.push({
          level: params.type,
          text: (params.args ?? [])
            .map((arg) => String(arg.value ?? arg.description ?? ""))
            .join(" ")
            .slice(0, 2000),
        });
      if (method === "Runtime.exceptionThrown")
        messages.push({ level: "error", text: String(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "").slice(0, 2000) });
      if (method === "Log.entryAdded" && params.entry?.level === "error")
        messages.push({ level: "error", text: `${params.entry.text ?? ""}${params.entry.url ? ` ${params.entry.url}` : ""}`.slice(0, 2000) });
    });
    await session.send("Runtime.enable");
    await session.send("Page.enable");
    await session.send("Log.enable");
    // Navigate normally: document.write through setDocumentContent can stall when Chromium creates the sandboxed child frame.
    const open = async (html) => {
      const documentFile = path.join(directory, "preview.html");
      await fs.writeFile(documentFile, html, { mode: 0o600 });
      await session.send("Page.navigate", { url: pathToFileURL(documentFile).href });
    };
    const evaluate = async (expression) => (await session.send("Runtime.evaluate", { expression, returnByValue: true })).result?.value;
    return await run({ session, open, evaluate, messages, deadline });
  } finally {
    session?.close();
    await adapter.stop();
    if (child && child.exitCode === null) {
      child.kill();
      for (let i = 0; i < 20 && child.exitCode === null; i++) await delay(50);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function previewHtml({ html, width = 720, appearance = "light" }) {
  return withPreviewPage(async ({ session, open, evaluate, messages, deadline }) => {
    await session.send("Emulation.setDeviceMetricsOverride", { width, height: 120, deviceScaleFactor: 1, mobile: false });
    await open(htmlRenderShell(html, HTML_RENDER_THEMES[appearance]));
    let height;
    while (!height) {
      height = await evaluate("window.htmlRenderContentHeight");
      if (Date.now() > deadline) {
        const state = await evaluate(
          "JSON.stringify({ready:document.readyState,visibility:document.visibilityState,protocol:location.protocol,frames:window.frames.length,height:window.htmlRenderContentHeight})",
        );
        throw Error(`The HTML page did not finish rendering. Check its scripts. Browser state: ${state}`);
      }
      if (!height) await delay(100);
    }
    // Allow image/font layout and scheduled interaction setup to settle, then measure again.
    await delay(300);
    height = htmlRenderHeight((await evaluate("window.htmlRenderContentHeight")) ?? height);
    await session.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const { data } = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const diagnostics = await evaluate("window.htmlRenderConsole");
    const overflow = await evaluate("window.htmlRenderOverflow");
    return {
      width,
      contentHeight: height,
      ...overflow,
      consoleMessages: [...messages, ...(diagnostics ?? [])].slice(0, 50),
      png: data,
    };
  });
}

/**
 * An interactive design drawn at its screen size, as its viewers run it (DESIGN_CODE_CSP, libraries from the CDNs):
 * a PNG of the first screen, what the console logged or threw, and how far the content runs past the screen. Waits
 * for the page to load and its scripts (Babel compiling JSX) to settle; `crop` is a region of the screen.
 */
async function screenshotDesign({ html, width, height, crop }) {
  return withPreviewPage(
    async ({ session, open, evaluate, messages, deadline }) => {
      // Not a phone viewport: the viewers draw the design in a frame its own size, so it lays out at that width.
      await session.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await open(artifactDocument(html, { code: true }));
      while ((await evaluate("document.readyState")) !== "complete") {
        if (Date.now() > deadline) throw Error("The design did not finish loading. Check its scripts and the CDN addresses.");
        await delay(100);
      }
      // Scripts that render after load (React, Babel) settle: wait until the DOM stops changing, up to 3 seconds.
      await evaluate(
        "window.__milagreQuiet=0;new MutationObserver(function(){window.__milagreQuiet=0}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,characterData:true})",
      );
      for (let waited = 0, quiet = 0; waited < 3000 && quiet < 400; waited += 100) {
        await delay(100);
        quiet = (await evaluate("window.__milagreQuiet++")) ? quiet + 100 : 0;
      }
      const extent = (await evaluate(
        "({w:Math.max(document.documentElement.scrollWidth,document.body?document.body.scrollWidth:0),h:Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0),text:(document.body&&document.body.innerText||'').trim().length,nodes:document.body?document.body.getElementsByTagName('*').length:0})",
      )) ?? { w: width, h: height, text: 0, nodes: 0 };
      const clip = crop ? { x: crop.x, y: crop.y, width: crop.width, height: crop.height, scale: 1 } : undefined;
      const { data } = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, ...(clip ? { clip } : {}) });
      return {
        png: data,
        // Babel's reminder to precompile is expected here: the design compiles its JSX in the page on purpose.
        consoleMessages: messages.filter((message) => !message.text.includes("in-browser Babel transformer")).slice(0, 50),
        contentWidth: extent.w,
        contentHeight: extent.h,
        blank: !extent.text && extent.nodes < 3,
      };
    },
    { timeout: 30_000 },
  );
}
module.exports = { htmlRenderToolDefinitions, previewHtml, screenshotDesign };
