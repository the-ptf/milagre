import { StrictMode, lazy, Suspense, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { BootSplash } from "./components/StartupSplash";
import "./fonts.css";
import "./styles.css";
import { applyThemeNow } from "./lib/settings";
import { followDisplayVisibility } from "./lib/display-clock";
import { splashDrawnFirst } from "./lib/startup-splash";

applyThemeNow();
followDisplayVisibility();
const floatingView = new URLSearchParams(window.location.search).get("floating-inbox");
const floating = floatingView === "dock" || floatingView === "inbox" || floatingView === "preview" || floatingView === "drag";
document.documentElement.toggleAttribute("data-floating-inbox", floating);
// A floating inbox window loads none of the app itself.
const FloatingInbox = lazy(() => import("./components/FloatingInbox").then((module) => ({ default: module.FloatingInbox })));
const FloatingMotion = lazy(() => import("./components/motion/AppMotionConfig").then((module) => ({ default: module.AppMotionConfig })));
splashDrawnFirst();

// Evaluating the app holds the main thread for a while, so the splash gets its first frame before that starts.
// A window off screen draws no frames, hence the timeout.
const afterFirstFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve));
    setTimeout(resolve, 50);
  });
const root = createRoot(document.getElementById("root")!);

if (floating) {
  root.render(
    <StrictMode>
      <Suspense fallback={null}>
        <FloatingMotion>
          <FloatingInbox view={floatingView} />
        </FloatingMotion>
      </Suspense>
    </StrictMode>,
  );
} else {
  // The app renders the moment its chunk has loaded. Behind lazy() and <Suspense>, React 19 would hold it until 300 ms
  // after the fallback committed (its Suspense throttle), and the chunk is usually ready well before that.
  const render = (Workspace?: ComponentType) =>
    root.render(
      <StrictMode>
        {Workspace ? <Workspace /> : null}
        <BootSplash />
      </StrictMode>,
    );
  render();
  void afterFirstFrame()
    .then(() => import("./Workspace"))
    .then((module) => render(module.default));
}
