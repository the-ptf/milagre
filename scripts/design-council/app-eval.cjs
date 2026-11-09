// Evaluates JavaScript in the running Milagre debug app through Metro's inspector proxy (Hermes CDP).
// Used by capture-phone.sh to read the current route (a readiness check) and to silence LogBox toasts.
// No app source is changed: everything here happens at runtime in the debug build.
//
//   node scripts/design-council/app-eval.cjs <metroPort> <command> [arg]
//   commands: route            print {"name","params","sheet"} of the focused screen
//             quiet            LogBox.ignoreAllLogs + clear, so no warning toast covers a screenshot
//             wait-route NAME  wait (up to 20 s) until the focused route is NAME (e.g. chat, model-sheet, settings)
//             settle [NAMES]   wait until the focused route (one of NAMES, comma-separated) holds still for 1.5 s
//             navigate|push|replace HREF   expo-router's router.<method>(HREF): the same route a milagre:// deep link
//                              opens, without iOS's "Open in Milagre?" prompt that `simctl openurl` raises on iOS 27
//             reset            router.dismissAll(): close sheets and pushed screens
//             eval EXPR        evaluate EXPR and print the result
const [port = "8899", command = "route", arg] = process.argv.slice(2);

// Metro modules are looked up by their path in dev builds (verboseName), never by numeric id.
const PRELUDE = `
var __council = (function () {
  var mods = __r.getModules();
  function find(suffix) {
    var found = null;
    mods.forEach(function (m, id) {
      if (!found && m && m.verboseName && m.verboseName.slice(-suffix.length) === suffix) {
        if (!m.isInitialized) __r(id);
        found = m.publicModule.exports;
      }
    });
    return found;
  }
  return { find: find };
})();
function __councilRoute() {
  var nav = __council.find("expo-router/build/global-state/navigationRef.js");
  var ref = nav && nav.navigationRef;
  if (!ref || !ref.isReady || !ref.isReady()) return null;
  var route = ref.getCurrentRoute();
  return route ? { name: route.name, params: route.params || {} } : null;
}
function __councilRouter() {
  var m = __council.find("expo-router/build/imperative-api.js");
  return m && m.router;
}
`;

const EXPRESSIONS = {
  route: () => `JSON.stringify(__councilRoute())`,
  quiet: () => `(function(){
    var lb = __council.find("react-native/Libraries/LogBox/LogBox.js");
    var box = lb && (lb.default || lb);
    if (box && box.ignoreAllLogs) { box.ignoreAllLogs(true); if (box.clearAllLogs) box.clearAllLogs(); return "quiet"; }
    return "no LogBox";
  })()`,
  navigate: (href) => routerCall("navigate", href),
  push: (href) => routerCall("push", href),
  replace: (href) => routerCall("replace", href),
  // Closes every sheet and pushed screen above the root, so the next replace starts from a known stack.
  reset: () => `(function(){ var r = __councilRouter(); if (!r) return "no router"; if (r.canDismiss && r.canDismiss()) r.dismissAll(); return "ok"; })()`,
  eval: (expr) => expr,
};

function routerCall(method, href) {
  return `(function(){ var r = __councilRouter(); if (!r) throw new Error("expo-router is not ready"); r.${method}(${JSON.stringify(href)}); return "ok"; })()`;
}

async function target() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((item) => item.appId === "com.victorlucas.milagre" && item.webSocketDebuggerUrl) || list.find((item) => item.webSocketDebuggerUrl);
  if (!page) throw new Error("The app is not connected to Metro on port " + port);
  return page.webSocketDebuggerUrl;
}

async function evaluate(expression) {
  // Metro's inspector proxy only accepts a loopback Origin (Node's WebSocket takes headers as a non-standard option).
  const socket = new WebSocket(await target(), { headers: { Origin: `http://127.0.0.1:${port}` } });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not reach the app's debugger socket")), { once: true });
  });
  try {
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Runtime.evaluate timed out")), 8000);
      socket.addEventListener("message", (event) => {
        const data = JSON.parse(event.data);
        if (data.id === 1) {
          clearTimeout(timer);
          resolve(data);
        }
      });
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: PRELUDE + expression, returnByValue: true } }));
    });
    if (reply.error) throw new Error(reply.error.message);
    if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description || reply.result.exceptionDetails.text);
    return reply.result?.result?.value;
  } finally {
    socket.close();
  }
}

async function main() {
  if (command === "wait-route" || command === "settle") {
    // wait-route NAME[,NAME]: the focused route is one of NAMEs. settle [NAMES]: also unchanged for 1.5 s, which
    // outlasts the app's own start-up redirects (auto-connect, then restoring the last Chat).
    const names = arg ? arg.split(",") : null;
    const stableFor = command === "settle" ? 1500 : 0;
    const deadline = Date.now() + Number(process.env.COUNCIL_ROUTE_TIMEOUT_MS || 30000);
    let last,
      since = 0;
    while (Date.now() < deadline) {
      const now = await evaluate(EXPRESSIONS.route()).catch((error) => JSON.stringify({ error: error.message }));
      if (now !== last) since = Date.now();
      last = now;
      const route = JSON.parse(last || "null");
      if (route?.name && (!names || names.includes(route.name)) && Date.now() - since >= stableFor) return console.log(last);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Route never ${command === "settle" ? "settled on" : "became"} ${arg || "a screen"}; last: ${last}`);
  }
  const build = EXPRESSIONS[command];
  if (!build) throw new Error(`Unknown command ${command}`);
  console.log(await evaluate(build(arg)));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
